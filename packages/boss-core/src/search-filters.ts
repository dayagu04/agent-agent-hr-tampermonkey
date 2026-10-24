// BOSS 搜索页筛选条件的读取与原子点选。读取不改页面；点选只作用于请求的分组，
// 并以该组实际选中状态确认结果。

import { diag } from './logger'

export interface FilterOption {
  text: string
  /** 选项自带的链接（存在则可用 URL 参数直接生效） */
  href?: string
  selected: boolean
}

export interface FilterGroup {
  name: string
  options: FilterOption[]
}

/** 识别得了的筛选项标签 → 归一化分组名 */
const GROUP_NAMES = [
  '城市',
  '求职类型',
  '职位类型',
  '薪资待遇',
  '工作经验',
  '学历要求',
  '公司规模',
  '公司行业',
  '融资阶段',
]

/** URL 里非筛选项的参数，统计时排除 */
const NON_FILTER_PARAMS = new Set(['query', 'page'])

function ownText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => (n.textContent || '').trim())
    .join('')
    .replace(/\s/g, '')
}

function selected(el: Element): boolean {
  return /(^|[-_\s])(active|selected|cur|current)([-_\s]|$)/.test(String(el.className || ''))
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/** 找「城市」「薪资待遇」这类分组标签所在的节点（自身文本恰好等于标签） */
function findGroupLabel(name: string): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll('span, div, li, dt, em'))) {
    if ((el as HTMLElement).closest('.aah-root')) continue
    if (ownText(el) !== name) continue
    if (!visible(el)) continue
    return el as HTMLElement
  }
  return null
}

/** 从分组标签往上找容器：容器里应有多个可点击选项 */
function groupOptions(label: HTMLElement): FilterOption[] {
  let scope: HTMLElement | null = label.parentElement
  for (let up = 0; up < 3 && scope; up++) {
    const cand = Array.from(
      scope.querySelectorAll('a, li, span, div'),
    ) as HTMLElement[]
    const options: FilterOption[] = []
    for (const el of cand) {
      if (el === label || el.contains(label)) continue
      if (el.closest('.aah-root')) continue
      const t = ownText(el)
      if (!t || t.length > 20) continue
      if (t === label.textContent) continue
      if (!visible(el)) continue
      const interactive =
        el.tagName === 'A' ||
        el.getAttribute('role') === 'option' ||
        getComputedStyle(el).cursor === 'pointer' ||
        !!el.closest('a')
      if (!interactive) continue
      const anchor = (el.closest('a') as HTMLAnchorElement | null) || null
      options.push({
        text: t,
        href: anchor?.getAttribute('href') || undefined,
        selected: selected(el),
      })
    }
    // 去重（同一选项文字只留一个）并压在合理数量内
    const seen = new Set<string>()
    const unique = options.filter((o) => (seen.has(o.text) ? false : (seen.add(o.text), true)))
    if (unique.length >= 2) return unique.slice(0, 40)
    scope = scope.parentElement
  }
  return []
}

export function readSearchFilters(): FilterGroup[] {
  const groups: FilterGroup[] = []
  for (const name of GROUP_NAMES) {
    const label = findGroupLabel(name)
    if (!label) continue
    const options = groupOptions(label)
    if (options.length) groups.push({ name, options })
  }
  return groups
}

let lastProbeKey = ''

/**
 * 只读探测一次筛选区并写日志（同一 URL 参数组合只报一次）。
 *
 * 日志形如：
 *   filter_probe groups=4 城市:12opt,href=city,sel=1 薪资待遇:8opt,href=-,sel=0 params=query,city
 */
export function probeSearchFiltersOnce(reason: string): void {
  const params = new URLSearchParams(location.search)
  const paramKeys = Array.from(params.keys()).filter((k) => !NON_FILTER_PARAMS.has(k))
  const key = `${location.pathname}?${location.search}`
  if (key === lastProbeKey) return
  lastProbeKey = key

  const groups = readSearchFilters()
  if (!groups.length) {
    diag(
      'FILTER',
      `filter_probe status=none reason=${reason} params=${paramKeys.join(',') || '-'} ` +
        `candidates=${document.querySelectorAll('[class*="filter"], [class*="condition"]').length}`,
    )
    return
  }
  const parts = groups.map((g) => {
    const hrefKeys = new Set<string>()
    for (const o of g.options) {
      if (!o.href) continue
      const qs = o.href.split('?')[1] || ''
      for (const k of new URLSearchParams(qs).keys()) hrefKeys.add(k)
    }
    return `${g.name}:${g.options.length}opt,href=${Array.from(hrefKeys).join('+') || '-'},sel=${g.options.filter((o) => o.selected).length}`
  })
  diag(
    'FILTER',
    `filter_probe status=found reason=${reason} groups=${groups.length} ` +
      `${parts.join(' ')} params=${paramKeys.join(',') || '-'}`,
  )
}

