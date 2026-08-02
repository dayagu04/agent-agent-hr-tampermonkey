// 投递引擎 — 编排「扫描 → 规则过滤 → 匹配 → 配额检查 → 投递 → 上报」全流程
//
// 设计：决策复用后端主项目模块（规则/匹配/配额/招呼语/决策日志），
// 插件只做浏览器执行 + 如实上报，不在前端另造一套算法。
import type { ApplyResult, BasePlatform } from './platforms/base'
import type { ApplyOutcome, ApplyRule, JobCard, PluginConfig, ApplyProgress } from './types'
import {
  fetchGreeting,
  fetchQuota,
  fetchRules,
  logDecision,
  matchJobs,
  recordApplication,
} from './api'
import { hhmmss } from './logger'

export class ApplyEngine {
  private aborted = false
  private rules: ApplyRule[] = []
  /** 实际生效的投递上限：min(用户配置, 平台剩余额度) */
  private effectiveMaxApply = Number.MAX_SAFE_INTEGER
  /** 本次运行 id，贯穿决策日志（与后端 AgentTask.run_id 同角色） */
  private readonly runId = `plugin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  constructor(
    private platform: BasePlatform,
    private config: PluginConfig,
    private onProgress: (p: ApplyProgress) => void,
  ) {}

  /** 中断标记；长睡眠期间也会被 waitAbortable 感知，不必等睡完 */
  abort() {
    this.aborted = true
  }

  /**
   * 可中断的等待。返回 false 表示等待期间被 abort。
   *
   * BOSS 保号间隔 200s 起，用整段 setTimeout 的话「停止」按下后
   * 仍会睡满再投一个出去（实测停编排 2 分钟后又多投一个）。
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

    // 风控降级检查：低于 60s 且未勾选确认时强制回落到 180s（仅判一次，避免循环日志刷屏）
    const testMode = /[?&]testmode=1/.test(location.href)
    if (
      this.platform.code === 'zhipin' &&
      !testMode &&
      this.config.minIntervalSeconds < 60 &&
      !this.config.acknowledgeRiskyInterval
    ) {
      log(`⚠ 间隔地板 ${this.config.minIntervalSeconds}s < 60s 但未确认风险，本次强制回落到 180s`)
    }

    // 配额预检：与 Web Agent 共用限流器，受平台上限/风控冷却保护
    const quota = await fetchQuota(this.config, this.platform.code)
    if (quota) {
      log(
        `平台配额：本小时 ${quota.applied_last_hour}/${quota.max_per_hour}，` +
          `今日 ${quota.applied_last_day}/${quota.max_per_day}`,
      )
      if (!quota.can_apply) {
        log(`当前不可投递：${quota.reason}`)
        log('这是保号保护（与网页端 Agent 共用配额），请稍后再试')
        progress.running = false
        this.onProgress({ ...progress })
        return progress
      }
      // 平台硬上限收紧本次投递数，避免超投触发风控
      const remaining = Math.max(0, quota.max_per_hour - quota.applied_last_hour)
      if (remaining > 0 && remaining < this.config.maxApply) {
        log(`本小时剩余额度 ${remaining}，本次投递上限收紧为 ${remaining}`)
        this.effectiveMaxApply = remaining
      }
    }

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
      log(`扫描到 ${jobs.length} 个岗位`)
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

      // 2. 批量匹配（分批提交，避免大批量走 LLM 精排超时）
      log(`提交后端计算匹配度（${jobs.length} 个，分批处理，可能需 1-2 分钟）...`)
      const results = await matchJobs(this.config, this.platform.code, jobs, (done, total) => {
        log(`匹配进度 ${done}/${total}`)
      })
      const scoreMap = new Map(results.map((r) => [r.platform_job_id, r]))
      log(`后端返回 ${results.length} 条评分`)
      if (results.length) {
        const scores = results.map((r) => r.score)
        const top = Math.max(...scores).toFixed(1)
        const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
        log(`评分：最高 ${top}，平均 ${avg}（阈值 ${this.config.threshold}）`)
      }

      // 3. 筛选推荐岗位（规则过滤 + 匹配阈值），跳过原因上报后端决策日志
      const recommended: Array<{ job: JobCard; score: number }> = []
      let ruleBlocked = 0
      for (const job of jobs) {
        const r = scoreMap.get(job.platformJobId)

        // 3a. 规则过滤优先于分数（用户明确设的底线不该被高分绕过）
        const hitRule = this.matchBlockRule(job)
        if (hitRule) {
          ruleBlocked++
          progress.skipped++
          this.platform['markCard']?.(job, '#ef4444') // 红色=命中规则
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

        if (r && r.recommend) {
          recommended.push({ job, score: r.score })
          this.platform['markCard']?.(job, '#22c55e') // 绿色=推荐
        } else {
          progress.skipped++
          this.platform['markCard']?.(job, '#d1d5db') // 灰色=跳过
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
        `匹配通过 ${recommended.length} 个（阈值 ${this.config.threshold} 分），` +
          `低分跳过 ${progress.skipped - ruleBlocked} 个` +
          (ruleBlocked ? `，命中规则拒投 ${ruleBlocked} 个` : ''),
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

        log(`投递: ${job.title} @ ${job.company} (${score}分)`)
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

        // 投递完成，清除当前岗位
        progress.currentJob = null
        this.onProgress({ ...progress })

        // 计数与视觉标记按真实结果区分
        if (outcome === 'applied') {
          progress.applied++
          this.platform['markCard']?.(job, '#3b82f6') // 蓝色=已投
          log(`  ↳ 成功${message ? '：' + message : ''}`)
        } else if (outcome === 'unknown') {
          progress.applied++ // 计入尝试，但库里不记 real_applied
          this.platform['markCard']?.(job, '#a855f7') // 紫色=待核对
          log(`  ↳ 未能确认${message ? '：' + message : ''}（请在平台核对）`)
        } else {
          progress.failed++
          this.platform['markCard']?.(job, '#f59e0b') // 橙色=失败
          log(`  ↳ 失败${message ? '：' + message : ''}`)
        }

        // 上报记账：outcome 如实传，unknown/failed 不会写成 real_applied
        try {
          const rec = await recordApplication(
            this.config, this.platform.code, job, score, outcome, message, greetingSent,
          )
          if (rec.duplicate) log(`  ↳ 该岗位之前已投递过`)
        } catch (e) {
          log(`  ↳ 记账失败: ${(e as Error).message}`)
        }
        this.onProgress({ ...progress })

        // 拟人延迟。BOSS 最小间隔默认 180s（保号红线），可通过 config.minIntervalSeconds 配置。
        // 低于 60s 时设置页显示风控警告，且必须勾选 acknowledgeRiskyInterval 才生效，否则回落到 180。
        // 测试模式：URL 带 testmode=1 时缩短到 10s，方便快速验证。
        let waitMs = this.config.delayMin + Math.random() * (this.config.delayMax - this.config.delayMin)
        if (this.platform.code === 'zhipin' && progress.applied < this.effectiveMaxApply) {
          const testMode = /[?&]testmode=1/.test(location.href)
          let floor = testMode ? 10_000 : (this.config.minIntervalSeconds * 1000)
          // 风控降级：低于 60s 且未勾选确认时强制回落到 180s（testMode 豁免，保留快速验证通道）
          if (!testMode && floor < 60_000 && !this.config.acknowledgeRiskyInterval) {
            floor = 180_000
          }
          if (waitMs < floor) {
            waitMs = floor + Math.random() * (testMode ? 5_000 : 30_000)
            log(`  ↳ BOSS ${testMode ? '测试' : '保号'}间隔：等待 ${Math.round(waitMs / 1000)}s 后投下一个`)
          }
        }
        // 可中断睡眠：整段 setTimeout 会让「停止」按下后仍等满 200s 再投一个
        // （实测 16:48 停编排，engine 睡到 16:50 又投了一个出去）
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
