// 全链路编排器 - 投递 + 会话托管的状态机核心
//
// 职责：跨页持久化状态、调度投递与会话、终止条件判断、异常恢复
//
// 设计原则（2026-07-30）：
// 1. 会话优先：每轮先清空待回复会话（HR 回复是稀缺资源，及时回复提高转化）
// 2. 分批投递：投递 N 个 → 查会话 → 再投 N 个（模拟真人习惯，降低风控）
// 3. 异常透明：所有停止/失败上报服务器，可在网页端查
// 4. 可恢复：页面刷新/跳转后能从断点续跑

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
}

const STATE_KEY = 'aah_orchestrator_state'
const CHECK_INTERVAL = 3000  // 每 3 秒检查一次状态
// 每批投递 3 个后切换到会话托管。
// 曾另有 CHAT_CHECK_THRESHOLD=5（"累计 5 个后必须查会话"），已删：每批结束都会
// 切到会话阶段，批大小 3 恒小于 5，那个阈值永远不会先触发，是纯死变量。
const APPLY_BATCH_SIZE = 3

/**
 * 职位列表页判定 —— 唯一定义，search / apply 两阶段共用。
 *
 * 教训（2026-07-31）：曾在 search 里判 `/web/geek/job`、apply 里判 `/web/geek/job?`，
 * 而 BOSS 真实路径是 `/web/geek/jobs`（复数）。前者被 `jobs` 命中 → 切 apply，
 * 后者匹配失败 → 退回 search，两个判定互相打架，死循环刷了 5 分钟没投出一个。
 * 页面判定必须单一来源，禁止各阶段各写一套。
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
 * BOSS 的 city 参数是数字编码（合肥=101220100），而配置里的 prefCity 是城市名
 * （"合肥"）。硬编码「城市名 → 编码」映射表会随 BOSS 调整而失效，且漏一个城市
 * 就静默投到全国。改为继承用户首次进入搜索页时 URL 上的编码——那是 BOSS 自己
 * 生成的，一定正确；取不到则不传 city，由 BOSS 按账号求职期望默认筛选。
 */
function inheritCityCode(): string {
  return new URLSearchParams(window.location.search).get('city') || ''
}

