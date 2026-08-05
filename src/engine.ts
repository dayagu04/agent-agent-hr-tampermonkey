// 投递引擎 —— 编排「扫描 → 规则过滤 → 匹配 → 投递 → 上报」全流程
//
// 设计：决策复用后端主项目模块（规则/匹配/招呼语/决策日志），
// 插件只做浏览器执行 + 如实上报，不在前端另造一套算法。
import type { ApplyResult, BasePlatform } from './platforms/base'
import type { ApplyOutcome, ApplyRule, JobCard, PluginConfig, ApplyProgress } from './types'
import {
  fetchGreeting,
  fetchRules,
  judgeJobs,
  logDecision,
  matchJobs,
  recordApplication,
} from './api'
import { cacheScannedJobs } from './ledger'
import { hhmmss } from './logger'

export class ApplyEngine {
  private aborted = false
  private rules: ApplyRule[] = []
  /** 实际生效的投递上限（= 用户配置） */
  private effectiveMaxApply = Number.MAX_SAFE_INTEGER
  /** 本次运行 id，贯穿决策日志（与后端 AgentTask.run_id 同角色） */
  private readonly runId = `plugin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  /** 本次运行实际尝试投递的岗位 id（编排器跨页续跑去重用） */
  readonly attemptedIds: string[] = []

  constructor(
    private platform: BasePlatform,
    private config: PluginConfig,
    private onProgress: (p: ApplyProgress) => void,
    /** 本次运行要跳过的岗位 id（已尝试过，防同页续跑重复投） */
    private readonly skipJobIds?: Set<string>,
    /** 本轮编排 run_id（后端用于标识本轮投递岗位，只回复本轮消息用） */
    private readonly orchestratorRunId = '',
  ) {}

  /** 中断标记；长睡眠期间也会被 waitAbortable 感知，不必等睡完 */
  abort() {
    this.aborted = true
  }

  /**
   * 可中断的等待。返回 false 表示等待期间被 abort。
   * 长睡眠（BOSS 保号间隔可达 200s）期间也要能感知「停止」，
   * 拆成 500ms 粒度轮询中断标记。
   */
  private async waitAbortable(ms: number): Promise<boolean> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (this.aborted) return false
      await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now())))
    }
    return !this.aborted
  }

  /** 规则过滤：命中屏蔽公司/关键词/最低薪资则不投（与后端 _match_block_rule 同语义） */
  private matchBlockRule(job: JobCard): ApplyRule | null {
    const company = (job.company || '').toLowerCase()
    const title = (job.title || '').toLowerCase()
    const desc = (job.description || '').toLowerCase()

    for (const rule of this.rules) {
      const v = (rule.value || '').trim().toLowerCase()
      if (!v) continue
      if (rule.rule_type === 'block_company' && company.includes(v)) return rule
      if (rule.rule_type === 'block_keyword' && (title.includes(v) || desc.includes(v))) return rule
      if (rule.rule_type === 'min_salary') {
        // 从薪资文本解析上限（"15-25K" → 25），低于底线则拒投；
        // 解析不出（面议）视为未知，不据此拒投，避免误杀
        const m = (job.salary || '').match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)/)
        if (m) {
          let hi = parseFloat(m[2])
          if (/万/.test(job.salary || '')) hi *= 10 // 1.5-2万 → 20K
          const threshold = parseFloat(v)
          if (!Number.isNaN(threshold) && hi > 0 && hi < threshold) return rule
        }
      }
    }
    return null
  }

  async run(): Promise<ApplyProgress> {
    const progress: ApplyProgress = {
      scanned: 0,
      scanComplete: false,
      matched: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      running: true,
      logs: [],
    }

    const log = (msg: string) => {
      progress.logs.unshift(`[${hhmmss()}] ${msg}`)
      if (progress.logs.length > 50) progress.logs.pop()
      this.onProgress({ ...progress })
    }

    this.effectiveMaxApply = this.config.maxApply

    // 加载后端投递规则（黑白名单/最低薪资），与 Web Agent 同源
    this.rules = await fetchRules(this.config)
    if (this.rules.length) log(`已加载 ${this.rules.length} 条投递规则`)

    // 不做服务器端配额预检：插件在用户浏览器里直接投递，独立于网页端
    // Agent 的配额/限流体系，投递节奏只由用户配置控制。

    // 自动翻页：逐页处理直到达上限/无下一页/达页数上限
    const maxPages = this.config.autoPaginate ? Math.max(1, this.config.maxPages) : 1
    for (let page = 1; page <= maxPages; page++) {
      if (this.aborted) break
      if (progress.applied >= this.config.maxApply) {
        log(`已达投递上限 ${this.config.maxApply}，结束`)
        break
      }
      if (page > 1) log(`—— 第 ${page} 页 ——`)

      await this.runOnePage(progress, log)

      if (this.aborted) break
      if (progress.applied >= this.config.maxApply) break

      if (page < maxPages) {
        log('尝试翻到下一页...')
        const ok = await this.platform.nextPage()
        if (!ok) {
          log('没有下一页了，结束')
          break
        }
      }
    }

    log(`全部完成！共投递 ${progress.applied}，跳过 ${progress.skipped}，失败 ${progress.failed}`)
    progress.running = false
    this.onProgress({ ...progress })
    return progress
  }

  /** 处理当前页：扫描 → 匹配 → 投递 */
  private async runOnePage(
    progress: ApplyProgress,
    log: (msg: string) => void,
  ): Promise<void> {
    try {
      // 1. 扫描岗位
      log(`开始扫描 ${this.platform.name} 岗位...`)
      const jobs = await this.platform.scanJobs()
      progress.scanned = jobs.length
      progress.scanComplete = true
      log(`扫描到 ${jobs.length} 个岗位`)
      // 缓存本次扫描（聊天页按 boss.encryptJobId 反查标题/薪资，见 ledger.ts）
      await cacheScannedJobs(jobs)
      this.onProgress({ ...progress })

      if (jobs.length === 0) {
        // 区分「不在列表页」与「在列表页但选择器失效」，避免用户误判
        const onSearchPage = /sou\.zhaopin\.com|we\.51job\.com\/pc\/search|search\.51job\.com/.test(
          location.href,
        )
        if (!onSearchPage) {
          log('当前不是搜索结果页。插件只处理当前页面已有的岗位，')
          log('请先在站内搜索岗位（如点顶部「职位」搜索），到列表页再点开始。')
        } else {
          log('在列表页但未扫描到岗位 → 页面选择器可能已改版，请把控制台 [AAH] 日志发给开发者')
        }
        return
      }

      // 2. 批量匹配（分批提交，避免大批量走 LLM 精排超时）。
      //    设置里可关闭匹配度：跳过 match 接口，规则过滤通过后全部投递
      const results = this.config.matchEnabled
        ? await matchJobs(this.config, this.platform.code, jobs, (done, total) => {
            log(`匹配进度 ${done}/${total}`)
          })
        : []
      const scoreMap = new Map(results.map((r) => [r.platform_job_id, r]))
      if (this.config.matchEnabled) {
        log(`后端返回 ${results.length} 条评分`)
        if (results.length) {
          const scores = results.map((r) => r.score)
          const top = Math.max(...scores).toFixed(1)
          const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
          log(`评分：最高 ${top}，平均 ${avg}（阈值 ${this.config.threshold}）`)
        }
      } else {
        log('已关闭匹配度计算：跳过后端匹配，规则过滤通过后全部投递')
      }

      // LLM 低质量岗位判定：外包/批量招聘等（公司维度缓存，命中不重复判）
      const blockedReasonMap = new Map(
        results.filter((r) => r.blocked_reason).map((r) => [r.platform_job_id, r.blocked_reason as string]),
      )
      const lowQualityMap = new Map<string, string>()
      if (this.config.qualityJudge) {
        const verdicts = await judgeJobs(this.config, jobs)
        for (const v of verdicts) {
          if (v.verdict === 'low_quality') lowQualityMap.set(v.company, v.reason || '')
        }
        if (lowQualityMap.size) {
          log(`低质量公司拦截 ${lowQualityMap.size} 家：${Array.from(lowQualityMap.keys()).join('、')}`)
        }
      }

      // 3. 筛选推荐岗位（规则过滤 + 匹配阈值），跳过原因上报后端决策日志
      const recommended: Array<{ job: JobCard; score: number }> = []
      let ruleBlocked = 0
      for (const job of jobs) {
        const r = scoreMap.get(job.platformJobId)

        // 已尝试过的岗位直接跳过（编排器同一页续跑时防止重复投递）
        if (this.skipJobIds?.has(job.platformJobId)) {
          progress.skipped++
          continue
        }

        // 规则过滤优先于分数（用户明确设的底线不该被高分绕过）
        const hitRule = this.matchBlockRule(job)
        if (hitRule) {
          ruleBlocked++
          progress.skipped++
          this.platform.markCard(job, '#ef4444') // 红色=命中规则
          void logDecision(this.config, {
            run_id: this.runId,
            platform: this.platform.code,
            platform_job_id: job.platformJobId,
            decision: 'rejected_by_rule',
            reason: `命中规则 ${hitRule.rule_type}=${hitRule.value}`,
            match_score: r?.score,
            details: { title: job.title, company: job.company, rule_id: hitRule.id },
          })
          continue
        }

        // 公司级拦截（后端 match 结果标记）：黑名单 / 冷静期 / 频率上限 / 已投
        const blockedReason = blockedReasonMap.get(job.platformJobId)
        if (blockedReason) {
          progress.skipped++
          this.platform.markCard(job, '#d1d5db')
          const reasonText: Record<string, string> = {
            company_blacklisted: '公司已被拉黑',
            company_cooldown: '该公司处于冷静期',
            company_apply_limit: '该公司近期投递已达上限',
            already_applied: '该岗位已投递过',
          }
          void logDecision(this.config, {
            run_id: this.runId,
            platform: this.platform.code,
            platform_job_id: job.platformJobId,
            decision: 'blocked_' + blockedReason,
            reason: reasonText[blockedReason] || blockedReason,
            match_score: r?.score,
            details: { title: job.title, company: job.company },
          })
          continue
        }

        // LLM 判定低质量公司（外包/批量招聘话术等）
        const lqReason = lowQualityMap.get(job.company)
        if (lqReason !== undefined) {
          progress.skipped++
          this.platform.markCard(job, '#ef4444')
          void logDecision(this.config, {
            run_id: this.runId,
            platform: this.platform.code,
            platform_job_id: job.platformJobId,
            decision: 'rejected_low_quality_company',
            reason: `LLM 判定低质量：${lqReason || '外包/批量招聘'}`,
            match_score: r?.score,
            details: { title: job.title, company: job.company },
          })
          continue
        }

        if (!this.config.matchEnabled) {
          // 关闭匹配：不过滤分数，规则通过即投（score 记 0，账本里可区分）
          recommended.push({ job, score: 0 })
          this.platform.markCard(job, '#22c55e') // 绿色=全部投递
        } else if (r && r.recommend) {
          recommended.push({ job, score: r.score })
          this.platform.markCard(job, '#22c55e') // 绿色=推荐
        } else {
          progress.skipped++
          this.platform.markCard(job, '#d1d5db') // 灰色=跳过
          void logDecision(this.config, {
            run_id: this.runId,
            platform: this.platform.code,
            platform_job_id: job.platformJobId,
            decision: 'rejected_low_score',
            reason: r
              ? `匹配分 ${r.score.toFixed(1)} 低于阈值 ${this.config.threshold}：${r.reason || ''}`
              : '未获得匹配分（低于后端初筛阈值）',
            match_score: r?.score,
            details: { title: job.title, company: job.company },
          })
        }
      }
      progress.matched = recommended.length
      log(
        this.config.matchEnabled
          ? `匹配通过 ${recommended.length} 个（阈值 ${this.config.threshold} 分），` +
            `低分跳过 ${progress.skipped - ruleBlocked} 个` +
            (ruleBlocked ? `，命中规则拒投 ${ruleBlocked} 个` : '')
          : `规则过滤通过 ${recommended.length} 个（匹配度已关闭），命中规则拒投 ${ruleBlocked} 个`,
      )
      this.onProgress({ ...progress })

      // 4. 逐个投递（拟人间隔 + 数量上限 + 如实记账）
      for (const { job, score } of recommended) {
        if (this.aborted) {
          log('已手动停止')
          break
        }
        if (progress.applied >= this.effectiveMaxApply) {
          log(`已达投递上限 ${this.effectiveMaxApply}，停止`)
          break
        }

        // 投递前更新当前岗位（实时显示用）
        progress.currentJob = { title: job.title, company: job.company, score }
        this.onProgress({ ...progress })

        log(
          `投递: ${job.title} @ ${job.company}` +
            (this.config.matchEnabled ? ` (${score}分)` : '（匹配度已关闭）'),
        )
        let outcome: ApplyOutcome = 'failed'
        let message = ''
        let greetingSent = false

        try {
          // 注入招呼语获取器：BOSS 建立会话需发首条消息，复用后端主项目话术
          const raw = await this.platform.applyJob(job, {
            getGreeting: () => fetchGreeting(this.config, this.platform.code, job),
          })
          // 兼容旧签名（boolean）与新签名（ApplyResult）
          if (typeof raw === 'boolean') {
            outcome = raw ? 'applied' : 'failed'
          } else {
            const res = raw as ApplyResult
            outcome = res.outcome
            message = res.message || ''
            greetingSent = !!res.greetingSent
          }
        } catch (e) {
          outcome = 'failed'
          message = (e as Error).message
        }

        // 无论成败都记入「已尝试」，同页续跑不再重复点它
        this.attemptedIds.push(job.platformJobId)

        // 投递完成，清除当前岗位
        progress.currentJob = null
        this.onProgress({ ...progress })

        // 计数与视觉标记按真实结果区分
        if (outcome === 'applied') {
          progress.applied++
          this.platform.markCard(job, '#3b82f6') // 蓝色=已投
          log(`  ↳ 成功${message ? '：' + message : ''}`)
        } else if (outcome === 'unknown') {
          progress.applied++ // 计入尝试，但库里不记 real_applied
          this.platform.markCard(job, '#a855f7') // 紫色=待核对
          log(`  ↳ 未能确认${message ? '：' + message : ''}（请在平台核对）`)
        } else {
          progress.failed++
          this.platform.markCard(job, '#f59e0b') // 橙色=失败
          log(`  ↳ 失败${message ? '：' + message : ''}`)
        }

        // 上报记账：outcome 如实传，unknown/failed 不会写成 real_applied
        try {
          const rec = await recordApplication(
            this.config, this.platform.code, job, score, outcome, message, greetingSent,
            this.orchestratorRunId,
          )
          if (rec.duplicate) log(`  ↳ 该岗位之前已投递过`)
        } catch (e) {
          log(`  ↳ 记账失败: ${(e as Error).message}`)
        }
        this.onProgress({ ...progress })

        // 投递间隔：用户设置的单值（秒），内置 ±10% 随机抖动模拟真人节奏，
        // 是「投完一个岗位 → 投下一个」之间唯一的等待来源。
        const testMode = /[?&]testmode=1/.test(location.href)
        let waitMs = this.config.applyIntervalSeconds * 1000 * (0.9 + Math.random() * 0.2)
        if (this.platform.code === 'zhipin' && progress.applied < this.effectiveMaxApply) {
          if (testMode && waitMs > 10_000) waitMs = 10_000
          log(`  ↳ 投递间隔：等待 ${Math.round(waitMs / 1000)}s 后投下一个`)
        }
        if (!(await this.waitAbortable(waitMs))) {
          log('已手动停止')
          break
        }
      }

      log(`本页完成：累计投递 ${progress.applied}，跳过 ${progress.skipped}，失败 ${progress.failed}`)
    } catch (e) {
      // 单页出错不终止整个任务（下一页可能正常），只记日志
      log(`本页出错: ${(e as Error).message}`)
    }
    this.onProgress({ ...progress })
  }
}
