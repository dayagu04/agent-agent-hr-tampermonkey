// 面向开发的结构化 DOM 采集器 —— 不猜选择器，把真实页面结构落进日志
//
// 已知选择器优先，未知区域用 class 关键词「发现」而非猜测；输出结构化摘要
// （tag/class/关键属性/文本/子结构），够重建选择器又不让日志爆炸。

/** 单个节点的结构化摘要 */
interface DomNodeInfo {
  tag: string              // 标签名，如 div
  cls: string[]            // 完整 class 列表
  id: string
  attrs: Record<string, string>  // 关键属性（href/aria-label/role/data-* 等）
  text: string             // 直接文本摘要（截断 80）
  children: DomNodeInfo[]  // 子节点摘要（限深/限量）
}

/** 一次采集的结果 */
interface DomCollection {
  label: string        // 如「岗位卡片 ×15」
  selector: string     // 命中选择器
  count: number        // 命中总数
  items: DomNodeInfo[] // 详细条目（前 limit 个深采）
  sampledAt: number
}

/** 当前页一次完整采集 */
interface PageDomCollection {
  url: string
  title: string
  collections: DomCollection[]
  sampledAt: number
}

const KEY_ATTRS = [
  'href', 'aria-label', 'role', 'title', 'placeholder', 'type',
  'data-id', 'data-v', 'data-role', 'data-index', 'data-code',
]

function describeEl(el: Element, depth: number, maxDepth: number, maxChildren: number): DomNodeInfo {
  const attrs: Record<string, string> = {}
  for (const a of KEY_ATTRS) {
    const v = el.getAttribute(a)
    if (v) attrs[a] = v.slice(0, 60)
  }
  const ownText = Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => (n.textContent || '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
  const children = depth < maxDepth
    ? Array.from(el.children).slice(0, maxChildren).map((c) =>
        describeEl(c, depth + 1, maxDepth, maxChildren),
      )
    : []
  return {
    tag: el.tagName.toLowerCase(),
    cls: String(el.className || '').split(/\s+/).filter(Boolean),
    id: el.id || '',
    attrs,
    text: ownText,
    children,
  }
}

/** 收集匹配某选择器的元素：前 limit 个深采，其余只数总数 */
function collectMatches(
  label: string,
  selector: string,
  opts: { limit?: number; maxDepth?: number } = {},
): DomCollection {
  const { limit = 5, maxDepth = 3 } = opts
  const els = Array.from(document.querySelectorAll(selector))
  return {
    label: `${label} ×${els.length}`,
    selector,
    count: els.length,
    items: els.slice(0, limit).map((el) => describeEl(el, 0, maxDepth, 8)),
    sampledAt: Date.now(),
  }
}

/** 可见性判断：有实际尺寸才收，隐藏模板节点不收 */
function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 4 && r.height > 4
}

/** 排除插件自身 UI（面板/悬浮球），避免采集结果混进自己的 DOM */
function isOwnUI(el: Element): boolean {
  return !!el.closest('#aah-plugin-root, .aah-root') ||
    String(el.className || '').startsWith('aah-')
}

/**
 * 分页控件发现采集：不猜具体选择器，按 class 关键词 + 文本关键词扫全页候选。
 * 收集可见的、class 含 pagi/page/pager/turn/next 或文本含「下一页/尾页/页码/纯数字」的元素。
 */
function collectPagination(): DomCollection {
  const PAGE_CLASS = /pagi|page|pager|turn|next|prev|页码/i
  const PAGE_TEXT = /下一页|上一页|尾页|首页|第\s*\d+\s*页|\d+\s*\/\s*\d+|^\s*\d{1,3}\s*$/i
  const candidates = new Set<Element>()

  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (!isVisible(el)) continue
    if (isOwnUI(el)) continue
    const cls = String(el.className || '')
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent || '').trim())
      .join(' ')
    if (PAGE_CLASS.test(cls) || PAGE_TEXT.test(ownText)) {
      // 只收「叶子级」候选（自身有文本 或 子元素 ≤ 3），避免把外层大容器全捞进来
      if (ownText || el.children.length <= 3) candidates.add(el)
    }
  }
  // 兜底：可点元素里文本含翻页词（a/button/li）
  for (const el of Array.from(document.querySelectorAll('a, button, [role="button"], li'))) {
    if (!isVisible(el)) continue
    if (isOwnUI(el)) continue
    const t = (el.textContent || '').trim()
    if (PAGE_TEXT.test(t)) candidates.add(el)
  }

  const items = Array.from(candidates).slice(0, 12).map((el) =>
    describeEl(el, 0, 2, 6),
  )
  return {
    label: `分页控件候选 ×${candidates.size}`,
    selector: 'class 关键词/文本关键词发现',
    count: candidates.size,
    items,
    sampledAt: Date.now(),
  }
}

