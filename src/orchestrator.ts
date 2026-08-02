// 全链路编排器 —— 投递 + 会话托管的状态机核心
//
// 职责：跨页持久化状态、调度投递与会话、终止条件判断、异常恢复。
// 设计原则：
//   1. 会话优先：每轮先清空待回复会话（HR 回复是稀缺资源，及时回复提高转化）
//   2. 分批投递：投递 N 个 → 查会话 → 再投 N 个（模拟真人习惯，降低风控）
//   3. 异常透明：停止/失败上报服务器，可在网页端查
//   4. 可恢复：页面刷新/跳转后能从断点续跑

import type { ApplyProgress, PluginConfig } from './types'
import { storage, notification } from './platform-bridge'
import { diag } from './logger'
import { ApplyEngine } from './engine'
import { detectPlatform } from './platforms/factory'
import { onChatPage, requestStopChatRound, runChatRound } from './platforms/boss-chat'
import { reportOrchestratorEvent } from './api'

/** 编排器状态（持久化到 GM 存储） */
export interface OrchestratorState {
  /** 当前阶段 */
  phase: 'idle' | 'search' | 'apply' | 'chat' | 'paused' | 'stopped'
  /** 启动时间戳 */
  startedAt: number
  /** 本轮统计 */
  stats: {
    appliedTotal: number      // 累计投递成功数
    hrRepliesTotal: number    // 累计收到 HR 回复数
    chatRoundsTotal: number   // 累计会话托管轮次
    searchRoundsTotal: number // 累计搜索轮次
    applyBatchCount: number   // 当前投递批次内已投数
    emptyBatches: number      // 连续投递 0 个的批次计数（满 3 强制查一次会话）
    appliedSinceChat: number  // 距上次会话检查累计投递数（达到 chatCheckInterval 才去会话页）
  }
  /** 终止条件（从个人中心配置同步） */
  goal: {
    type: 'apply_count' | 'hr_reply_count' | 'time_elapsed'
    target: number  // apply_count/hr_reply_count: N个；time_elapsed: 秒数
  }
  /** 搜索关键词池（轮换使用） */
  keywords: string[]
  currentKeywordIndex: number
  /** BOSS 城市编码，启动时从当前页 URL 继承，跨页保持不变 */
  cityCode: string
  /** 异常记录 */
  errors: Array<{ time: number; phase: string; message: string }>
  /** 上次检查时间（防抖，避免重复触发） */
  lastCheckAt: number
  /** 当前搜索关键词对应的页码 */
  currentPage: number
  /** 本次运行已尝试投递的岗位 id（同页续跑/翻页去重，最多保留 1000） */
  attemptedJobIds: string[]
  /** 已搜索完（无更多结果）的关键词索引，轮换时跳过 */
  exhaustedKeywords: number[]
  /** 会话检查结束后去哪：same_page=回来继续投本页剩余岗位；next_page=本页投完翻页 */
  afterChat: 'same_page' | 'next_page'
  /** 本轮搜索复用的筛选参数（不含 query/page），从启动页 URL 或用户保存值捕获 */
  filterQuery: string
}

const STATE_KEY = 'aah_orchestrator_state'
const CHECK_INTERVAL = 3000  // 每 3 秒检查一次状态
/** BOSS 聊天页地址（会话阶段跳转用，单一来源避免各处硬编码漂移） */
const CHAT_URL = 'https://www.zhipin.com/web/geek/chat'

/**
 * 职位列表页判定 —— 唯一定义，search / apply 两阶段共用。
 * 页面判定必须单一来源，禁止各阶段各写一套，否则会互相打架造成死循环。
 */
export function onJobListPage(): boolean {
  return /\/web\/geek\/jobs?\b/.test(window.location.pathname)
}

/** 职位列表页且带搜索条件（query 参数），说明是搜索结果而非空白推荐页 */
function onSearchResultPage(): boolean {
  return onJobListPage() && new URLSearchParams(window.location.search).has('query')
}