/** 构造搜索结果页 URL。cityCode 为 BOSS 数字编码，空则不传（走账号默认期望城市） */
function buildSearchUrl(keyword: string, cityCode: string, page: number): string {
  const p = new URLSearchParams()
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
   * 必须持引用：engine.run() 内部有 200s 级的保号睡眠，
   * stop() 拿不到实例就无法 abort，用户点了「停止编排」后
   * engine 睡醒仍会继续投（实测 16:48 停、16:50 又投出一个）。
   */
  private engine: ApplyEngine | null = null

  /**
   * 投递进度回调，由面板注入。
   *
   * 编排器内部自建 ApplyEngine，若不把 progress 透出去，面板顶部
   * 「扫描/匹配/已投/跳过/失败」五个格子就永远是 0——实测投出去了却全显示 0，
   * 用户只能靠日志猜有没有在干活。
   */
  private onApplyProgress: ((p: ApplyProgress) => void) | null = null

  constructor(config: PluginConfig) {
    this.config = config
  }

  /** 注入投递进度回调（面板挂载时调用一次） */
  setApplyProgressHandler(fn: (p: ApplyProgress) => void): void {
    this.onApplyProgress = fn
  }

  /** 启动编排器（用户点击「开始投递」时调用） */
  async start(goal: OrchestratorState['goal'], keywords: string[]): Promise<void> {
    if (this.running) {
      diag('ORCH', '编排器已在运行，跳过重复启动')
      return
    }

    // 初始化状态
    this.state = {
      phase: 'search',  // 从搜索开始
      startedAt: Date.now(),
      stats: { appliedTotal: 0, hrRepliesTotal: 0, chatRoundsTotal: 0, searchRoundsTotal: 0, applyBatchCount: 0 },
      goal,
      keywords,
      currentKeywordIndex: 0,
      cityCode: inheritCityCode(),
      currentPage: 1,
      errors: [],
      lastCheckAt: 0,
    }
    await storage.set(STATE_KEY, this.state)
    this.running = true

    diag('ORCH', `编排器启动 goal=${goal.type}:${goal.target} keywords=${keywords.join(',')}`)
    await this.reportEvent('started', { goal, keywords })

    // 立即执行第一次检查
    await this.tick()

    // 启动定时检查
    this.checkTimer = window.setInterval(() => this.tick(), CHECK_INTERVAL)
  }

  /** 停止编排器 */
  async stop(reason: string): Promise<void> {
    if (!this.running) return
    this.running = false
    // 先掐正在跑的投递批次，否则它睡醒后还会投一个
    this.engine?.abort()
    this.engine = null
    // 会话托管同样要掐。
    // 实测（2026-08-01）：02:06 点「停止编排」，会话托管却一路跑到 02:28 才收尾
    // ——因为这里只 abort 了投递引擎，runChatRound 内部的 40 个会话循环无人通知，
    // 每个会话还要等满轮询超时。停止必须覆盖所有对外发消息的链路。
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

    // 执行锁：投递/会话托管一轮要几十秒，而 tick 每 3 秒触发。
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
      // 1. 检查终止条件
      if (await this.checkGoalReached()) {
        await this.stop('目标已达成')
        return
      }

      // 2. 检查风控页
      if (this.detectRiskControl()) {
        await this.pause('检测到 BOSS 风控页面，请手动处理后重启')
        return
      }

      // 3. 根据当前阶段执行
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
          // 已停止，清理定时器
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

  /** 搜索阶段 - 在主页或职位列表页执行搜索 */
  private async runSearchPhase(): Promise<void> {
    if (!this.state) return

    const keyword = this.state.keywords[this.state.currentKeywordIndex] || 'C++'
    const page = this.state.currentPage
    const wantUrl = buildSearchUrl(keyword, this.state.cityCode, page)

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
    // 跳转后本次执行终止，页面重载后由 resumeOrchestrator 续跑
  }

  /** 会话托管阶段 */
  private async runChatPhase(): Promise<void> {
    if (!this.state) return

    // 检查是否在聊天页
    if (!onChatPage()) {
      diag('ORCH', '当前不在聊天页，跳转...')
      window.location.href = 'https://www.zhipin.com/web/geek/chat'
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

      // 会话托管完成后，切换回搜索阶段（开始新一轮）
      // 如果当前页码还有剩余，继续投递；否则切换关键词
      if (this.state.currentPage < 3) {
        // 当前关键词还有页码，继续投递
        this.state.currentPage++
        this.state.phase = 'search'
      } else {
        // 当前关键词已完成 3 页，切换下一个关键词
        this.state.currentKeywordIndex = (this.state.currentKeywordIndex + 1) % this.state.keywords.length
        this.state.currentPage = 1
        this.state.phase = 'search'
        diag('ORCH', `切换关键词: ${this.state.keywords[this.state.currentKeywordIndex]}`)
      }

      await storage.set(STATE_KEY, this.state)
    } catch (e) {
      const msg = (e as Error).message
      diag('ORCH', `会话托管失败: ${msg}`)
      await this.reportEvent('chat_failed', { error: msg })
      notification.notify('会话托管失效', msg)
      // 失败不阻断，切到搜索继续下一轮
      if (this.state.currentPage < 3) {
        this.state.currentPage++
        this.state.phase = 'search'
      } else {
        this.state.currentKeywordIndex = (this.state.currentKeywordIndex + 1) % this.state.keywords.length
        this.state.currentPage = 1
        this.state.phase = 'search'
      }
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

    // ApplyEngine 的 progress.applied 是「本次 run 的计数」，每轮从 0 开始。
    // 直接赋给 appliedTotal 会让累计数被每批覆盖重置（投 3 批各 3 个仍显示 3），
    // 目标判定因此永远达不成。故以进入本批次前的累计值为基线做累加。
    const baseline = this.state.stats.appliedTotal

    // 本批次上限：APPLY_BATCH_SIZE 与「距目标剩余数」取小
    const remainingToGoal =
      this.state.goal.type === 'apply_count'
        ? Math.max(0, this.state.goal.target - baseline)
        : Number.MAX_SAFE_INTEGER
    const batchLimit = Math.min(APPLY_BATCH_SIZE, remainingToGoal)

    if (batchLimit === 0) {
      await this.stop('投递目标已达成')
      return
    }

    // 传 config 副本而非改共享对象：config 与 Vue 面板是同一个 reactive 实例，
    // 就地改 maxApply 会污染用户设置（异常路径下还可能被 saveConfig 持久化）。
    //
    // autoPaginate 强制关闭：翻页权归编排器（state.currentPage），
    // 若 engine 也在内部翻页，两套页码会错位——编排器以为还在第 1 页，
    // 实际 DOM 已翻到第 3 页，导致重复扫描与页码统计失真。
    this.engine = new ApplyEngine(
      platform,
      { ...this.config, maxApply: batchLimit, autoPaginate: false },
      (progress) => {
        if (this.state) {
          this.state.stats.appliedTotal = baseline + progress.applied
          this.state.stats.applyBatchCount = progress.applied
        }
        // 透出给面板，否则顶部五格统计恒为 0
        this.onApplyProgress?.(progress)
      },
    )

    await this.engine.run()
    this.engine = null

    // stop() 会在 abort 后置 running=false；此处提前返回，
    // 否则会继续往下跳转聊天页，把用户刚停掉的流程又拉起来
    if (!this.running) return

    const batchApplied = this.state.stats.applyBatchCount
    diag('ORCH', `投递批次完成: ${batchApplied} 个（累计 ${this.state.stats.appliedTotal}）`)
    await this.reportEvent('apply_batch_done', { count: batchApplied })

    // 达标则立即停，不必再绕一轮会话托管
    if (await this.checkGoalReached()) {
      await this.stop('目标已达成')
      return
    }

    // 转入会话托管
    this.state.phase = 'chat'
    this.state.stats.applyBatchCount = 0
    await storage.set(STATE_KEY, this.state)

    diag('ORCH', '跳转到聊天页处理 HR 回复')
    window.location.href = 'https://www.zhipin.com/web/geek/chat'
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

  /** 检测风控页面 */
  private detectRiskControl(): boolean {
    const bodyText = document.body.textContent || ''
    return (
      /安全验证|账号异常|操作频繁|请稍后再试/.test(bodyText) ||
      document.querySelector('.security-check, .captcha') !== null
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
export async function resumeOrchestrator(config: PluginConfig): Promise<void> {
  const state = await storage.get<OrchestratorState | null>(STATE_KEY, null)
  if (!state) return

  // paused 必须保持暂停：否则刷新一下页面就绕过了「风控暂停」，
  // 等于风控保护形同虚设。恢复运行只能由用户显式点击。
  if (state.phase === 'idle' || state.phase === 'stopped' || state.phase === 'paused') {
    diag('ORCH', `无需恢复（当前 ${state.phase}）`)
    // 仍写回实例，让 UI 能读到 stats 与暂停原因
    const orch = getOrchestrator(config)
    orch['state'] = state
    orch['running'] = false
    return
  }

  diag('ORCH', `从 ${state.phase} 阶段恢复`)
  const orch = getOrchestrator(config)
  orch['state'] = state
  orch['running'] = true
  // 页面刚加载完 DOM 可能还没渲染稳，延迟首次 tick
  window.setTimeout(() => orch['tick'](), 2000)
  orch['checkTimer'] = window.setInterval(() => orch['tick'](), CHECK_INTERVAL)
}