// ---- 选中筛选项（点击式） -------------------------------------------------
//
// 实测结论（2026-10-20）：筛选项全部没有 href，不能靠 URL 参数设定；
// 交互形态是「点分组 → 弹出面板 → 点里面的具体选项」。这里按这个流程实现，
// 每一步都记日志，失败也能看出卡在哪一步。

import { realClick } from './dom-events'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 2026-10-25 probe_dom：标签与下拉同属一个容器，不在全页找同名选项。 */
function groupPanel(label: HTMLElement): HTMLElement | null {
  const current = label.closest('.current-select')
  const scope = current?.parentElement
  if (!scope) return null
  const panels = Array.from(scope.children).filter((el) => el.matches('.filter-select-dropdown'))
  return panels.length === 1 ? panels[0] as HTMLElement : null
}

type FilterRejectStage = 'group_missing' | 'group_hidden' | 'group_shape' | 'panel_count' |
  'option_count' | 'stale' | 'disabled' | 'panel_shape' | 'expand_timeout' | 'selection_not_confirmed'

interface FilterNodeDiagnostic {
  role: 'label' | 'target' | 'ul' | 'panel' | 'group' | 'ancestor'
  display: string
  visibility: string
  opacity: string
  pointerEvents: string
  width: number
  height: number
}

interface FilterApplyDiagnostic {
  stage: FilterRejectStage
  connected: { group: boolean; panel: boolean; option: boolean }
  shape: { groupFound: boolean; panelCount: number; optionCount: number; panelOwned: boolean; directUlLi: boolean }
  blocker?: FilterNodeDiagnostic
  panelBefore?: FilterNodeDiagnostic
  panelAfter?: FilterNodeDiagnostic
  panelInlineAfter?: Record<'visibility' | 'opacity' | 'transition', { present: boolean; matchesExpected: boolean; important: boolean }>
  waitCount?: number
}

/** 隐藏下拉也可能有非零 rect；点击前必须同时核对自身及祖先的 CSS。 */
function actionBlocker(el: HTMLElement): HTMLElement | null {
  if (!visible(el)) return el
  for (let current: HTMLElement | null = el; current; current = current.parentElement) {
    const style = getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return current
  }
  return getComputedStyle(el).pointerEvents === 'none' ? el : null
}

function actionable(el: HTMLElement): boolean {
  return actionBlocker(el) === null
}

function disabledBlocker(el: HTMLElement): HTMLElement | null {
  for (let current: HTMLElement | null = el; current; current = current.parentElement) {
    if (current.hasAttribute('disabled') || current.getAttribute('aria-disabled') === 'true' ||
      /(^|[-_\s])disabled([-_\s]|$)/.test(current.className)) return current
  }
  return null
}

function optionMatches(panel: HTMLElement, optionText: string): HTMLElement[] {
  const want = optionText.replace(/\s/g, '')
  return (Array.from(panel.querySelectorAll('li')) as HTMLElement[]).filter((el) => ownText(el) === want)
}

function findOptionInPanel(panel: HTMLElement, optionText: string): HTMLElement | null {
  const matches = optionMatches(panel, optionText)
  return matches.length === 1 ? matches[0] : null
}

function nodeDiagnostic(el: HTMLElement, role: FilterNodeDiagnostic['role']): FilterNodeDiagnostic {
  const style = getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  return {
    role, display: style.display, visibility: style.visibility, opacity: style.opacity,
    pointerEvents: style.pointerEvents, width: Math.round(rect.width), height: Math.round(rect.height),
  }
}

/** 只输出固定枚举、布尔、数量和样式；不返回文本、HTML、URL 或任意属性。 */
function filterDiagnostic(
  stage: FilterRejectStage, label: HTMLElement | null, panel: HTMLElement | null,
  target: HTMLElement | null, option: string, blocker?: HTMLElement | null,
): FilterApplyDiagnostic {
  const group = label?.closest('.current-select')?.parentElement
  const panelCount = group ? Array.from(group.children).filter((el) => el.matches('.filter-select-dropdown')).length : 0
  const result: FilterApplyDiagnostic = {
    stage,
    connected: { group: !!group?.isConnected, panel: !!panel?.isConnected, option: !!target?.isConnected },
    shape: {
      groupFound: !!group, panelCount, optionCount: panel ? optionMatches(panel, option).length : 0,
      panelOwned: !!label && !!panel && groupPanel(label) === panel,
      directUlLi: !!target && target.parentElement?.tagName === 'UL' && target.parentElement.parentElement === panel,
    },
  }
  if (blocker) {
    const role = blocker === label ? 'label' : blocker === target ? 'target' :
      blocker === panel ? 'panel' : blocker === group ? 'group' :
      blocker === target?.parentElement && blocker.tagName === 'UL' ? 'ul' : 'ancestor'
    result.blocker = nodeDiagnostic(blocker, role)
  }
  return result
}

