// DOM 结构探针 —— 通用定位工具，替代「猜选择器」
//
// BOSS/智联改版频繁，靠硬编码 class 猜选择器不可持续。本模块提供基于
// 「文本/角色」的通用定位，这类定位比 class 稳定（"发简历"比 .btn-resume-xxx
// 更不容易变），并把页面真实结构 dump 出来供适配。

/** 元素摘要 */
export interface NodeBrief {
  tag: string
  cls: string
  text: string
  rect: string
  depth: number
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/**
 * Dump 指定区域的可见元素结构（限制条数与文本长度，避免日志爆炸）。
 *
 * @param root      起点，默认 body
 * @param maxNodes  最多输出多少节点
 */
export function dumpStructure(root: Element = document.body, maxNodes = 60): NodeBrief[] {
  const out: NodeBrief[] = []
  const walk = (el: Element, depth: number) => {
    if (out.length >= maxNodes || depth > 12) return
    if (!visible(el) || isOwnUI(el)) return // 跳过插件自身 UI，否则 dump 全是自己的面板

    const kids = Array.from(el.children)
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent || '').trim())
      .join(' ')
      .slice(0, 40)

    // 只记录有自身文本或是叶子容器的节点，减少噪声
    if (ownText || kids.length === 0) {
      const r = el.getBoundingClientRect()
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: String((el as HTMLElement).className || '').slice(0, 60),
        text: ownText,
        rect: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        depth,
      })
    }
    for (const k of kids) walk(k, depth + 1)
  }
  walk(root, 0)
  return out
}

/** 是否属于插件自身 UI（必须排除，否则会把自己的面板当成页面内容） */
function isOwnUI(el: Element): boolean {
  return !!el.closest('.aah-root')
}

/**
 * 找聊天消息面板。
 *
 * 聊天区的可靠特征是「包含消息输入框」：从输入框往上找到既高又宽的祖先，
 * 即消息区所在容器（按面积取最大容器会选中插件自己的悬浮面板）。
 */
export function findChatPanel(): HTMLElement | null {
  const input = findEditable()
  if (input) {
    // 从输入框向上找：第一个高度 > 视口 40% 的祖先，通常就是会话主容器
    let cur: HTMLElement | null = input.parentElement
    while (cur && cur !== document.body) {
      if (isOwnUI(cur)) break
      const r = cur.getBoundingClientRect()
      if (r.height > window.innerHeight * 0.4 && r.width > 300) return cur
      cur = cur.parentElement
    }
  }

  // 兜底：面积最大的非插件容器（排除自身 UI 后再比）
  let best: HTMLElement | null = null
  let bestArea = 0
  for (const el of Array.from(document.querySelectorAll('div, section, main'))) {
    if (isOwnUI(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 300 || r.height < 300) continue
    const area = r.width * r.height
    if (area > bestArea) {
      bestArea = area
      best = el as HTMLElement
    }
  }
  return best
}

/**
 * 按可见文本找元素（通用，抗改版）。
 *
 * @param pattern  文本匹配（精确串或正则）
 * @param opts.clickable 只要可点击元素（button/a/带 role/带 cursor:pointer）
 */
export function findByText(
  pattern: string | RegExp,
  opts: { clickable?: boolean; root?: ParentNode; exclude?: RegExp } = {},
): HTMLElement | null {
  const root = opts.root || document
  const re = typeof pattern === 'string' ? new RegExp(`^${pattern}$`) : pattern
  const cands = Array.from(root.querySelectorAll('*')) as HTMLElement[]

  for (const el of cands) {
    if (!visible(el) || isOwnUI(el)) continue
    // 只取自身文本，避免父容器因为包含子文本而误命中
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent || '').trim())
      .join('')
      .replace(/\s/g, '')
    if (!own || !re.test(own)) continue
    if (opts.exclude && opts.exclude.test(own)) continue

    if (opts.clickable) {
      const tag = el.tagName.toLowerCase()
      const style = getComputedStyle(el)
      const isClickable =
        tag === 'button' ||
        tag === 'a' ||
        el.getAttribute('role') === 'button' ||
        style.cursor === 'pointer'
      if (!isClickable) {
        // 向上找最近的可点击祖先
        const anc = el.closest('button, a, [role=button]') as HTMLElement | null
        if (anc && visible(anc)) return anc
        continue
      }
    }
    return el
  }
  return null
}

/** 找可输入元素（textarea / contenteditable），按面积取最大的 */
export function findEditable(root: ParentNode = document): HTMLElement | null {
  const cands = Array.from(
    root.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]'),
  ) as HTMLElement[]
  let best: HTMLElement | null = null
  let bestArea = 0
  for (const el of cands) {
    if (!visible(el) || isOwnUI(el)) continue
    const r = el.getBoundingClientRect()
    const area = r.width * r.height
    if (area > bestArea) {
      bestArea = area
      best = el
    }
  }
  return best
}
