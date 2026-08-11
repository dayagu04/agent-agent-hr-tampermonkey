// 深度翻页测试（调试工具，手动控制）—— 滚动加载方案
//
// BOSS 搜索页真实分页 = 左侧岗位列表「滚动加载」：初始 DOM 约 15 张卡片，
// 向下滚动列表容器自动追加更多岗位（?page=N 会被忽略，不采用 URL 跳页方案）。
// 本工具在当前页原地滚动采集：每步记录 卡片总数/新增/重复/滚动位置，
// 并采集滚动容器 DOM 结构采样；不投递、不点沟通、不跳转。
//
// 防御说明（2026-08-07 白屏修复）：loadProbeState 对存储状态做形状校验，
// 旧版本（URL 跳页方案）残留的 {pages:[...]} 状态会被丢弃，避免面板渲染时报错。
import type { PluginConfig } from './types'
import { storage } from './platform-bridge'
import { diag } from './logger'

export interface ProbeScrollStep {
  step: number
  cardCount: number
  fresh: number
  dup: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  atBottom: boolean
  signal: string
}

export interface ProbeContainerInfo {
  found: boolean
  tag: string
  className: string
  overflowY: string
  scrollHeight: number
  clientHeight: number
  children: string[]
  tail: string[]
}

export interface ProbeState {
  active: boolean
  keyword: string
  city: string
  maxSteps: number
  startedAt: number
  done: boolean
  doneReason: string
  seen: string[]
  steps: ProbeScrollStep[]
  container: ProbeContainerInfo | null
}