/** 仅放行实测 hover 下拉：恢复 CSS 继承后重查目标，独立隐藏/禁用选项仍拒绝。 */
async function clickOptionInPanel(
  label: HTMLElement, panel: HTMLElement, target: HTMLElement, option: string,
): Promise<FilterApplyDiagnostic | null> {
  const reject = (stage: FilterRejectStage, blocker?: HTMLElement | null) => filterDiagnostic(stage, label, panel, target, option, blocker)
  if (!label.isConnected || !panel.isConnected || !target.isConnected || groupPanel(label) !== panel) return reject('stale')
  const groupBlocker = actionBlocker(label) || (panel.parentElement ? actionBlocker(panel.parentElement) : panel)
  if (groupBlocker) return reject('group_hidden', groupBlocker)
  const disabled = disabledBlocker(target)
  if (disabled) return reject('disabled', disabled)
  if (actionable(target)) {
    realClick(target)
    return null
  }
  // command 53: dropdown=block/hidden/0/auto，直属 ul/li 继承 hidden，但自身 opacity=1。
  // 合成鼠标事件不建立 CSS :hover；只临时展开这个已绑定面板，不修改其他隐藏结构。
  const style = getComputedStyle(panel)
  if (!visible(panel) || style.display !== 'block' || style.visibility !== 'hidden' ||
    style.opacity !== '0' || style.pointerEvents !== 'auto' ||
    target.parentElement?.tagName !== 'UL' || target.parentElement.parentElement !== panel) {
    return { ...reject('panel_shape', actionBlocker(target)), panelBefore: nodeDiagnostic(panel, 'panel') }
  }
  const panelBefore = nodeDiagnostic(panel, 'panel')
  // transition 的部分长属性也可能单独内联设置；保存完整值/优先级，避免恢复 shorthand 时丢失。
  const previous = ['visibility', 'opacity', 'transition', 'transition-property', 'transition-duration',
    'transition-timing-function', 'transition-delay', 'transition-behavior'].map((name) => ({
    name, value: panel.style.getPropertyValue(name), priority: panel.style.getPropertyPriority(name),
  }))
  const inlineOverride = (name: string, expected: string) => ({
    present: panel.style.getPropertyValue(name) !== '',
    matchesExpected: panel.style.getPropertyValue(name) === expected,
    important: panel.style.getPropertyPriority(name) === 'important',
  })
  const expandedRejection = (stage: FilterRejectStage, waitCount: number, blocker?: HTMLElement | null): FilterApplyDiagnostic => ({
    ...reject(stage, blocker), panelBefore, panelAfter: nodeDiagnostic(panel, 'panel'), waitCount,
    panelInlineAfter: {
      visibility: inlineOverride('visibility', 'visible'),
      opacity: inlineOverride('opacity', '1'),
      transition: inlineOverride('transition', 'none'),
    },
  })
  try {
    // command 76: 同组面板展开后的计算值仍 hidden/0；过渡可覆盖内联 important，先停本面板过渡。
    panel.style.setProperty('transition', 'none', 'important')
    panel.style.setProperty('visibility', 'visible', 'important')
    panel.style.setProperty('opacity', '1', 'important')
    // 计算样式可能仍在 opacity transition 的起点；只等待状态，不重新触发点击。
    for (let i = 0; i <= 12; i++) {
      if (!target.isConnected || groupPanel(label) !== panel) return expandedRejection('stale', i)
      const disabled = disabledBlocker(target)
      if (disabled) return expandedRejection('disabled', i, disabled)
      if (actionable(target)) {
        realClick(target)
        return null
      }
      if (i < 12) await sleep(200)
    }
    return expandedRejection('expand_timeout', 12, actionBlocker(target))
  } finally {
    for (const { name, value, priority } of previous) {
      if (value) panel.style.setProperty(name, value, priority)
      else panel.style.removeProperty(name)
    }
  }
}

/** 清空筛选时不限自身可能没有 active；本组已选项、计数和 is-select 必须同时清空。 */
function selectionConfirmed(label: HTMLElement, panel: HTMLElement, option: string): boolean {
  const target = findOptionInPanel(panel, option)
  if (!target) return false
  if (selected(target)) return true
  if (option.replace(/\s/g, '') !== '不限') return false
  const current = label.closest('.current-select')
  return !Array.from(panel.querySelectorAll('li')).some(selected) &&
    !current?.querySelector('.select-num') &&
    !current?.parentElement?.classList.contains('is-select')
}

