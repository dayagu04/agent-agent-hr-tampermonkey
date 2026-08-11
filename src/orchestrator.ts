// 全链路执行器 —— 只做「执行 + 上报」，决策全部由后端 LangGraph 完成
//
// 职责：
//  - 接收后端指令（apply_batch / chat_snapshot / chat_reply / stop / pause）并执行；
//  - 执行前把 pendingAction 落盘，页面跳转/刷新后由 resume() 接管续跑；
//  - 上报事件（started / apply_batch_done / chat_snapshot_done / chat_round_done /
//    stopped / paused / resumed），后端据此推进编排图并下发下一步指令；
//  - 维护执行上下文（runId / plan / stats）供心跳与面板展示。
//
// 不再包含任何本地决策：目标判定、投递↔会话节奏、收尾排水、翻页/换词策略
// 全部由后端 server/orchestration 决定，插件只按指令执行并如实上报结果。

import type { ApplyProgress, PluginConfig } from './types'
import { storage, notification } from './platform-bridge'
import { diag } from './logger'
import { saveConfig } from './config'
import { ApplyEngine } from './engine'
import { detectPlatform } from './platforms/factory'
import { onChatPage, requestStopChatRound, runChatRound } from './platforms/boss-chat'
import { reportOrchestratorEvent } from './api'

/** 执行器状态（持久化到 GM 存储） */
export interface OrchestratorState {
  /** 当前执行阶段（供 UI 展示；不再参与决策） */
  phase: 'idle' | 'search' | 'apply' | 'chat' | 'paused' | 'stopped'
  /** 启动时间戳 */
  startedAt: number
  /** 本轮唯一标识（跨标签页租约/后端 run 关联用） */
  runId: string
  /** 本轮统计（镜像后端；事件上报与 UI 展示用） */
  stats: {
    appliedTotal: number
    hrRepliesTotal: number
    sendResumeTotal: number
    chatRoundsTotal: number
    searchRoundsTotal: number
    applyBatchCount: number
    emptyBatches: number
    appliedSinceChat: number
    skippedTotal: number
    failedTotal: number
    pendingHrMessages: number
    cleanedTotal: number
  }
  /** 终止条件镜像（后端判定，插件仅展示） */
  goal: {
    type: 'apply_count' | 'hr_reply_count' | 'time_elapsed'
    target: number
  }
  /** 搜索关键词池（镜像后端 plan） */
  keywords: string[]
  currentKeywordIndex: number
  /** BOSS 城市编码（跨页保持不变） */
  cityCode: string
  /** 后端指令里的页码（唯一真相源在后端，插件导航用） */
  currentPage: number
  /** 异常记录 */
  errors: Array<{ time: number; phase: string; message: string }>
  /** 本次运行已尝试投递的岗位 id（跨页续跑去重，最多保留 1000） */
  attemptedJobIds: string[]
  /** 本轮搜索复用的筛选参数（不含 query/page），从启动页 URL 或用户保存值捕获 */
  filterQuery: string
  /** 投递计划镜像（后端 per_combination / total_llm 生成） */
  plan: Array<{
    keyword: string
    city: string
    cityCode: string
    quota: number
    applied: number
  }>
  /** 当前执行的计划下标（镜像） */
  planIndex: number
  /** 额度模式（镜像） */
  quotaMode: 'per_combination' | 'total_llm' | 'legacy'
  /** 只处理会话不投递（网页端「只处理会话」模式） */
  chatOnly: boolean
  /** 尚未执行完的后端指令（页面跳转后由 resume() 续跑） */
  pendingAction: { action: string; payload: Record<string, unknown> } | null
}

const STATE_KEY = 'aah_orchestrator_state'
/** 跨标签页编排租约：同一轮只允许一个标签页实例实际执行（防双跑/互踩） */
const ORCH_LEASE_KEY = 'aah_orch_lease'
const ORCH_LEASE_TTL = 10000
/** 每个标签页实例的唯一 ID（页面加载时生成，仅用于租约判定） */
const _tabId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

interface OrcLease {
  runId: string
  tabId: string
  ts: number
}

function _genRunId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

/** BOSS 聊天页地址（会话阶段跳转用，单一来源避免各处硬编码漂移） */
const CHAT_URL = 'https://www.zhipin.com/web/geek/chat'