export interface ScrollListenerHit {
  tag: string
  id: string
  className: string
  overflowY: string
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

const PROBE_KEY = 'aah_probe_state'
const LOAD_WAIT_MS = 900

let lastScrollHit: ScrollListenerHit | null = null

function onAnyScroll(e: Event): void {
  // BOSS 列表是整页滚动：scroll 事件的 target 是 document，而不是某个容器元素。
  // 两种都记录：document → scrollingElement；普通元素 → 元素本身。
  let el: Element
  if (e.target instanceof Document) {
    el = document.scrollingElement || document.documentElement
  } else if (e.target instanceof HTMLElement) {
    el = e.target
  } else {
    return
  }
  const st = getComputedStyle(el)
  lastScrollHit = {
    tag: el.tagName.toLowerCase(),
    id: el.id || (el === document.scrollingElement ? '(window)' : ''),
    className: String(el.className || '').slice(0, 200),
    overflowY: st.overflowY,
    scrollTop: (el as HTMLElement).scrollTop,
    scrollHeight: (el as HTMLElement).scrollHeight,
    clientHeight: (el as HTMLElement).clientHeight,
  }
}

/** 开始监听真正触发滚动的元素（capture 模式，scroll 事件不冒泡但会捕获） */
export function startScrollListener(): void {
  lastScrollHit = null
  window.addEventListener('scroll', onAnyScroll, true)
  diag('PROBE', '滚动监听已开启，请手动滚一下左侧岗位列表')
}

export function stopScrollListener(): void {
  window.removeEventListener('scroll', onAnyScroll, true)
}

export function getScrollListenerHit(): ScrollListenerHit | null {
  return lastScrollHit
}

export async function loadProbeState(): Promise<ProbeState | null> {
  const raw = await storage.get<unknown>(PROBE_KEY, null)
  // 形状校验：旧版本（URL 跳页方案）的 {pages:[...]} 状态没有 steps 字段，
  // 直接丢弃，避免下游访问 state.steps 抛错导致面板白屏。
  if (
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray((raw as ProbeState).steps) ||
    !Array.isArray((raw as ProbeState).seen)
  ) {
    return null
  }
  return raw as ProbeState
}

function onSearchPage(): boolean {
  if (!/\/web\/geek\/jobs?\b/.test(window.location.pathname)) return false
  const sp = new URLSearchParams(window.location.search)
  return sp.has('query') && !!sp.get('query')
}

function elBrief(el: Element): string {
  const cls = String((el as HTMLElement).className || '')
  return `${el.tagName.toLowerCase()}${cls ? '.' + cls.split(/\s+/).slice(0, 3).join('.') : ''}`
}

function findScrollContainer(): HTMLElement | null {
  const first = document.querySelector('.job-card-wrap')
  if (!first) return null
  let cur = first.parentElement
  while (cur) {
    const st = getComputedStyle(cur)
    if (cur.scrollHeight > cur.clientHeight + 4 && /auto|scroll|overlay/.test(st.overflowY)) {
      return cur
    }
    cur = cur.parentElement
  }
  return null
}

function collectContainerInfo(): ProbeContainerInfo {
  const container = findScrollContainer()
  if (!container) {
    return {
      found: false,
      tag: '',
      className: '',
      overflowY: '',
      scrollHeight: 0,
      clientHeight: 0,
      children: [],
      tail: [],
    }
  }
  const st = getComputedStyle(container)
  return {
    found: true,
    tag: container.tagName.toLowerCase(),
    className: String(container.className || '').slice(0, 200),
    overflowY: st.overflowY,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    children: Array.from(container.children).slice(0, 8).map(elBrief),
    tail: Array.from(container.children).slice(-2).map(elBrief),
  }
}

/** 岗位列表 DOM 结构采样：卡片祖先链 + 可滚动候选 + 加载/分页提示元素 */
export function collectListDom(): string {
  const first = document.querySelector('.job-card-wrap')
  const out: string[] = []
  out.push('=== 岗位列表 DOM 结构 ===')
  if (!first) {
    out.push('未找到 .job-card-wrap 卡片（页面可能不是搜索列表页）')
    return out.join('\n')
  }
  out.push(`卡片: ${elBrief(first)}`)
  let cur = first.parentElement
  let depth = 0
  const scrollables: string[] = []
  while (cur && depth < 10) {
    const st = getComputedStyle(cur)
    const line =
      `${elBrief(cur)} | overflow=${st.overflowX}/${st.overflowY} | ` +
      `${cur.scrollHeight}/${cur.clientHeight}px | scrollTop=${cur.scrollTop} | position=${st.position}`
    out.push(`  L${depth + 1}: ${line}`)
    if (cur.scrollHeight > cur.clientHeight + 4 && /auto|scroll|overlay/.test(st.overflowY)) {
      scrollables.push(line)
    }
    cur = cur.parentElement
    depth++
  }
  out.push('可滚动候选:')
  out.push(scrollables.length ? scrollables.map((s) => '  ' + s).join('\n') : '  （无，可能是 window 滚动）')

  const listBox = first.closest('ul, [class*="list"], [class*="search"]')
  out.push('列表容器(最近 ul/含list/search 祖先) 尾部元素:')
  if (listBox) {
    out.push(Array.from(listBox.children).slice(-3).map(elBrief).join('  ') || '  （空）')
  } else {
    out.push('  （未找到）')
  }

  const hints = Array.from(document.querySelectorAll('div,li,p,span,a,button'))
    .map((el) => ({ el, t: ((el as HTMLElement).textContent || '').trim() }))
    .filter((x) => x.t.length <= 16 && /(加载|更多|下一页|没有更多|已显示全部|已经到底|无更多)/.test(x.t))
    .slice(0, 8)
    .map((x) => `${elBrief(x.el)}「${x.t}」`)
  out.push('加载/分页提示元素:')
  out.push(hints.length ? hints.join('\n') : '  （未检测到）')
  return out.join('\n')
}

function detectSignal(): string {
  const texts = Array.from(document.querySelectorAll('div, li, p, span'))
    .map((el) => ((el as HTMLElement).textContent || '').trim())
    .filter((t) => t.length <= 16 && /(加载|没有更多|已显示全部|已经到底|无更多)/.test(t))
  return Array.from(new Set(texts)).slice(0, 2).join(' / ')
}

function cardId(card: HTMLElement): string {
  const href = (card.querySelector('a[href*="job_detail"]') as HTMLAnchorElement | null)?.href || ''
  const m = href.split('?')[0].split('#')[0].match(/job_detail\/([A-Za-z0-9_~-]+)/)
  return m ? m[1] : card.getAttribute('data-jobid') || card.getAttribute('data-jid') || href
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 开始测试：校验当前是 BOSS 搜索列表页后，原地滚动采集（不跳转） */
export async function startProbe(
  _cfg: PluginConfig,
  _keyword: string,
  maxSteps: number,
): Promise<{ ok: boolean; message: string }> {
  try {
    if (!onSearchPage()) {
      return {
        ok: false,
        message: '请先到 BOSS 搜索列表页（URL 形如 /web/geek/jobs?query=python）再点「开始」',
      }
    }
    const sp = new URLSearchParams(window.location.search)
    const state: ProbeState = {
      active: true,
      keyword: sp.get('query') || '',
      city: sp.get('city') || '',
      maxSteps: Math.max(2, Math.min(maxSteps || 20, 60)),
      startedAt: Date.now(),
      done: false,
      doneReason: '',
      seen: [],
      steps: [],
      container: collectContainerInfo(),
    }
    await storage.set(PROBE_KEY, state)
    diag('PROBE', `开始滚动采集：keyword=${state.keyword} maxSteps=${state.maxSteps}`)
    void runProbeLoop(state)
    return { ok: true, message: '' }
  } catch (e) {
    diag('PROBE', `启动失败: ${(e as Error).message}`)
    return { ok: false, message: `启动失败：${(e as Error).message}` }
  }
}

async function runProbeLoop(initial: ProbeState): Promise<void> {
  let state = initial
  try {
    for (let step = 1; step <= state.maxSteps; step++) {
      const freshState = await loadProbeState()
      if (!freshState || !freshState.active || freshState.done) return
      state = freshState

      const cardsBefore = document.querySelectorAll('.job-card-wrap').length
      const seenBefore = new Set(state.seen)
      // BOSS 列表是页面级滚动，加载触发器在列表底部（a.more-job-btn「查看更多信息」进入可视区）。
      // 直接滚到底比增量滚动更贴近触发阈值；加载后页面变高，下一步再滚到新底部。
      const container = findScrollContainer()
      const sc = container || document.scrollingElement || document.documentElement
      sc.scrollTop = sc.scrollHeight
      await delay(LOAD_WAIT_MS)

      const cards = Array.from(document.querySelectorAll('.job-card-wrap')) as HTMLElement[]
      const ids = cards.map(cardId)
      const fresh = ids.filter((id) => !seenBefore.has(id)).length
      const dup = ids.length - fresh
      state.seen = Array.from(new Set([...state.seen, ...ids]))
      // 是否已滚到容器底部（滚动加载通常在接近底部时触发，未到底不算加载完成）
      const atBottom = sc.scrollHeight - (sc.scrollTop + sc.clientHeight) <= 8
      state.steps.push({
        step,
        cardCount: cards.length,
        fresh,
        dup,
        scrollTop: sc.scrollTop,
        scrollHeight: sc.scrollHeight,
        clientHeight: sc.clientHeight,
        atBottom,
        signal: detectSignal(),
      })
      diag(
        'PROBE',
        `步 ${step}/${state.maxSteps}：卡片 ${cardsBefore} → ${cards.length}（新增 ${fresh}），` +
          `滚动 ${sc.scrollTop}/${sc.scrollHeight}${atBottom ? '（已到底）' : ''}`,
      )
      await storage.set(PROBE_KEY, state)

      // 只有真正滚到底部且无新增，才算采集完成；未到底继续滚（maxSteps 兜底）
      if (atBottom && fresh === 0) {
        state.active = false
        state.done = true
        state.doneReason = `已滚动到底部，共 ${cards.length} 张卡片（新增 ${fresh}）`
        await storage.set(PROBE_KEY, state)
        diag('PROBE', state.doneReason)
        return
      }
    }
    const final = await loadProbeState()
    if (final && final.active) {
      const sc = findScrollContainer() || document.scrollingElement || document.documentElement
      final.active = false
      final.done = true
      const atBottom = sc.scrollHeight - (sc.scrollTop + sc.clientHeight) <= 8
      final.doneReason = atBottom
        ? `已达最大步数 ${state.maxSteps}，已滚动到底部`
        : `已达最大步数 ${state.maxSteps}（尚未到底：${sc.scrollTop}/${sc.scrollHeight}）`
      await storage.set(PROBE_KEY, final)
    }
  } catch (e) {
    diag('PROBE', `采集中断: ${(e as Error).message}`)
    state.active = false
    state.done = true
    state.doneReason = `采集异常中断：${(e as Error).message}`
    try {
      await storage.set(PROBE_KEY, state)
    } catch {
      /* 落盘失败不阻塞 */
    }
  }
}

/** 停止测试：保留已采集数据 */
export async function stopProbe(): Promise<void> {
  try {
    const state = await loadProbeState()
    if (state) {
      state.active = false
      state.done = true
      state.doneReason = state.doneReason || '用户手动停止'
      await storage.set(PROBE_KEY, state)
    }
    diag('PROBE', '滚动采集已手动停止')
  } catch (e) {
    diag('PROBE', `停止失败: ${(e as Error).message}`)
  }
}