export interface FilterApplyResult {
  group: string
  option: string
  status: 'ok' | 'no_trigger' | 'no_panel' | 'no_option' | 'selection_not_confirmed'
  urlChanged: boolean
  diagnostic?: FilterApplyDiagnostic
}

/** 只点请求分组里的唯一匹配项，重复请求已选项不再切换；未知结果不报成功。 */
export async function selectSearchFilter(
  group: string,
  option: string,
): Promise<FilterApplyResult> {
  const urlBefore = location.search
  const trigger = findGroupLabel(group)
  if (!trigger || !actionable(trigger)) {
    diag('FILTER', `filter_apply group=${group} status=no_trigger`)
    return { group, option, status: 'no_trigger', urlChanged: false,
      diagnostic: filterDiagnostic(trigger ? 'group_hidden' : 'group_missing', trigger, null, null, option, trigger ? actionBlocker(trigger) : null) }
  }
  if (!trigger.closest('.current-select')) {
    diag('FILTER', `filter_apply group=${group} status=no_panel`)
    return { group, option, status: 'no_panel', urlChanged: false,
      diagnostic: filterDiagnostic('group_shape', trigger, null, null, option) }
  }
  let panel = groupPanel(trigger)
  if (panel && selectionConfirmed(trigger, panel, option)) {
    diag('FILTER', `filter_apply group=${group} option=${option} status=ok already_selected=true`)
    return { group, option, status: 'ok', urlChanged: false }
  }
  const hit = realClick(trigger)
  diag('FILTER', `filter_apply group=${group} step=click_trigger hit=${hit}`)

  let target: HTMLElement | null = null
  let diagnostic: FilterApplyDiagnostic | undefined
  for (let i = 0; i < 12 && !target; i++) {
    await sleep(200)
    const label = findGroupLabel(group)
    panel = label ? groupPanel(label) : null
    const candidate = panel ? findOptionInPanel(panel, option) : null
    if (label && panel && candidate) {
      const rejection = await clickOptionInPanel(label, panel, candidate, option)
      if (rejection) diagnostic = rejection
      else { target = candidate; diagnostic = undefined }
      break
    }
    diagnostic = filterDiagnostic(!label ? 'group_missing' : !panel ? 'panel_count' : 'option_count', label, panel, candidate, option)
  }
  if (!target || !panel) {
    const panelOpen = panel && actionable(panel)
    const status = panelOpen ? 'no_option' : 'no_panel'
    diag('FILTER', `filter_apply group=${group} option=${option} status=${status} ` +
      `panels=${panelOpen ? 1 : 0} chain=${panel ? describeChain(panel) : '-'}`)
    return { group, option, status, urlChanged: location.search !== urlBefore, diagnostic }
  }

  await sleep(350)

  // 确认按钮也只能来自本组面板，不触碰其他分组或页面浮层。
  const confirmButton = (Array.from(panel.querySelectorAll('button, a, span, div')) as HTMLElement[]).find(
    (el) => /^(确定|确认|完成|应用)$/.test(ownText(el)) && actionable(el),
  )
  if (confirmButton) realClick(confirmButton)

  let confirmed = false
  for (let i = 0; i < 12 && !confirmed; i++) {
    const label = findGroupLabel(group)
    const currentPanel = label ? groupPanel(label) : null
    confirmed = !!label && !!currentPanel && selectionConfirmed(label, currentPanel, option)
    if (!confirmed) await sleep(200)
  }
  const urlChanged = location.search !== urlBefore
  const params = new URLSearchParams(location.search)
  const filterKeys = Array.from(params.keys()).filter((k) => !NON_FILTER_PARAMS.has(k))
  const status = confirmed ? 'ok' : 'selection_not_confirmed'
  diag('FILTER', `filter_apply group=${group} option=${option} status=${status} ` +
    `urlChanged=${urlChanged} params=${filterKeys.join(',') || '-'}`)
  if (!confirmed) {
    const label = findGroupLabel(group)
    const currentPanel = label ? groupPanel(label) : null
    const candidate = currentPanel ? findOptionInPanel(currentPanel, option) : null
    diagnostic = filterDiagnostic('selection_not_confirmed', label, currentPanel, candidate, option,
      candidate ? actionBlocker(candidate) : null)
  }
  return { group, option, status, urlChanged, ...(diagnostic ? { diagnostic } : {}) }
}

/** 标签链（tag.class，不含文案），用于面板没认出来时取证 */
function describeChain(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
    const cls = Array.from(cur.classList).slice(0, 2).map((c) => c.slice(0, 20)).join('.')
    parts.push(cls ? `${cur.tagName.toLowerCase()}.${cls}` : cur.tagName.toLowerCase())
    cur = cur.parentElement
  }
  return parts.join(' < ')
}
