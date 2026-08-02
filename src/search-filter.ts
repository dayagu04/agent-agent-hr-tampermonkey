// 搜索筛选 —— 动态读取 BOSS 搜索页的筛选选项并应用
//
// 选项内容动态读取，不在插件里写死（BOSS 改版/城市不同选项会变）；
// 应用筛选通过点击页面触发器 + 选项完成，URL 参数由 BOSS 自己的逻辑更新。
import { diag } from './logger'
import { clickDirect } from './dom-events'

export type FilterKind = 'jobCategory' | 'district'

const TRIGGER_TEXT: Record<FilterKind, string> = {
  jobCategory: '职位类型',
  district: '工作区域',
}

const OPTION_LABEL: Record<FilterKind, string> = {
  jobCategory: '职位类型',
  district: '区域',
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 4 && r.height > 4
}

function isOwnUI(el: Element): boolean {
  return (
    !!el.closest('#aah-plugin-root, .aah-root') ||
    String(el.className || '').startsWith('aah-')
  )
}

/** 点击文本触发器（如「职位类型」）并等待下拉展开 */
async function openPanel(triggerText: string): Promise<boolean> {
  const trigger = Array.from(document.querySelectorAll('span, div, a, button')).find((el) => {
    if (isOwnUI(el)) return false
    const t = (el.textContent || '').trim()
    return t === triggerText && el.children.length <= 1 && isVisible(el)
  })
  if (!trigger) {
    diag('FILTER', `未找到筛选触发器「${triggerText}」（可能不在搜索页或已改版）`)
    return false
  }
  // BOSS 的 Vue 点击 handler 对裸 .click() 常不响应，需派发完整事件序列
  clickDirect(trigger as HTMLElement)
  await delay(450)
  return true
}

function closePanel(): Promise<void> {
  document.body.click()
  return delay(250)
}

/** 快照当前所有可见的短文本 li（去重）—— 用于和面板展开后做差分 */
function snapshotVisibleLi(): Set<string> {
  const seen = new Set<string>()
  for (const li of Array.from(document.querySelectorAll('li'))) {
    if (!isVisible(li) || isOwnUI(li)) continue
    const t = (li.textContent || '').trim()
    if (t.length < 2 || t.length > 14) continue
    if (/^\d{1,3}$/.test(t)) continue // 纯数字多为徽标，跳过
    seen.add(t)
  }
  return seen
}

/**
 * 读取某筛选的候选选项（需要打开一次下拉面板）。
 * 用「展开前后可见 li 差分」取选项：面板关闭时不可见的选项是新增的，
 * 不会把岗位标签（也是可见 li，如「本科/C++」）误当选项。
 */
export async function readFilterOptions(kind: FilterKind): Promise<string[]> {
  const before = snapshotVisibleLi()
  if (!(await openPanel(TRIGGER_TEXT[kind]))) return []
  await delay(350)
  const after = snapshotVisibleLi()
  await closePanel()
  const options = Array.from(after).filter((t) => !before.has(t))
  diag('FILTER', `${OPTION_LABEL[kind]}选项 ${options.length} 个（差分）`, options.slice(0, 30))
  return options
}

/** 在页面上应用某个筛选选项（点击触发器和对应 li，BOSS 自行更新 URL） */
export async function applyFilterOption(kind: FilterKind, value: string): Promise<boolean> {
  const urlBefore = location.search
  if (!(await openPanel(TRIGGER_TEXT[kind]))) return false
  await delay(350)
  const before = snapshotVisibleLi()
  // 目标选项 = 面板展开后新增的 li 中文本精确匹配（排除展开前就可见的岗位标签）
  const target = Array.from(document.querySelectorAll('li')).find((li) => {
    if (!isVisible(li) || isOwnUI(li)) return false
    const t = (li.textContent || '').trim()
    return t === value && !before.has(value)
  })
  if (!target) {
    diag('FILTER', `面板里未找到选项「${value}」`)
    await closePanel()
    return false
  }
  clickDirect(target as HTMLElement)
  await delay(600)
  const urlAfter = location.search
  const ok = urlAfter !== urlBefore
  diag(
    'FILTER',
    `点击选项「${value}」${ok ? '，URL 已更新' : '，URL 未变化（可能已生效或点击未响应）'}: ${urlAfter}`,
  )
  return ok
}

/** 捕获当前页已生效的筛选参数（排除 query/page），供编排翻页复用 */
export function captureCurrentFilterQuery(): string {
  const p = new URLSearchParams(location.search)
  p.delete('query')
  p.delete('page')
  return p.toString()
}