/**
 * 职位列表页判定 —— 唯一定义。
 * 页面判定必须单一来源，禁止各处各写一套，否则会互相打架造成死循环。
 */
export function onJobListPage(): boolean {
  return /\/web\/geek\/jobs?\b/.test(window.location.pathname)
}

/** 职位列表页且带搜索条件（query 参数），说明是搜索结果而非空白推荐页 */
function onSearchResultPage(): boolean {
  return onJobListPage() && new URLSearchParams(window.location.search).has('query')
}

/** 捕获当前页已生效的搜索筛选参数（排除 query/page），供翻页/换词时复用 */
function captureSearchFilterQuery(): string {
  const p = new URLSearchParams(window.location.search)
  p.delete('query')
  p.delete('page')
  return p.toString()
}

/** 构造搜索结果页 URL。cityCode 为空则不传（走账号默认期望城市） */
function buildSearchUrl(keyword: string, cityCode: string, page: number, filterQuery = ''): string {
  const p = new URLSearchParams()
  if (filterQuery) {
    const f = new URLSearchParams(filterQuery)
    for (const [k, v] of f.entries()) {
      if (k !== 'query' && k !== 'page') p.set(k, v)
    }
  }
  p.set('query', keyword)
  if (cityCode) p.set('city', cityCode)
  if (page > 1) p.set('page', String(page))
  return `https://www.zhipin.com/web/geek/jobs?${p.toString()}`
}

/** 当前页面是否就是目标搜索结果页（关键词/页码/城市都对得上） */
function onTargetSearchPage(keyword: string, cityCode: string, page: number): boolean {
  if (!onSearchResultPage()) return false
  const sp = new URLSearchParams(window.location.search)
  if (sp.get('query') !== keyword) return false
  if (Number(sp.get('page') || 1) !== page) return false
  if (cityCode && sp.get('city') && sp.get('city') !== cityCode) return false
  return true
}

/** 默认统计（与后端 server/orchestration/state.py 保持一致） */
function defaultStats(): OrchestratorState['stats'] {
  return {
    appliedTotal: 0,
    hrRepliesTotal: 0,
    sendResumeTotal: 0,
    chatRoundsTotal: 0,
    searchRoundsTotal: 0,
    applyBatchCount: 0,
    emptyBatches: 0,
    appliedSinceChat: 0,
    skippedTotal: 0,
    failedTotal: 0,
    pendingHrMessages: 0,
    cleanedTotal: 0,
  }
}

export class Orchestrator {
  private config: PluginConfig
  private state: OrchestratorState | null = null
  private running = false
  /** 当前是否有阶段任务在执行中，防止指令重入 */
  private busy = false
  /**
   * 当前批次的投递引擎。
   *
   * 必须持引用：engine.run() 内部有长睡眠，stop() 拿不到实例就无法 abort，
   * 用户点了「停止编排」后 engine 睡醒仍会继续投。
   */
  private engine: ApplyEngine | null = null

  /** 投递进度回调，由面板注入 */
  private onApplyProgress: ((p: ApplyProgress) => void) | null = null
  /** 当前正在投递的岗位（实时展示用，不持久化） */
  private currentJob: ApplyProgress['currentJob'] = null

  constructor(config: PluginConfig) {
    this.config = config
  }

  /** 注入投递进度回调（面板挂载时调用一次） */
  setApplyProgressHandler(fn: (p: ApplyProgress) => void): void {
    this.onApplyProgress = fn
  }

  /** 当前状态（面板读取统计/阶段用） */
  getState(): OrchestratorState | null {
    return this.state
  }

  /** 当前正在投递的岗位（实时展示用） */
  getCurrentJob(): ApplyProgress['currentJob'] {
    return this.currentJob
  }

  /** 是否在运行 */
  isRunning(): boolean {
    return this.running
  }

  // ===== 跨标签页租约（同一轮只允许一个实例执行） =====

  private async _readLease(): Promise<OrcLease | null> {
    return await storage.get<OrcLease | null>(ORCH_LEASE_KEY, null)
  }

  private async _writeLease(runId: string): Promise<void> {
    await storage.set(ORCH_LEASE_KEY, { runId, tabId: _tabId, ts: Date.now() } as OrcLease)
  }

