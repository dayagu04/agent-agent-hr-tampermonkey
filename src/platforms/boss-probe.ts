// BOSS 聊天页 DOM 采集模块
//
// BOSS 改版频繁，功能失效时第一步就该重新采集真实 DOM 结构再适配。
// 本模块把会话列表/消息区/头部/操作菜单的结构 dump 进导出日志，
// 挂在日志 Tab「聊天页结构」入口上，长期保留。
import { diag } from '../logger'

const text = (el: Element | null | undefined) =>
  (el?.textContent || '').replace(/\s+/g, ' ').trim()

/** 元素的紧凑描述：标签 + class + 关键几何，用于在日志里辨认节点 */
function describe(el: HTMLElement | null): string {
  if (!el) return 'null'
  const r = el.getBoundingClientRect()
  const cls = String(el.className || '').slice(0, 60)
  return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` +
    `${cls ? '.' + cls.replace(/\s+/g, '.') : ''}` +
    ` [${Math.round(r.width)}x${Math.round(r.height)}]`
}

/** 采集会话列表结构与滚动容器候选 */
function probeThreadList(): void {
  const SELS = ['.geek-item', '.user-list li', '[class*="chat-user-item"]', 'li[role="listitem"]']

  // 哪个选择器命中、命中多少
  const hits = SELS.map((s) => ({ sel: s, n: document.querySelectorAll(s).length }))
  diag('PROBE', '会话项选择器命中情况', hits)

  const items = Array.from(document.querySelectorAll(SELS.join(','))) as HTMLElement[]
  if (!items.length) {
    diag('PROBE', '未命中任何会话项，无法继续采集列表结构')
    return
  }

  // 首项的祖先链：逐层记录 overflow 与滚动尺寸，用于确定真正的滚动容器。
  // 之前的实现只认 overflowY:auto|scroll，若 BOSS 用 overlay 或滚动在更外层就找不到。
  const chain: unknown[] = []
  let cur: HTMLElement | null = items[0].parentElement
  for (let i = 0; i < 10 && cur; i++) {
    const st = getComputedStyle(cur)
    chain.push({
      lv: i,
      el: describe(cur),
      overflowY: st.overflowY,
      scrollH: cur.scrollHeight,
      clientH: cur.clientHeight,
      scrollable: cur.scrollHeight > cur.clientHeight + 4,
    })
    cur = cur.parentElement
  }
  diag('PROBE', `会话项 ${items.length} 个，首项祖先链（找滚动容器）`, chain)

  // 列表底部是否有「没有更多了」这类结束标记 —— 有它就不必靠数量稳定来判断到底
  const endMarks = Array.from(document.querySelectorAll('div,p,span'))
    .filter((e) => /没有更多|没有更多了|加载中|到底了/.test(text(e)) && text(e).length < 20)
    .slice(0, 5)
    .map((e) => ({ el: describe(e as HTMLElement), t: text(e) }))
  diag('PROBE', '列表结束标记候选', endMarks)

  // 首项内部结构：删除功能要找的「···」按钮就在这里面
  const first = items[0]
  diag('PROBE', '首个会话项自身', { el: describe(first), text: text(first).slice(0, 60) })
  const inner = Array.from(first.querySelectorAll('*'))
    .slice(0, 30)
    .map((e) => ({ el: describe(e as HTMLElement), t: text(e).slice(0, 20) }))
  diag('PROBE', '首个会话项内部节点（找操作按钮）', inner)
}

/** 采集消息区结构：确认消息是否懒加载、滚动容器在哪 */
function probeMessagePanel(): void {
  const msgs = Array.from(document.querySelectorAll('span.text-content, .text-content'))
  diag('PROBE', `消息文本节点 ${msgs.length} 个`)
  if (!msgs.length) {
    diag('PROBE', '当前未打开会话或消息区为空，跳过消息区采集')
    return
  }

  const chain: unknown[] = []
  let cur: HTMLElement | null = (msgs[0] as HTMLElement).parentElement
  for (let i = 0; i < 10 && cur; i++) {
    const st = getComputedStyle(cur)
    chain.push({
      lv: i,
      el: describe(cur),
      overflowY: st.overflowY,
      scrollTop: cur.scrollTop,
      scrollH: cur.scrollHeight,
      clientH: cur.clientHeight,
      scrollable: cur.scrollHeight > cur.clientHeight + 4,
    })
    cur = cur.parentElement
  }
  diag('PROBE', '消息节点祖先链（找消息区滚动容器）', chain)

  // 「加载更多历史消息」入口：若存在说明消息区确实分页
  const more = Array.from(document.querySelectorAll('div,span,a'))
    .filter((e) => /查看更多|加载更多|历史消息|more/i.test(text(e)) && text(e).length < 20)
    .slice(0, 5)
    .map((e) => ({ el: describe(e as HTMLElement), t: text(e) }))
  diag('PROBE', '历史消息加载入口候选', more)
}

/**
 * 采集会话项的操作菜单结构。
 *
 * 分别试「悬浮」与「右键」两种触发，各自 dump 前后 DOM 差异，
 * 从而确定「删除」到底挂在哪里、需要什么事件序列才出现。
 */
async function probeThreadMenu(): Promise<void> {
  const first = document.querySelector(
    '.geek-item, .user-list li, [class*="chat-user-item"], li[role="listitem"]',
  ) as HTMLElement | null
  if (!first) {
    diag('PROBE', '无会话项，跳过菜单采集')
    return
  }

  // 首项完整 outerHTML：直接看悬停框的真实标签与 class，不必再猜
  // （截断 3000 字符防灌满日志）
  const html = first.outerHTML || ''
  diag('PROBE', `首项 outerHTML（${html.length} 字符，截断 3000）`, html.slice(0, 3000))

  // dump Vue 实例的可用字段，确认悬停态标志位该改哪个
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vm = (first as any).__vue__
  if (vm) {
    const own = Object.keys(vm).filter((k) => !k.startsWith('_') && !k.startsWith('$'))
    diag('PROBE', 'Vue 实例可用字段（找悬停标志位）', {
      keys: own.slice(0, 30),
      // 布尔字段最可能是显隐开关，单独列出
      booleans: own.filter((k) => typeof vm[k] === 'boolean').slice(0, 20),
      methods: Object.keys(vm)
        .filter((k) => typeof vm[k] === 'function' && /hover|enter|mouse|operate|more/i.test(k))
        .slice(0, 12),
    })
  } else {
    diag('PROBE', '会话项无 __vue__（BOSS 可能升级到 Vue3，需改用 __vueParentComponent）')
  }

  // 对比 hover 前后的节点差异：证明按钮是条件渲染还是 CSS 隐藏
  const before = new Set(Array.from(first.querySelectorAll('*')))
  const r0 = first.getBoundingClientRect()
  // 按钮位于会话项右下角
  const hb = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: Math.round(r0.right - 20),
    clientY: Math.round(r0.bottom - 16),
  }
  first.dispatchEvent(new MouseEvent('mouseover', hb))
  first.dispatchEvent(new MouseEvent('mouseenter', hb))
  first.dispatchEvent(new MouseEvent('mousemove', hb))
  await new Promise((res) => setTimeout(res, 500))
  const added = (Array.from(first.querySelectorAll('*')) as HTMLElement[]).filter(
    (e) => !before.has(e),
  )
  diag('PROBE', `hover 右下角后新增节点 ${added.length} 个（>0 = 条件渲染）`,
    added.map((e) => ({ el: describe(e), t: text(e).slice(0, 12) })).slice(0, 15))

  // 该坐标处最上层是什么（这是 realClick 实际会点到的东西）
  const atCorner2 = document.elementFromPoint(hb.clientX, hb.clientY) as HTMLElement | null
  diag('PROBE', '右下角坐标处最上层元素', {
    el: describe(atCorner2),
    inItem: atCorner2 ? first.contains(atCorner2) : false,
    t: text(atCorner2).slice(0, 20),
  })

  const snapshot = () => document.querySelectorAll('*').length
  const findDelete = () =>
    Array.from(document.querySelectorAll('*'))
      .filter((e) => /^删除$/.test(text(e)))
      .map((e) => {
        const el = e as HTMLElement
        const r = el.getBoundingClientRect()
        return {
          el: describe(el),
          visible: r.width > 0 && r.height > 0,
          inThreadItem: first.contains(el),
          parent: describe(el.parentElement),
        }
      })

  diag('PROBE', '菜单采集前「删除」节点', findDelete())

  const r = first.getBoundingClientRect()
  const wait = (ms: number) => new Promise((res) => setTimeout(res, ms))

  // 触发 1：悬浮整项中心
  const mid = { bubbles: true, cancelable: true, composed: true,
    clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) }
  const n0 = snapshot()
  first.dispatchEvent(new MouseEvent('mouseover', mid))
  first.dispatchEvent(new MouseEvent('mouseenter', mid))
  first.dispatchEvent(new MouseEvent('mousemove', mid))
  await wait(400)
  diag('PROBE', 'hover 会话项中心后', {
    domDelta: snapshot() - n0,
    del: findDelete(),
    inner: Array.from(first.querySelectorAll('*'))
      .map((e) => ({ el: describe(e as HTMLElement), t: text(e).slice(0, 12) }))
      .filter((x) => /more|operate|action|dot|menu|icon/i.test(x.el) || /···|\.\.\.|…/.test(x.t))
      .slice(0, 10),
  })

  // 触发 2：悬浮右上角（操作按钮出现在这一带）
  const corner = { bubbles: true, cancelable: true, composed: true,
    clientX: Math.round(r.right - 24), clientY: Math.round(r.top + 18) }
  const n1 = snapshot()
  first.dispatchEvent(new MouseEvent('mouseover', corner))
  first.dispatchEvent(new MouseEvent('mousemove', corner))
  await wait(400)
  const atCorner = document.elementFromPoint(corner.clientX, corner.clientY) as HTMLElement | null
  diag('PROBE', 'hover 右上角后', {
    domDelta: snapshot() - n1,
    elementAtPoint: describe(atCorner),
    atPointText: text(atCorner).slice(0, 20),
    del: findDelete(),
  })

  // 触发 3：右键
  const n2 = snapshot()
  first.dispatchEvent(new MouseEvent('contextmenu', mid))
  await wait(400)
  diag('PROBE', '右键后', { domDelta: snapshot() - n2, del: findDelete() })

  // 收尾：移开鼠标，避免留下悬浮态影响后续操作
  first.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
  first.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
}

/**
 * 采集会话头部结构。
 *
 * 动机：日志里反复出现「头部公司名提取失败」（谭晓钥、曹婕两例），
 * 这类会话的 company 变成 "-"，后端按公司名匹配投递记录必然失败。
 */
function probeHeader(): void {
  const pos = document.querySelector('span.position-name, .position-name') as HTMLElement | null
  if (!pos) {
    diag('PROBE', '未找到 position-name，跳过头部采集')
    return
  }
  const chain: unknown[] = []
  let cur: HTMLElement | null = pos.parentElement
  for (let i = 0; i < 6 && cur; i++) {
    chain.push({ lv: i, el: describe(cur), spanCount: cur.querySelectorAll('span').length })
    cur = cur.parentElement
  }
  diag('PROBE', 'position-name 祖先链', chain)
}

/** 采集全量结构，结果进导出日志 */
export async function probeChatPage(): Promise<void> {
  diag('PROBE', '=== 开始采集 BOSS 聊天页结构 ===', {
    url: location.pathname,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  })
  probeThreadList()
  probeMessagePanel()
  probeHeader()
  await probeThreadMenu()
  diag('PROBE', '=== 采集结束，请导出日志 ===')
}