/**
 * 取当前页 URL 上的城市编码。
 *
 * BOSS 的 city 参数是数字编码（合肥=101220100），配置里的 prefCity 是城市名。
 * 硬编码「城市名 → 编码」映射表会随 BOSS 调整失效，故继承用户首次进入搜索页
 * 时 URL 上的编码 —— 那是 BOSS 自己生成的，一定正确；取不到则不传 city。
 */
function inheritCityCode(): string {
  return new URLSearchParams(window.location.search).get('city') || ''
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

export class Orchestrator {
  private config: PluginConfig
  private state: OrchestratorState | null = null
  private checkTimer: number | null = null
  private running = false
  /** apply 阶段连续退回 search 的次数，用于打断死循环 */
  private applyBounceCount = 0
  /** 当前是否有阶段任务在执行中，防止 tick 重入 */
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

  /** 是否在运行 */
  isRunning(): boolean {
    return this.running
  }

  /** 启动编排器（用户点击「开始投递」时调用） */
  async start(goal: OrchestratorState['goal'], keywords: string[]): Promise<void> {
    if (this.running) {
      diag('ORCH', '编排器已在运行，跳过重复启动')
      return
    }

    this.state = {
      phase: 'search',
      startedAt: Date.now(),
      stats: {
        appliedTotal: 0,
        hrRepliesTotal: 0,
        chatRoundsTotal: 0,
        searchRoundsTotal: 0,
        applyBatchCount: 0,
        emptyBatches: 0,
        appliedSinceChat: 0,
      },
      goal,
      keywords,
      currentKeywordIndex: 0,
      cityCode: inheritCityCode(),
      currentPage: 1,
      attemptedJobIds: [],
      exhaustedKeywords: [],
      afterChat: 'next_page',
      filterQuery: '',
      errors: [],
      lastCheckAt: 0,
    }
    // 启动时优先捕获当前页已生效的筛选；没有则回落到设置里保存的筛选
    this.state.filterQuery = captureSearchFilterQuery() || this.config.searchFilterQuery || ''
    if (this.state.filterQuery) {
      diag('ORCH', `搜索筛选参数: ${this.state.filterQuery}`)
    }
    await storage.set(STATE_KEY, this.state)
    this.running = true

    diag('ORCH', `编排器启动 goal=${goal.type}:${goal.target} keywords=${keywords.join(',')}`)
    await this.reportEvent('started', { goal, keywords })

    await this.tick()
    this.checkTimer = window.setInterval(() => this.tick(), CHECK_INTERVAL)
  }

  /** 停止编排器 */
  async stop(reason: string): Promise<void> {
    if (!this.running) return
    this.running = false
    // 先掐正在跑的投递批次与会话托管，否则它们睡醒后还会继续动作
    this.engine?.abort()
    this.engine = null
    requestStopChatRound()
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
    if (this.state) {
      this.state.phase = 'stopped'
      await storage.set(STATE_KEY, this.state)
    }
    diag('ORCH', `编排器停止: ${reason}`)
    await this.reportEvent('stopped', { reason, stats: this.state?.stats })
    notification.notify('投递助手已停止', reason)
  }

  /** 暂停（遇到异常时） */
  async pause(reason: string): Promise<void> {
    if (!this.state) return
    this.state.phase = 'paused'
    this.state.errors.push({ time: Date.now(), phase: this.state.phase, message: reason })
    await storage.set(STATE_KEY, this.state)
    diag('ORCH', `编排器暂停: ${reason}`)
    await this.reportEvent('paused', { reason })
    notification.notify('投递助手已暂停', reason)
  }

  /** 状态机主循环 */
  private async tick(): Promise<void> {
    if (!this.running || !this.state) return

    // 执行锁：投递/会话托管一轮要几十秒，而 tick 每 3 秒触发，
    // 无锁会导致同一批岗位被重复投、同一会话被重复回复。
    if (this.busy) return
    this.busy = true

    // 防抖：距上次检查不足 2 秒则跳过
    const now = Date.now()
    if (now - this.state.lastCheckAt < 2000) {
      this.busy = false
      return
    }
    this.state.lastCheckAt = now
    await storage.set(STATE_KEY, this.state)

    try {
      if (await this.checkGoalReached()) {
        await this.stop('目标已达成')
        return
      }

      if (this.detectRiskControl()) {
        await this.pause('检测到 BOSS 风控页面，请手动处理后重启')
        return
      }

      switch (this.state.phase) {
        case 'search':
          await this.runSearchPhase()
          break
        case 'apply':
          await this.runApplyPhase()
          break
        case 'chat':
          await this.runChatPhase()
          break
        case 'paused':
        case 'stopped':
          if (this.checkTimer) {
            clearInterval(this.checkTimer)
            this.checkTimer = null
          }
          break
      }
    } catch (e) {
      const msg = (e as Error).message
      diag('ORCH', `tick 异常: ${msg}`)
      this.state.errors.push({ time: now, phase: this.state.phase, message: msg })
      await storage.set(STATE_KEY, this.state)
      // 连续 3 次异常则暂停
      const recentErrors = this.state.errors.filter((err) => now - err.time < 60000)
      if (recentErrors.length >= 3) {
        await this.pause(`连续异常: ${msg}`)
      }
    } finally {
      this.busy = false
    }
  }

  /** 搜索阶段：在主页或职位列表页执行搜索 */
  private async runSearchPhase(): Promise<void> {
    if (!this.state) return

    const keyword = this.state.keywords[this.state.currentKeywordIndex] || 'C++'
    const page = this.state.currentPage
    const wantUrl = buildSearchUrl(keyword, this.state.cityCode, page, this.state.filterQuery)

    diag('ORCH', `搜索阶段: keyword=${keyword} page=${page}`)

    // 已在目标搜索结果页（关键词与页码都对得上）→ 直接进投递
    if (onSearchResultPage()) {
      const sp = new URLSearchParams(window.location.search)
      const sameKeyword = sp.get('query') === keyword
      const samePage = Number(sp.get('page') || 1) === page
      if (sameKeyword && samePage) {
        diag('ORCH', '已在目标搜索结果页，进入投递阶段')
        this.state.phase = 'apply'
        this.state.stats.searchRoundsTotal++
        await storage.set(STATE_KEY, this.state)
        await this.reportEvent('search_done', { keyword, page })
        return
      }
      diag('ORCH', `搜索条件不符（当前 query=${sp.get('query')} page=${sp.get('page') || 1}），重新跳转`)
    }

    diag('ORCH', `跳转到搜索结果页: ${wantUrl}`)
    window.location.href = wantUrl
    // 跳转后本次执行终止，页面重载后由 resume() 续跑
  }

  /** 会话托管阶段 */
  private async runChatPhase(): Promise<void> {
    if (!this.state) return

    if (!onChatPage()) {
      diag('ORCH', '当前不在聊天页，跳转...')
      window.location.href = CHAT_URL
      return  // 等下一轮 tick 重新进入
    }

    diag('ORCH', '执行会话托管...')
    const log = (m: string) => diag('ORCH', `  ${m}`)

    try {
      const result = await runChatRound(this.config, 5, log)
      this.state.stats.chatRoundsTotal++
      this.state.stats.hrRepliesTotal += result.replied

      await storage.set(STATE_KEY, this.state)
      await this.reportEvent('chat_round_done', {
        handled: result.handled,
        replied: result.replied,
      })

      diag('ORCH', `会话托管完成: ${result.handled} 个会话，${result.replied} 条回复`)

      // 按批次决策回到哪里：same_page=本页还有未投岗位回来续投；next_page=翻页/切词
      if (this.state.afterChat === 'same_page') {
        this.stayOnCurrentPage()
        diag('ORCH', `会话托管完成，回到第 ${this.state.currentPage} 页继续投剩余岗位`)
      } else {
        await this.advanceToNextPage()
        diag('ORCH', `会话托管完成，翻页（keyword=${this.state.keywords[this.state.currentKeywordIndex]} page=${this.state.currentPage}）`)
      }
      await storage.set(STATE_KEY, this.state)
    } catch (e) {
      const msg = (e as Error).message
      diag('ORCH', `会话托管失败: ${msg}`)
      await this.reportEvent('chat_failed', { error: msg })
      notification.notify('会话托管失效', msg)
      // 失败不阻断，切到搜索继续下一轮
      this.state.afterChat === 'same_page'
        ? this.stayOnCurrentPage()
        : await this.advanceToNextPage()
      await storage.set(STATE_KEY, this.state)
    }
  }

  /** 投递阶段 */
  private async runApplyPhase(): Promise<void> {
    if (!this.state) return

    // 页面前置校验：与 search 阶段共用同一套判定，避免两处不一致导致来回弹
    const platform = detectPlatform()
    if (!platform || platform.code !== 'zhipin' || !onSearchResultPage()) {
      // 记录退回次数，防止「search 跳转 → apply 又退回」无限循环
      this.applyBounceCount++
      if (this.applyBounceCount >= 3) {
        this.applyBounceCount = 0
        await this.pause('无法进入搜索结果页（连续 3 次退回），请检查页面是否被风控或改版')
        return
      }
      diag('ORCH', `不在搜索结果页（第 ${this.applyBounceCount} 次），返回搜索阶段`)
      this.state.phase = 'search'
      await storage.set(STATE_KEY, this.state)
      return
    }
    this.applyBounceCount = 0

    diag('ORCH', '执行投递批次...')

    // ApplyEngine 的 progress.applied 是「本次 run 的计数」，每轮从 0 开始，
    // 以进入本批次前的累计值为基线做累加，目标判定才不会被每批覆盖重置。
    const baseline = this.state.stats.appliedTotal

    // 批次上限 = 用户配置的「投 N 个岗位后处理一次消息会话」与「距目标剩余数」取小
    const remainingToGoal =
      this.state.goal.type === 'apply_count'
        ? Math.max(0, this.state.goal.target - baseline)
        : Number.MAX_SAFE_INTEGER
    const chatInterval = Math.max(1, Math.round(this.config.chatCheckInterval || 5))
    const batchLimit = Math.min(chatInterval, remainingToGoal)

    if (batchLimit === 0) {
      await this.stop('投递目标已达成')
      return
    }

    // 传 config 副本：config 与 Vue 面板是同一个 reactive 实例，
    // 就地改 maxApply 会污染用户设置（异常路径下还可能被 saveConfig 持久化）。
    // autoPaginate 强制关闭：翻页权归编排器（state.currentPage），
    // 否则两套页码会错位，导致重复扫描与页码统计失真。
    let scannedThisPage = 0
    let scanCompleteThisPage = false
    this.engine = new ApplyEngine(
      platform,
      { ...this.config, maxApply: batchLimit, autoPaginate: false },
      (progress) => {
        scannedThisPage = progress.scanned
        scanCompleteThisPage = progress.scanComplete
        if (this.state) {
          this.state.stats.appliedTotal = baseline + progress.applied
          this.state.stats.applyBatchCount = progress.applied
        }
        this.onApplyProgress?.(progress)
      },
      // 已尝试过的岗位直接跳过：同页续跑时不会把同一批岗位再投一遍
      new Set(this.state.attemptedJobIds || []),
    )

    await this.engine.run()
    // 合并本次尝试过的岗位 id（上限 1000 防存储膨胀），供同页续跑/翻页去重
    this.state.attemptedJobIds = Array.from(
      new Set([...(this.state.attemptedJobIds || []), ...this.engine.attemptedIds]),
    ).slice(-1000)
    this.engine = null

    // stop() 会在 abort 后置 running=false；此处提前返回，
    // 否则会继续往下跳转聊天页，把用户刚停掉的流程又拉起来
    if (!this.running) return

    const batchApplied = this.state.stats.applyBatchCount
    diag('ORCH', `投递批次完成: ${batchApplied} 个（累计 ${this.state.stats.appliedTotal}）`)
    await this.reportEvent('apply_batch_done', {
      count: batchApplied,
      keyword: this.state.keywords[this.state.currentKeywordIndex],
      page: this.state.currentPage,
    })

    // 达标则立即停，不必再绕一轮会话托管
    if (await this.checkGoalReached()) {
      await this.stop('目标已达成')
      return
    }

    this.state.stats.applyBatchCount = 0

    // 本批一个都没投出
    if (batchApplied === 0) {
      const emptyBatches = (this.state.stats.emptyBatches || 0) + 1
      this.state.stats.emptyBatches = emptyBatches

      // 没来得及扫（页面未加载完/扫描抛错）→ 暂停等用户处理，不误判「搜索到底」
      if (!scanCompleteThisPage) {
        await this.pause('页面岗位尚未加载或扫描失败，请检查页面后重启')
        await storage.set(STATE_KEY, this.state)
        return
      }

      // 页面扫描到 0 个岗位 = 搜索已到底（或选择器失效）→ 换下一个关键词
      if (scannedThisPage === 0) {
        diag('ORCH', `第 ${this.state.currentPage} 页扫描到 0 个岗位，判定搜索已到底`)
        await this.advanceKeyword('当前搜索无更多结果')
        await storage.set(STATE_KEY, this.state)
        return
      }

      // 页面有岗位但全被规则/重复挡下 → 翻下一页继续；连续 3 次空投强制查一次会话
      if (emptyBatches < 3) {
        await this.advanceToNextPage()
        await storage.set(STATE_KEY, this.state)
        diag('ORCH', `本批投递 0 个（连续 ${emptyBatches} 批），跳过会话托管，翻下一页`)
        return
      }
      this.state.stats.emptyBatches = 0
      this.state.afterChat = 'next_page'
      this.state.phase = 'chat'
      await storage.set(STATE_KEY, this.state)
      diag('ORCH', '连续 3 批空投，强制检查一次会话')
      window.location.href = CHAT_URL
      return
    }

    // 投出 > 0：按「每投 N 个岗位检查一次会话」的累计节奏决定是否去会话页
    this.state.stats.applyBatchCount = 0
    const appliedSinceChat = (this.state.stats.appliedSinceChat || 0) + batchApplied
    this.state.stats.appliedSinceChat = appliedSinceChat

    if (appliedSinceChat >= chatInterval) {
      // 达到节奏：清零计数，去会话页；之后回本页续投或翻页由本批是否投满决定
      this.state.stats.appliedSinceChat = 0
      this.state.stats.emptyBatches = 0
      this.state.afterChat = batchApplied < batchLimit ? 'next_page' : 'same_page'
      this.state.phase = 'chat'
      await storage.set(STATE_KEY, this.state)
      diag(
        'ORCH',
        `累计投递 ${appliedSinceChat} 个，达到会话检查节奏（每 ${chatInterval} 个），跳转聊天页`,
      )
      window.location.href = CHAT_URL
      return
    }

    // 未到节奏：继续投递，不去会话页
    this.state.stats.emptyBatches = 0
    if (batchApplied < batchLimit) {
      // 本页岗位已处理完 → 翻下一页
      await this.advanceToNextPage()
      diag(
        'ORCH',
        `本页投完（本批 ${batchApplied} 个，累计 ${appliedSinceChat}/${chatInterval}），未到会话节奏，翻页继续`,
      )
    } else {
      // 本页还有未投岗位 → 回本页续投
      this.stayOnCurrentPage()
      diag(
        'ORCH',
        `本页还有剩余（本批 ${batchApplied} 个，累计 ${appliedSinceChat}/${chatInterval}），回本页续投`,
      )
    }
    await storage.set(STATE_KEY, this.state)
  }

  /** 检查目标是否达成 */
  private async checkGoalReached(): Promise<boolean> {
    if (!this.state) return false

    const { goal, stats, startedAt } = this.state

    switch (goal.type) {
      case 'apply_count':
        return stats.appliedTotal >= goal.target
      case 'hr_reply_count':
        return stats.hrRepliesTotal >= goal.target
      case 'time_elapsed':
        return Date.now() - startedAt >= goal.target * 1000
      default:
        return false
    }
  }

  /** 停留在当前页（会话检查后回本页继续投剩余岗位） */
  private stayOnCurrentPage(): void {
    if (!this.state) return
    this.state.phase = 'search'
  }

  /**
   * 翻到下一页；当前关键词页数已翻完（配置 maxPagesPerKeyword）则轮换关键词。
   * 全部关键词都搜完后由 advanceKeyword 收尾（停止编排）。
   */
  private async advanceToNextPage(): Promise<void> {
    if (!this.state) return
    const maxPages = Math.max(1, Math.round(this.config.maxPagesPerKeyword || 20))
    if (this.state.currentPage < maxPages) {
      this.state.currentPage++
      this.state.phase = 'search'
      diag('ORCH', `翻到第 ${this.state.currentPage} 页`)
      return
    }
    await this.advanceKeyword(`关键词「${this.state.keywords[this.state.currentKeywordIndex]}」已翻完 ${maxPages} 页`)
  }

  /**
   * 轮换到下一个未耗尽的关键词（翻页到头 / 搜索无更多结果时调用）。
   * 标记当前关键词已耗尽；所有关键词都耗尽则停止编排。
   */
  private async advanceKeyword(reason: string): Promise<void> {
    if (!this.state) return
    const exhausted = new Set(this.state.exhaustedKeywords || [])
    exhausted.add(this.state.currentKeywordIndex)
    this.state.exhaustedKeywords = Array.from(exhausted)

    const remaining = this.state.keywords
      .map((_, i) => i)
      .filter((i) => !exhausted.has(i))
    if (remaining.length === 0) {
      await this.stop(`所有关键词已搜索完（${reason}）`)
      return
    }
    // 按顺序找下一个未耗尽的（优先当前之后，循环回开头）
    const cur = this.state.currentKeywordIndex
    const next = remaining.find((i) => i > cur) ?? remaining[0]
    this.state.currentKeywordIndex = next
    this.state.currentPage = 1
    this.state.phase = 'search'
    diag('ORCH', `切换到关键词: ${this.state.keywords[next]}（${reason}）`)
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

  /** 上报事件到服务器 */
  private async reportEvent(event: string, details: Record<string, unknown>): Promise<void> {
    try {
      await reportOrchestratorEvent(this.config, {
        event,
        timestamp: Date.now(),
        phase: this.state?.phase || 'unknown',
        stats: this.state?.stats,
        details,
      })
    } catch {
      // 上报失败不影响主流程
    }
  }

  /**
   * 从持久化状态恢复（页面刷新/跳转后调用）。
   *
   * paused 必须保持暂停：否则刷新一下页面就绕过「风控暂停」，
   * 恢复运行只能由用户显式点击。
   */
  async resume(): Promise<void> {
    const state = await storage.get<OrchestratorState | null>(STATE_KEY, null)
    if (!state) return

    if (state.phase === 'idle' || state.phase === 'stopped' || state.phase === 'paused') {
      diag('ORCH', `无需恢复（当前 ${state.phase}）`)
      // 仍写回实例，让 UI 能读到 stats 与暂停原因
      this.state = state
      this.running = false
      return
    }

    diag('ORCH', `从 ${state.phase} 阶段恢复`)
    this.state = state
    this.running = true
    // 页面刚加载完 DOM 可能还没渲染稳，延迟首次 tick
    window.setTimeout(() => void this.tick(), 2000)
    this.checkTimer = window.setInterval(() => this.tick(), CHECK_INTERVAL)
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

/** 从持久化状态恢复编排器（页面刷新/跳转后调用） */
export function resumeOrchestrator(config: PluginConfig): Promise<void> {
  return getOrchestrator(config).resume()
}