  private async _clearLease(): Promise<void> {
    await storage.remove(ORCH_LEASE_KEY)
  }

  /** 当前页面是否为本轮的执行目标页（导航续跑时据此立即接管，不等租约过期） */
  private _isRunTargetPage(state: OrchestratorState): boolean {
    if (state.phase === 'chat') return onChatPage()
    if (state.pendingAction) {
      const p = state.pendingAction.payload || {}
      const keyword = typeof p.keyword === 'string' ? p.keyword : state.keywords[state.currentKeywordIndex] || ''
      const page = typeof p.page === 'number' && p.page > 0 ? p.page : state.currentPage || 1
      const cityCode = typeof p.city_code === 'string' ? p.city_code : state.cityCode || ''
      return onTargetSearchPage(keyword, cityCode, page)
    }
    if (state.phase === 'search' || state.phase === 'apply') {
      const keyword = state.keywords[state.currentKeywordIndex] || ''
      return onTargetSearchPage(keyword, state.cityCode || '', state.currentPage || 1)
    }
    return false
  }

  /** 跨标签页同步：其他标签页停止/暂停/新开一轮时，本页放弃旧轮，避免双跑/互踩 */
  private async _syncCrossTabState(): Promise<'continue' | 'abandon'> {
    const persisted = await storage.get<OrchestratorState | null>(STATE_KEY, null)
    if (!persisted || !this.state) return 'continue'

    if ((persisted.phase === 'stopped' || persisted.phase === 'paused') && this.running) {
      diag('ORCH', `检测到其他标签页已将编排置为 ${persisted.phase}，本页同步停止`)
      this.running = false
      this.state = persisted
      this.engine?.abort()
      this.engine = null
      requestStopChatRound()
      await this._clearLease()
      return 'abandon'
    }

    if (this.state.runId && persisted.runId && persisted.runId !== this.state.runId) {
      diag('ORCH', '检测到新的一轮编排已由其他标签页启动，本页放弃旧轮')
      this.running = false
      this.state = persisted
      this.engine?.abort()
      this.engine = null
      requestStopChatRound()
      await this._clearLease()
      return 'abandon'
    }
    return 'continue'
  }