/** 岗位卡片采集：已知可用选择器优先，无命中再用 class 关键词发现 */
function collectJobCards(): DomCollection {
  const known = collectMatches('岗位卡片', '.job-card-wrap', { limit: 5, maxDepth: 4 })
  if (known.count > 0) return known
  const hint = /job-card|joblist|job-item|job-info/i
  const els = Array.from(document.querySelectorAll('*')).filter((el) =>
    isVisible(el) && !isOwnUI(el) && hint.test(String(el.className || '')),
  )
  return {
    label: `岗位卡片（发现模式）×${els.length}`,
    selector: '[class*=job-card|joblist|job-item]',
    count: els.length,
    items: els.slice(0, 5).map((el) => describeEl(el, 0, 3, 8)),
    sampledAt: Date.now(),
  }
}

/** 聊天会话列表采集（复用 boss-chat 已知的会话项候选选择器） */
function collectChatThreads(): DomCollection {
  const sels = ['.geek-item', '.user-list li', '[class*="chat-user-item"]', 'li[role="listitem"]']
  for (const s of sels) {
    // 深采到 name-box 的子元素（vline 后的公司/职位元素），供后续精确适配
    const c = collectMatches('聊天会话', s, { limit: 5, maxDepth: 5 })
    if (c.count > 0) return c
  }
  return {
    label: '聊天会话 ×0',
    selector: sels.join(' | '),
    count: 0,
    items: [],
    sampledAt: Date.now(),
  }
}

/** 按当前页面自动选择采集目标 */
function collectCurrentPage(): PageDomCollection {
  const path = window.location.pathname
  const collections: DomCollection[] = []
  if (/\/web\/geek\/jobs/.test(path) || /\/web\/geek\/job/.test(path)) {
    collections.push(collectJobCards(), collectPagination())
  } else if (/\/web\/geek\/chat/.test(path)) {
    collections.push(collectChatThreads())
  } else {
    collections.push(collectMatches('整页可见元素采样', 'div[class], li[class]', { limit: 20, maxDepth: 2 }))
  }
  return {
    url: location.href,
    title: document.title,
    collections,
    sampledAt: Date.now(),
  }
}

/** 把一次采集格式化成可复制的文本行（供面板 DOM 采集区展示） */
function formatCollection(c: DomCollection): string[] {
  const lines: string[] = []
  lines.push(`[DOM] ${c.label}  ← ${c.selector}`)
  c.items.forEach((it, i) => {
    lines.push(`  ${i + 1}. ${nodeBrief(it)}`)
    pushChildren(it.children, lines, '     ')
  })
  return lines
}

function nodeBrief(n: DomNodeInfo): string {
  const cls = n.cls.length ? '.' + n.cls.slice(0, 3).join('.') : ''
  const id = n.id ? '#' + n.id : ''
  const attrs = Object.entries(n.attrs)
    .map(([k, v]) => `[${k}="${v}"]`)
    .join('')
  const text = n.text ? ` "${n.text}"` : ''
  return `${n.tag}${cls}${id}${attrs}${text}`
}

function pushChildren(children: DomNodeInfo[], lines: string[], indent: string): void {
  for (const c of children.slice(0, 6)) {
    lines.push(`${indent}├─ ${nodeBrief(c)}`)
    if (c.children.length) pushChildren(c.children, lines, indent + '   ')
  }
}

/** 采集当前页并输出（面板调用；同时往行为日志写一行摘要） */
export function collectAndLogDom(): string[] {
  const page = collectCurrentPage()
  const lines: string[] = []
  lines.push(`[DOM] 采集时间 ${new Date(page.sampledAt).toLocaleTimeString()}`)
  lines.push(`[DOM] URL ${page.url}`)
  lines.push(`[DOM] 标题 ${page.title}`)
  for (const c of page.collections) {
    lines.push(...formatCollection(c))
  }
  return lines
}