  /** 启动执行器（网页端或面板点击「开始投递」时调用）。只初始化上下文并上报 started，
   *  后续动作全部等后端 LangGraph 下发指令。 */
  async start(
    goal: OrchestratorState['goal'],
    keywords: string[],
    cityCodeOverride?: string,
    plan?: Array<{ keyword: string; city: string; cityCode: string; quota: number }>,
    quotaMode: OrchestratorState['quotaMode'] = 'legacy',
    chatOnly = false,
    opts: {
      chatInterval?: number
      applyIntervalSeconds?: number
      maxReplies?: number
      maxPagesPerKeyword?: number
      minReplyScore?: number
      replyScope?: 'this_round' | 'all'
    } = {},
  ): Promise<void> {
    if (this.running) {
      diag('ORCH', '编排器已在运行，跳过重复启动')
      return
    }

    // 组合额度计划：网页端生成 plan（per_combination / total_llm）；
    // 无 plan（旧调用）按 keywords×城市 各投 goal.target 兜底。
    const normalizedPlan = (plan && plan.length)
      ? plan.map((e) => ({ ...e, applied: 0 }))
      : keywords.map((k) => ({
          keyword: k,
          city: '',
          cityCode: cityCodeOverride || '',
          quota: goal.type === 'apply_count' ? goal.target : Number.MAX_SAFE_INTEGER,
          applied: 0,
        }))
    const totalTarget = normalizedPlan.reduce((s, e) => s + e.quota, 0)

    this.state = {
      phase: 'search',
      startedAt: Date.now(),
      runId: _genRunId(),
      stats: defaultStats(),
      goal: plan && plan.length ? { type: 'apply_count', target: totalTarget } : goal,
      keywords: normalizedPlan.map((e) => e.keyword),
      currentKeywordIndex: 0,
      cityCode: normalizedPlan[0]?.cityCode || cityCodeOverride || '',
      currentPage: 1,
      errors: [],
      attemptedJobIds: [],
      filterQuery: '',
      plan: normalizedPlan,
      planIndex: 0,
      quotaMode,
      chatOnly,
      pendingAction: null,
    }
    // 网页端下发的回复策略参数立即落本地配置（不回写网页端，网页端仍是唯一真相源）：
    // 会话托管用 cfg.minReplyScore / cfg.replyScope 调后端，必须与网页端一致。
    if (opts.minReplyScore !== undefined) {
      this.config.minReplyScore = Math.min(100, Math.max(0, Math.round(opts.minReplyScore)))
    }
    if (opts.replyScope) {
      this.config.replyScope = opts.replyScope
    }
    // 投递间隔（秒）：网页端下发的拟人节奏，立即落本地配置供 engine 读取；
    // 网页端仍是唯一真相源，本地不提供设置入口。
    if (opts.applyIntervalSeconds !== undefined) {
      this.config.applyIntervalSeconds = Math.min(120, Math.max(1, Math.round(opts.applyIntervalSeconds)))
    }
    saveConfig(this.config)
    // 启动时优先捕获当前页已生效的筛选；没有则回落到设置里保存的筛选
    this.state.filterQuery = captureSearchFilterQuery() || this.config.searchFilterQuery || ''
    if (this.state.filterQuery) {
      diag('ORCH', `搜索筛选参数: ${this.state.filterQuery}`)
    }
    await storage.set(STATE_KEY, this.state)
    this.running = true
    // 本页作为本轮的执行者，抢占租约（显式启动：最后启动者胜）
    await this._writeLease(this.state.runId)

    diag(
      'ORCH',
      `执行器启动 goal=${this.state.goal.type}:${this.state.goal.target} ` +
        `组合=${normalizedPlan.length} 模式=${quotaMode}`,
    )
    // 后端据 started 事件创建持久化 run 并产出首个指令，由下一次心跳带回。
    // 投递节奏/回复预算/翻页上限等策略参数由网页端下发（opts），插件不再本地配置。
    await this.reportEvent('started', {
      goal: this.state.goal,
      keywords: this.state.keywords,
      plan: normalizedPlan,
      quota_mode: quotaMode,
      reply_scope: opts.replyScope || this.config.replyScope || 'this_round',
      chat_interval: opts.chatInterval || this.config.chatCheckInterval || 5,
      apply_interval_seconds: opts.applyIntervalSeconds ?? this.config.applyIntervalSeconds ?? 8,
      max_replies: opts.maxReplies || this.config.maxRepliesPerRound || 10,
      max_pages_per_keyword: opts.maxPagesPerKeyword || this.config.maxPagesPerKeyword || 20,
      min_reply_score: opts.minReplyScore ?? this.config.minReplyScore ?? 0,
      city_code: this.state.cityCode || '',
      chat_only: chatOnly,
      run_id: this.state.runId,
    })
  }

  /** 停止执行器 */
  async stop(reason: string): Promise<void> {
    if (!this.state) return
    const wasRunning = this.running
    this.running = false
    // 先掐正在跑的投递批次与会话托管，否则它们睡醒后还会继续动作
    this.engine?.abort()
    this.engine = null
    requestStopChatRound()
    this.state.phase = 'stopped'
    this.state.pendingAction = null
    await storage.set(STATE_KEY, this.state)
    await this._clearLease()
    diag('ORCH', `执行器停止: ${reason}`)
    await this.reportEvent('stopped', { reason, stats: this.state.stats })
    if (wasRunning) notification.notify('投递助手已停止', reason)
  }

  /** 暂停（风控/异常时） */
  async pause(reason: string): Promise<void> {
    if (!this.state) return
    this.state.phase = 'paused'
    this.state.errors.push({ time: Date.now(), phase: this.state.phase, message: reason })
    this.running = false
    this.engine?.abort()
    this.engine = null
    requestStopChatRound()
    await storage.set(STATE_KEY, this.state)
    await this._clearLease()
    diag('ORCH', `执行器暂停: ${reason}`)
    await this.reportEvent('paused', { reason })
    notification.notify('投递助手已暂停', reason)
  }

  /**
   * 网页端远程恢复：从暂停态显式恢复并上报 resumed，
   * 后端重新评估后下发下一步指令。
   */
  async resumeFromPause(): Promise<void> {
    if (!this.state || this.state.phase !== 'paused') return
    this.state.phase = 'search'
    this.running = true
    await storage.set(STATE_KEY, this.state)
    if (this.state.runId) await this._writeLease(this.state.runId)
    diag('ORCH', '网页端远程恢复(暂停 → 等待指令)')
    await this.reportEvent('resumed', { reason: '网页端远程恢复' })
  }

  /**
   * 后端 LangGraph 指令（心跳下发 orchestrator.action）：
   * apply_batch / chat_snapshot / chat_reply / stop / pause。
   * 这是执行器的唯一动作入口 —— 插件不做任何决策，只按指令执行。
   */
  async applyBackendAction(action: Record<string, unknown>): Promise<void> {
    if (!this.state || !this.running) return
    if (this.busy) {
      diag('ORCH', '已有指令在执行中，忽略新指令', action)
      return
    }
    // 跨标签页一致性：其他标签页停止/暂停/新开一轮时本页放弃旧轮
    if ((await this._syncCrossTabState()) === 'abandon') return
    if (!this.running) return

    const kind = typeof action?.action === 'string' ? action.action : ''
    try {
      if (kind === 'apply_batch') {
        await this.executeApplyBatch(action)
      } else if (kind === 'chat_snapshot') {
        await this.executeChat(action, 'snapshot')
      } else if (kind === 'chat_reply') {
        await this.executeChat(action, 'full')
      } else if (kind === 'stop') {
        await this.stop(typeof action.reason === 'string' ? action.reason : '后端指令停止')
      } else if (kind === 'pause') {
        await this.pause(typeof action.reason === 'string' ? action.reason : '后端指令暂停（请人工处理后继续）')
      } else {
        diag('ORCH', `未知后端指令: ${kind}`)
      }
    } catch (e) {
      const msg = (e as Error).message
      diag('ORCH', `指令执行失败: ${msg}`)
      if (this.state) {
        this.state.errors.push({ time: Date.now(), phase: this.state.phase, message: msg })
        await storage.set(STATE_KEY, this.state)
      }
      // 执行异常不能静默：上报 paused，让后端置暂停、网页端可见，用户处理后可恢复
      await this.pause(`执行指令失败: ${msg}`)
    }
  }

  /** 执行投递批次：导航到目标搜索结果页 → ApplyEngine 跑一批 → 上报 apply_batch_done */
  private async executeApplyBatch(action: Record<string, unknown>): Promise<void> {
    if (!this.state) return

    const keyword = typeof action.keyword === 'string' && action.keyword
      ? action.keyword
      : this.state.keywords[this.state.currentKeywordIndex] || 'C++'
    // BOSS 搜索列表是滚动加载（?page=N 无效，实测单组合上限 300 张）：
    // 始终停留在第 1 页，每次 apply_batch 由 ApplyEngine.scanJobs 滚动加载全量岗位。
    // 组合是否完成由插件上报 scanned/skipped/count，后端据此切下一个关键词/城市。
    const isZhipin = /zhipin\.com/.test(window.location.hostname)
    const page = isZhipin
      ? 1
      : typeof action.page === 'number' && action.page > 0
        ? action.page
        : this.state.currentPage || 1
    const cityCode = typeof action.city_code === 'string' && action.city_code
      ? action.city_code
      : this.state.cityCode || ''
    const limit = typeof action.limit === 'number' && action.limit > 0
      ? action.limit
      : Math.max(1, Math.round(this.config.chatCheckInterval || 5))

    // 同步执行上下文（后端是页码/关键词的唯一真相源）
    this.state.currentPage = page
    this.state.cityCode = cityCode || this.state.cityCode
    const idx = this.state.keywords.indexOf(keyword)
    if (idx >= 0) this.state.currentKeywordIndex = idx
    this.state.pendingAction = { action: 'apply_batch', payload: { ...action, limit } }
    this.state.phase = 'apply'
    await storage.set(STATE_KEY, this.state)

    // 目标页判定：不在目标搜索结果页就先跳转（跳转后由新页面 resume() 续跑）
    if (!onTargetSearchPage(keyword, cityCode, page)) {
      const wantUrl = buildSearchUrl(keyword, cityCode, page, this.state.filterQuery)
      diag('ORCH', `执行 apply_batch：跳转到 ${wantUrl}`)
      this.state.phase = 'search'
      await storage.set(STATE_KEY, this.state)
      window.location.href = wantUrl
      return
    }

    diag('ORCH', `执行 apply_batch: keyword=${keyword} page=${page} limit=${limit}`)
    this.busy = true
    try {
      if (this.detectRiskControl()) {
        await this.pause('检测到 BOSS 风控页面，请手动处理后重启')
        return
      }

      const platform = detectPlatform()
      if (!platform || platform.code !== 'zhipin') {
        await this.pause('后端下发投递指令但当前不在 BOSS 搜索页，请检查后恢复')
        return
      }

      // ApplyEngine 的 progress.applied/skipped/failed 是「本次 run 的计数」，
      // 每批从 0 开始，以进入本批次前的累计值为基线做累加。
      const baselineApplied = this.state.stats.appliedTotal || 0
      const baselineSkipped = this.state.stats.skippedTotal || 0
      const baselineFailed = this.state.stats.failedTotal || 0
      let scannedThisPage = 0
      let scanCompleteThisPage = false
      const engine = new ApplyEngine(
        platform,
        // autoPaginate 强制关闭：翻页权归后端（next_action.page），
        // 否则两套页码会错位，导致重复扫描与页码统计失真。
        { ...this.config, maxApply: limit, autoPaginate: false },
        (progress) => {
          scannedThisPage = progress.scanned
          scanCompleteThisPage = progress.scanComplete
          this.currentJob = progress.currentJob ?? null
          if (this.state) {
            this.state.stats.appliedTotal = baselineApplied + progress.applied
            this.state.stats.applyBatchCount = progress.applied
            this.state.stats.skippedTotal = baselineSkipped + progress.skipped
            this.state.stats.failedTotal = baselineFailed + progress.failed
          }
          this.onApplyProgress?.(progress)
        },
        new Set(this.state!.attemptedJobIds || []),
        this.state!.runId,
      )
      this.engine = engine

      await engine.run()
      // 合并本次尝试过的岗位 id（上限 1000 防存储膨胀），供同页续跑/翻页去重。
      // stop()/pause() 会 abort 并把 this.engine 置 null，这里必须用局部引用，
      // 否则 abort 返回后会抛 "Cannot read properties of null (reading 'attemptedIds')"
      // （2026-08-06 run mshjhqs7ee23vd3i 现场：执行指令失败 → 整轮暂停）。
      this.state.attemptedJobIds = Array.from(
        new Set([...(this.state.attemptedJobIds || []), ...(engine.attemptedIds || [])]),
      ).slice(-1000)
      this.engine = null

      // stop() 会在 abort 后置 running=false；此处提前返回，
      // 否则会继续上报 apply_batch_done，把已停止的 run 又推进一轮
      if (!this.running) return

      const count = this.state.stats.applyBatchCount || 0
      const skippedThisBatch = (this.state.stats.skippedTotal || 0) - baselineSkipped
      const failedThisBatch = (this.state.stats.failedTotal || 0) - baselineFailed
      diag('ORCH', `投递批次完成: ${count} 个（累计 ${this.state.stats.appliedTotal}）`)
      await this.reportEvent('apply_batch_done', {
        count,
        limit,
        keyword,
        city: action.city || '',
        page,
        skipped: skippedThisBatch,
        failed: failedThisBatch,
        scanned: scannedThisPage,
        scanComplete: scanCompleteThisPage,
        platform: platform.code,
      })
    } finally {
      this.busy = false
    }
  }

  /** 执行会话指令：跳转聊天页 → runChatRound(snapshot/full) → 上报对应事件 */
  private async executeChat(
    action: Record<string, unknown>,
    mode: 'snapshot' | 'full',
  ): Promise<void> {
    if (!this.state) return
    const actionKind = mode === 'snapshot' ? 'chat_snapshot' : 'chat_reply'
    this.state.pendingAction = { action: actionKind, payload: { ...action } }
    this.state.phase = 'chat'
    await storage.set(STATE_KEY, this.state)

    if (!onChatPage()) {
      diag('ORCH', `执行 ${actionKind}：跳转聊天页`)
      window.location.href = CHAT_URL
      return
    }

    this.busy = true
    try {
      if (this.detectRiskControl()) {
        await this.pause('检测到 BOSS 风控页面，请手动处理后重启')
        return
      }

      const log = (m: string) => diag('ORCH', `  ${m}`)
      const max = typeof action.max === 'number' && action.max > 0
        ? action.max
        : this.config.maxRepliesPerRound || 10
      const result = await runChatRound(
        this.config,
        max,
        log,
        {
          mode,
          runId: this.state.runId,
          replyScope: (typeof action.scope === 'string' && (action.scope === 'this_round' || action.scope === 'all'))
            ? action.scope
            : this.config.replyScope || 'this_round',
        },
      )

      this.state.pendingAction = null
      if (!this.running) return

      if (mode === 'snapshot') {
        this.state.stats.pendingHrMessages = result.pending ?? 0
        await this.reportEvent('chat_snapshot_done', { pending: result.pending ?? 0 })
      } else {
        this.state.stats.chatRoundsTotal++
        this.state.stats.hrRepliesTotal += result.replied
        this.state.stats.sendResumeTotal =
          (this.state.stats.sendResumeTotal || 0) + (result.resumes_sent || 0)
        this.state.stats.cleanedTotal =
          (this.state.stats.cleanedTotal || 0) + (result.cleaned || 0)
        // 已处理的会话数（synced）从待回复数中扣减，保证网页端「待回复」跟随真实进度
        this.state.stats.pendingHrMessages = Math.max(
          0,
          (this.state.stats.pendingHrMessages || 0) - (result.synced || 0),
        )
        await this.reportEvent('chat_round_done', {
          handled: result.handled,
          replied: result.replied,
          resumes_sent: result.resumes_sent || 0,
          synced: result.synced || 0,
          cleaned: result.cleaned || 0,
        })
      }
      await storage.set(STATE_KEY, this.state)
      diag(
        'ORCH',
        mode === 'snapshot'
          ? `消息快照完成: 待回复 ${result.pending}`
          : `会话托管完成: ${result.handled} 个会话，${result.replied} 条回复，简历 ${result.resumes_sent || 0} 次`,
      )
    } catch (e) {
      const msg = (e as Error).message
      diag('ORCH', `会话指令失败: ${msg}`)
      if (this.state) this.state.pendingAction = null
      await this.reportEvent('chat_failed', { error: msg })
      notification.notify('会话托管失效', msg)
    } finally {
      this.busy = false
    }
  }

  /**
   * 检测风控页面。
   *
   * 只认两件事：① 可见的安全校验/验证码容器；② URL 明确指向安全校验页。
   * 正文里零散出现的「安全验证/请稍后再试」等关键词不算（避免误判暂停）。
   */
  private detectRiskControl(): boolean {
    const el = document.querySelector(
      '.security-check, .captcha, .geetest_panel, [class*="security-check"]',
    ) as HTMLElement | null
    if (el) {
      // 必须是可见的（有实际尺寸），隐藏的模板节点不算
      const r = el.getBoundingClientRect()
      if (r.width > 4 && r.height > 4) return true
    }
    return /security-check|captcha|verify/.test(
      window.location.pathname + window.location.search,
    )
  }

  /** 上报事件到服务器（后端推进编排图；失败不影响本地执行） */
  private async reportEvent(event: string, details: Record<string, unknown>): Promise<void> {
    try {
      await reportOrchestratorEvent(this.config, {
        event,
        timestamp: Date.now(),
        phase: this.state?.phase || 'unknown',
        stats: this.state?.stats,
        details,
        run_id: this.state?.runId || '',
      })
    } catch {
      // 上报失败不影响主流程
    }
  }

  /**
   * 从持久化状态恢复（页面刷新/跳转后调用）。
   *
   * - paused 必须保持暂停：恢复运行只能由用户显式点击；
   * - 有未完成的后端指令（pendingAction）→ 续跑该指令；
   * - 无未完成指令 → 上报 resumed，让后端重新评估并下发下一步。
   */
  async resume(): Promise<void> {
    const state = await storage.get<OrchestratorState | null>(STATE_KEY, null)
    if (!state) return

    // 残留状态护栏：上次运行距今超过 12h（例如关标签页/崩溃后很久才再次打开），
    // 不自动续跑，避免"没点开始却莫名自动投递"。统计保留供 UI 查看。
    if (Date.now() - (state.startedAt || 0) > 12 * 60 * 60 * 1000) {
      diag('ORCH', `编排状态已过期（启动于 ${new Date(state.startedAt).toLocaleString()}），不自动续跑，置为 stopped`)
      state.phase = 'stopped'
      state.pendingAction = null
      this.state = state
      this.running = false
      await storage.set(STATE_KEY, state)
      return
    }

    if (state.phase === 'idle' || state.phase === 'stopped' || state.phase === 'paused') {
      diag('ORCH', `无需恢复（当前 ${state.phase}）`)
      // 仍写回实例，让 UI 能读到 stats 与暂停原因
      this.state = state
      this.running = false
      return
    }

    // 跨标签页租约：若另一标签页正活着执行同一轮，且本页不是本轮执行目标页，
    // 则只读状态不续跑（避免双跑/互踩）。
    const lease = await this._readLease()
    const sameRun = !!state.runId && !!lease && lease.runId === state.runId
    const leaseFresh = !!lease && Date.now() - lease.ts < ORCH_LEASE_TTL
    if (sameRun && leaseFresh && lease!.tabId !== _tabId && !this._isRunTargetPage(state)) {
      diag('ORCH', `另一标签页(${lease!.tabId})正在运行本轮，本页只读状态不续跑`)
      this.state = state
      this.running = false
      return
    }
    if (state.runId) await this._writeLease(state.runId)

    this.state = state
    this.running = true

    if (state.pendingAction) {
      diag('ORCH', `恢复未完成指令: ${state.pendingAction.action}`)
      // 页面刚加载完 DOM 可能还没渲染稳，延迟执行
      window.setTimeout(() => {
        void this.applyBackendAction(state.pendingAction?.payload || {})
      }, 2000)
    } else {
      diag('ORCH', '恢复执行上下文，通知后端重新决策')
      void this.reportEvent('resumed', { reason: '页面加载恢复' })
    }
  }
}

// ============ 单例导出 ============

let instance: Orchestrator | null = null

export function getOrchestrator(config: PluginConfig): Orchestrator {
  if (!instance) {
    instance = new Orchestrator(config)
  }
  return instance
}

/** 从持久化状态恢复执行器（页面刷新/跳转后调用） */
export function resumeOrchestrator(config: PluginConfig): Promise<void> {
  return getOrchestrator(config).resume()
}

/**
 * 读取持久化的编排状态快照（不依赖单例是否已恢复）。
 *
 * 远程心跳/网页状态上报用：执行器导航跳转后新页面单例恢复前
 * getState() 为 null，直接读 GM 存储里的 state 才能报出真实阶段。
 */
export async function getOrchestratorSnapshot(): Promise<{
  phase: OrchestratorState['phase'] | null
  running: boolean
  appliedTotal: number
  hrRepliesTotal: number
  sendResumeTotal: number
  skippedTotal: number
  failedTotal: number
  goalTarget: number | null
  runId: string
  keyword: string
  page: number
  pendingHrMessages: number
  startedAt: number | null
  lastError: string | null
} | null> {
  const state = await storage.get<OrchestratorState | null>(STATE_KEY, null)
  if (!state) return null
  return {
    phase: state.phase,
    running: !(state.phase === 'idle' || state.phase === 'stopped' || state.phase === 'paused'),
    appliedTotal: state.stats.appliedTotal,
    hrRepliesTotal: state.stats.hrRepliesTotal,
    sendResumeTotal: state.stats.sendResumeTotal || 0,
    skippedTotal: state.stats.skippedTotal || 0,
    failedTotal: state.stats.failedTotal || 0,
    goalTarget: state.goal?.target ?? null,
    runId: state.runId || '',
    keyword: state.keywords[state.currentKeywordIndex] || '',
    page: state.currentPage || 1,
    pendingHrMessages: state.stats.pendingHrMessages || 0,
    startedAt: state.startedAt || null,
    lastError: state.errors.length ? state.errors[state.errors.length - 1].message : null,
  }
}

/** 当前正在投递的岗位（仅实时,不持久化;无则 null） */
export function getCurrentJob(): { title: string; company: string; score: number } | null {
  return instance?.getCurrentJob?.() ?? null
}
