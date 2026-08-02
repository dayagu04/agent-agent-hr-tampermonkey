// BOSS 会话删除：唤出列表项「···」操作按钮 + 定位弹层「删除」项
//
// 为什么独立成文件：删除链路已返工多轮，且 boss-chat.ts 同时在被其它改动触碰。
// 把这条链路的全部知识收在一处，boss-chat.ts 只留两个调用点。
//
// ── 2026-08-01 由用户手动删除的 DOM 监控日志推翻的旧结论 ─────────────
// 旧注释说「按钮是 Vue 条件渲染，不悬停时不在 DOM 里，注入 CSS 无效」。**错的**。
// 失败日志里这三个节点一直都在：
//     div.user-operation[0x0]
//     img.icon-operate list-operat[0x0]   ← .list-operate
//     img.icon-operate list-operat[0x0]   ← .list-operate-hover
// 它们存在，只是被 CSS 压成 0 尺寸。真正的两个原因是：
//   1) 旧 findBtn() 用 `r.width > 0 && r.height > 0` 过滤，0 尺寸节点全被丢弃 ——
//      按钮就在手上却从没被返回过；
//   2) 尺寸闸门是 CSS `:hover`（手动日志：一悬停 .user-operation 变 18x20，
//      图标从 list-operate 换成 list-operate-hover）。**合成鼠标事件永远
//      触发不了 CSS :hover** —— dispatchEvent 不改变浏览器的悬停状态机。
//      所以派发 mouseenter/mouseover 那条路在原理上就不可能成功，
//      而 Vue 的 operationActive / hoverUniqueId 管的是**弹出菜单**、不是图标显隐。
// 结论：正确解法是注入 CSS 覆盖掉 :hover 那道闸门，把按钮变成常态可见 + 可点。
import { diag } from '../logger'

const STYLE_ID = 'aah-force-operate-style'
/** 只作用在打了标记的那一行，避免整列表 40 行图标全亮 */
const MARK_CLASS = 'aah-op-target'

/** 注入一次性样式：把标记行的操作按钮从 0 尺寸强制撑开为可见可点 */
function ensureForceStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const st = document.createElement('style')
  st.id = STYLE_ID
  // 覆盖 :hover 闸门：display/visibility/opacity/尺寸 四样都要管 ——
  // 只改 width/height 时若原规则是 display:none 依然点不到。
  //
  // 关键（2026-08-02 取证修正）：`.user-operation` 里有**两张图**
  // （`.list-operate` 常态 / `.list-operate-hover` 悬停态），BOSS 原本二选一显示。
  // 上一版把两张都强制显示，结果常态那张叠在同一坐标上把点击截走 ——
  // 取证里 `elementAtIconCenter` 返回 `.list-operate` 而非 `.list-operate-hover`，
  // 于是"点···"点在了错的图上，菜单不生成（operationContainers:0）；
  // 用户界面上也变成了两个按钮。故必须显式把常态那张藏掉。
  st.textContent =
    `.${MARK_CLASS} .user-operation{display:flex!important;visibility:visible!important;` +
    `opacity:1!important;width:18px!important;height:20px!important;pointer-events:auto!important}` +
    `.${MARK_CLASS} .user-operation img.list-operate{display:none!important}` +
    `.${MARK_CLASS} .user-operation img.list-operate-hover{display:inline-block!important;` +
    `visibility:visible!important;opacity:1!important;width:18px!important;height:18px!important;` +
    `pointer-events:auto!important}`
  document.head.appendChild(st)
}

/** 强制展开被折叠的头部下拉菜单所用的标记 */
const MARK_MENU = 'aah-menu-target'

/** 注入头部菜单的强制展开样式（与列表按钮那套分开，互不影响） */
function ensureMenuStyle(): void {
  const id = `${STYLE_ID}-menu`
  if (document.getElementById(id)) return
  const st = document.createElement('style')
  st.id = id
  st.textContent =
    `.${MARK_MENU}{display:block!important;visibility:visible!important;opacity:1!important;` +
    `pointer-events:auto!important;max-height:none!important;overflow:visible!important}`
  document.head.appendChild(st)
}

/** 清掉标记（把这一行恢复成 BOSS 原本的悬停行为） */
export function unmarkOperateRow(item: HTMLElement): void {
  item.classList.remove(MARK_CLASS)
  for (const e of Array.from(item.querySelectorAll(`.${MARK_CLASS}`))) {
    e.classList.remove(MARK_CLASS)
  }
}

/**
 * 唤出会话项的「···」操作按钮，返回可点的那个节点。
 *
 * 与旧实现的根本差别：不再试图"制造 hover"，而是用注入 CSS 直接绕过 :hover 闸门；
 * 并且**允许 0 尺寸节点**作为兜底返回值（撑开失败也照样能收到 dispatch 的 click）。
 */
export async function revealOperateBtn(item: HTMLElement): Promise<HTMLElement | null> {
  ensureForceStyle()
  // 标记打在会话项和它的 .user-operation 祖先链上：BOSS 的 .user-operation
  // 位于 .gray.last-msg 内，标记在最外层即可被后代选择器覆盖。
  item.classList.add(MARK_CLASS)

  const pick = (): HTMLElement | null => {
    // 优先顺序：悬停态图标 > 任意操作图标 > 容器本身。
    // 容器也可接受：它 18x20 且 pointer-events 已放开，点它同样冒泡到 handler。
    const sels = [
      'img.list-operate-hover',
      '.user-operation img.icon-operate',
      '.user-operation img',
      '.user-operation',
    ]
    for (const s of sels) {
      const el = item.querySelector(s) as HTMLElement | null
      if (el) return el
    }
    return null
  }

  // 等 CSS 生效并让布局刷新（0→18px 是重排，需要一帧）
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 90))
    const el = pick()
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      diag('CHAT', 'revealOperateBtn 已撑开按钮', {
        el: `${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 30)}`,
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      })
      return el
    }
  }

  // 撑开失败也返回节点：0 尺寸元素依然能接收 dispatchEvent 派发的 click，
  // 只是 elementFromPoint 那条路不可用（调用方需用直接派发的点击）。
  const fallback = pick()
  if (fallback) {
    diag('CHAT', 'revealOperateBtn 未能撑开尺寸，返回 0 尺寸节点直接派发点击', {
      el: `${fallback.tagName.toLowerCase()}.${String(fallback.className || '').slice(0, 30)}`,
    })
  }
  return fallback
}

/** 像 boss 对象的东西：必须带 securityId（deleteBoss 内部读的就是它） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function looksLikeBoss(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.securityId === 'string'
}

/**
 * 在组件实例上找该行的 boss 对象。
 *
 * 只搜**该实例自己**的 data / $props / $attrs，**不往 $parent 爬**：
 * 父组件（列表容器）上挂着 `currentBoss`、`list$` 之类 —— 那是"当前选中的会话"
 * 或整个列表，拿它去 deleteBoss() 会删错人且不可撤回。宁可放弃这条路，
 * 让流程降级到头部菜单。
 *
 * 返回路径字符串仅用于日志；**不往 BOSS 的对象上写任何字段**
 * （那是 Vue 响应式数据，写进去可能触发重渲染甚至被带去服务端）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findBossObject(vm: any): { obj: any; path: string } | null {
  // 直接命中的常见键名（先试，省去遍历）
  for (const k of ['boss', 'friend', 'item', 'data', 'conversation', 'chat', 'row']) {
    if (looksLikeBoss(vm?.[k])) return { obj: vm[k], path: k }
    if (looksLikeBoss(vm?.$props?.[k])) return { obj: vm.$props[k], path: `$props.${k}` }
  }
  // 兜底：扫一遍自有键（不含 _/$ 前缀的内部字段）
  for (const src of [
    { o: vm, p: '' },
    { o: vm?.$props, p: '$props.' },
    { o: vm?.$attrs, p: '$attrs.' },
  ]) {
    if (!src.o || typeof src.o !== 'object') continue
    for (const k of Object.keys(src.o)) {
      if (!src.p && (k.startsWith('_') || k.startsWith('$'))) continue
      try {
        if (looksLikeBoss(src.o[k])) return { obj: src.o[k], path: `${src.p}${k}` }
      } catch {
        /* getter 可能抛，跳过 */
      }
    }
  }
  return null
}

/**
 * 直接调用会话行组件自己的 `deleteBoss()`。
 *
 * 为什么这是首选（2026-08-02）：前两版都卡在「点了图标但菜单不生成」
 * （取证 `operationContainers:0`）—— BOSS 的图标 click handler 似乎还依赖
 * 真实 hover 建立的中间态，合成事件造不出来。而用户的手动监控日志显示，
 * `div.gray.last-msg` 的 Vue 实例上直接挂着这些方法：
 *     deleteBoss / deleteGroup / setHoverActive / setTop / handleMouseenter
 * `deleteBoss()` 就是「删除」菜单项最终调用的东西，直接调它可以完全跳过
 * 「唤按钮 → 点图标 → 等浮层 → 点删除」这四步不确定性。
 *
 * 为什么比头部菜单安全：这个组件实例**就是目标那一行**，它的 `deleteBoss()`
 * 作用于自己的数据，不存在「删错会话」的可能。而头部菜单作用于「当前打开的
 * 会话」，需要额外的身份核对才敢用。
 *
 * 仍然保留后续路径：BOSS 可能改名或改签名，调用失败就往下走。
 * 删除确认弹窗由调用方处理 —— 它同时也是一道天然的检查点。
 *
 * @returns 是否成功调用（不代表已删除，删除结果由调用方校验列表）
 */
export function deleteViaRowVue(item: HTMLElement): boolean {
  // 组件实例挂在 .gray.last-msg 上（监控日志实证），不在 li 或 .friend-content 上
  const hosts = [
    item.querySelector('.gray.last-msg'),
    item.querySelector('.last-msg'),
    item.querySelector('.friend-content'),
    item,
  ].filter(Boolean) as HTMLElement[]

  for (const host of hosts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vm = (host as any).__vue__
    if (!vm) continue
    if (typeof vm.deleteBoss !== 'function') continue

    // deleteBoss() 需要 boss 对象参数。
    //
    // 实测（2026-08-02）：空手调用抛
    // `Cannot read properties of undefined (reading 'securityId')`
    // —— 函数体里读的是 `参数.securityId`。所以必须把这一行的 boss 对象找出来传进去。
    //
    // 不写死键名：用「带 securityId 的对象」作为特征去搜，BOSS 改字段名也不会失效。
    const found = findBossObject(vm)
    if (!found) {
      diag('CHAT', 'deleteViaRowVue 未能定位该行的 boss 对象（含 securityId），跳过 Vue 路径', {
        vmKeys: Object.keys(vm)
          .filter((k) => !k.startsWith('_') && !k.startsWith('$'))
          .slice(0, 20),
      })
      continue
    }

    // 安全校验：boss 对象的姓名必须出现在这一行的可见文本里。
    // 万一 findBossObject 拿到的是别的会话（父组件的 currentBoss 之类），
    // 这道校验就拦住了 —— 删除不可撤回，宁可降级到头部菜单也不能删错人。
    const bossName = String(found.obj.name || found.obj.bossName || '').replace(/\s/g, '')
    const rowText = (item.textContent || '').replace(/\s/g, '')
    if (bossName && !rowText.includes(bossName)) {
      diag('CHAT', 'deleteViaRowVue 已放弃：boss 对象与本行不匹配（防删错）', {
        bossName,
        rowText: rowText.slice(0, 40),
        path: found.path,
      })
      continue
    }

    try {
      vm.deleteBoss(found.obj)
      diag('CHAT', 'deleteViaRowVue 已调用行组件 deleteBoss(boss)', {
        host: `${host.tagName.toLowerCase()}.${String(host.className || '').slice(0, 30)}`,
        bossFrom: found.path,
        // 打出身份字段便于事后核对「删的是不是这一行」
        name: bossName || '-',
        securityId: String(found.obj.securityId || '').slice(0, 10) + '…',
      })
      return true
    } catch (e) {
      diag('CHAT', `deleteViaRowVue 调用 deleteBoss() 抛异常: ${(e as Error).message}`)
    }
  }
  diag('CHAT', 'deleteViaRowVue 未找到带 deleteBoss() 的行组件实例')
  return false
}

/**
 * 该元素中心点处最上层的节点是否就是它自己（或它的后代）。
 *
 * 用途：realClick() 会把点击转投到 elementFromPoint 的结果上。若那个结果不是
 * 目标元素，点击就打在了别的东西上 —— 实测（2026-08-02）`.list-operate` 叠在
 * `.list-operate-hover` 同一坐标，导致"点···"点到了错的图上、菜单不生成。
 * 调用方据此决定用 realClick 还是 clickDirect。
 */
export function isTopmostAtCenter(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return false
  const hit = document.elementFromPoint(
    Math.round(r.left + r.width / 2),
    Math.round(r.top + r.height / 2),
  )
  return !!hit && (hit === el || el.contains(hit))
}

/**
 * 直接对元素派发点击，不经 elementFromPoint。
 *
 * 为什么需要它：realClick() 会把点击转投到坐标处最上层的元素，这对 0 尺寸节点是
 * 灾难 —— 它的中心点落在会话项上，于是"点···"变成了"点会话项"（表现为菜单不出、
 * 却切换了会话）。按钮已撑开时用 realClick 没问题，撑不开时必须用这个。
 */
export function clickDirect(el: HTMLElement): void {
  const r = el.getBoundingClientRect()
  const x = Math.round(r.left + (r.width || 1) / 2)
  const y = Math.round(r.top + (r.height || 1) / 2)
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }
  const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }
  try {
    el.dispatchEvent(new PointerEvent('pointerover', ptr as PointerEventInit))
    el.dispatchEvent(new PointerEvent('pointerenter', ptr as PointerEventInit))
    el.dispatchEvent(new PointerEvent('pointerdown', ptr as PointerEventInit))
  } catch {
    /* 老浏览器无 PointerEvent */
  }
  el.dispatchEvent(new MouseEvent('mouseover', base))
  el.dispatchEvent(new MouseEvent('mouseenter', base))
  el.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 0, buttons: 1 }))
  try {
    el.dispatchEvent(new PointerEvent('pointerup', { ...ptr, buttons: 0 } as PointerEventInit))
  } catch {
    /* ignore */
  }
  el.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('click', { ...base, button: 0, detail: 1 }))
  try {
    el.click()
  } catch {
    /* ignore */
  }
}

const isVisible = (el: HTMLElement): boolean => {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return false
  const st = getComputedStyle(el)
  return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) >= 0.1
}

/**
 * 在已弹出的操作浮层里找「删除」。
 *
 * 关键改动：**把搜索范围限定在 `.operation-container` 内**。
 * 旧实现全文档找文本等于「删除」的叶子节点，而会话头部还常驻一个折叠的 6 项菜单
 * （置顶/备注/不感兴趣/黑名单/删除/举报，见日志里的头部 span dump）——
 * 那里的「删除」同样可能通过可见性筛查，点了却作用在**当前打开的会话**上，
 * 而不是我们要删的那一行。范围限定是这条链路的安全red line。
 *
 * 浮层结构（手动监控日志实证）：
 *   div.operation-container[120x84] > div.operation-content[120x76] > div.operation-item[112x38]
 * 返回 .operation-item 而非里面的 svg/文本：手动点击落在 svg 上，但点 item 一样冒泡。
 */
export function findDeleteItemInPopup(): HTMLElement | null {
  const containers = Array.from(
    document.querySelectorAll('.operation-container'),
  ) as HTMLElement[]
  for (const box of containers) {
    if (!isVisible(box)) continue
    const items = Array.from(box.querySelectorAll('.operation-item')) as HTMLElement[]
    for (const it of items) {
      if (!isVisible(it)) continue
      if ((it.textContent || '').replace(/\s/g, '') === '删除') return it
    }
    // 结构变了就退回「浮层内含『删除』的最小可见节点」，仍不越出浮层范围
    const leaves = (Array.from(box.querySelectorAll('*')) as HTMLElement[]).filter(
      (e) => !e.querySelector('*') && (e.textContent || '').replace(/\s/g, '') === '删除',
    )
    for (const lf of leaves) {
      if (isVisible(lf)) return (lf.parentElement as HTMLElement) || lf
    }
  }
  return null
}

/**
 * 失败时的一次性取证。
 *
 * 目的：把「下一步该怎么改」所需的全部事实一次拿齐，不再让用户反复手动复现。
 * 最关键的一项是 rowHTML —— 有它就能直接看清 .user-operation 的真实结构与内联样式，
 * 前几轮全靠猜 class 名就是因为没取过这个。
 */
export function dumpDeleteDiagnostics(item: HTMLElement, phase: string): void {
  const styleOf = (el: HTMLElement | null) => {
    if (!el) return null
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      cls: String(el.className || '').slice(0, 40),
      display: s.display,
      visibility: s.visibility,
      opacity: s.opacity,
      w: s.width,
      h: s.height,
      pointerEvents: s.pointerEvents,
      rect: `${Math.round(r.width)}x${Math.round(r.height)}`,
    }
  }

  const op = item.querySelector('.user-operation') as HTMLElement | null
  const imgs = Array.from(item.querySelectorAll('.user-operation img')) as HTMLElement[]
  // 图标中心处最上层的元素：若它不是图标本身，说明 realClick 会把点击投错目标
  let atPoint = '-'
  if (op) {
    const r = op.getBoundingClientRect()
    const el = document.elementFromPoint(
      Math.round(r.left + (r.width || 1) / 2),
      Math.round(r.top + (r.height || 1) / 2),
    ) as HTMLElement | null
    if (el) atPoint = `${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 30)}`
  }

  diag('CHAT', `删除取证[${phase}] 样式与命中`, {
    marked: item.classList.contains(MARK_CLASS),
    styleInjected: !!document.getElementById(STYLE_ID),
    userOperation: styleOf(op),
    imgs: imgs.map((i) => styleOf(i)),
    imgCount: imgs.length,
    elementAtIconCenter: atPoint,
    operationContainers: document.querySelectorAll('.operation-container').length,
    visibleContainers: (
      Array.from(document.querySelectorAll('.operation-container')) as HTMLElement[]
    ).filter(isVisible).length,
  })
  // 单独一条：outerHTML 较长，混在上面那条里会被日志行截断
  diag('CHAT', `删除取证[${phase}] 行 HTML`, (item.outerHTML || '').slice(0, 1800))
}

/**
 * 经**会话头部菜单**删除当前打开的会话。
 *
 * 为什么值得走这条路（2026-08-01）：头部那个 6 项菜单
 * （置顶/备注/不感兴趣/黑名单/删除/举报）**始终在 DOM 里** —— 它在你历次日志的
 * 头部 span dump 里每次都出现。而且它是**点击**展开的，不是 CSS :hover，
 * 因此完全绕开了列表项按钮那个「合成事件改不了浏览器悬停状态机」的死结。
 *
 * 代价：它作用于「当前打开的会话」，所以调用前必须已切到目标会话。这一点由
 * 调用方传入的 verifyIdentity() 把关（内部就是 currentThreadId() 比对）——
 * 核对不过一律放弃，绝不猜。发给/删除 HR 侧的动作不可撤回，宁可不删。
 *
 * @param header 会话头部容器（调用方用 findChatHeader() 提供）
 * @param verifyIdentity 返回 true 表示当前打开的确实是目标会话
 * @param insideList 判断节点是否属于左侧列表（排除列表项里的同名节点）
 * @returns 是否已点到「删除」（确认弹窗仍由调用方处理）
 */
export async function clickDeleteInHeaderMenu(
  header: HTMLElement,
  verifyIdentity: () => boolean,
  insideList: (el: HTMLElement) => boolean,
): Promise<boolean> {
  if (!verifyIdentity()) {
    diag('CHAT', '头部菜单删除已中止：当前会话与目标不一致')
    return false
  }

  // 头部里所有文本恰为「删除」的叶子节点，且不属于左侧列表
  const delNodes = (Array.from(header.querySelectorAll('*')) as HTMLElement[]).filter(
    (e) =>
      !e.querySelector('*') &&
      (e.textContent || '').replace(/\s/g, '') === '删除' &&
      !insideList(e),
  )
  if (!delNodes.length) {
    diag('CHAT', '头部菜单里未找到「删除」项')
    return false
  }

  // 已可见 → 直接点
  for (const n of delNodes) {
    if (isVisible(n)) {
      diag('CHAT', '头部菜单「删除」已可见，直接点击')
      clickDirect(n)
      return true
    }
  }

  // 不可见 → 点开菜单触发器。
  // 「展开成功」的判据就是「删除项变可见」，所以把它作为 isReady 传进去 ——
  // 这样触发器一旦点对就立即停手，不会再点下一个把菜单又关掉。
  const menuReady = () => delNodes.some((n) => isVisible(n))
  const opened = await openHeaderMenu(header, insideList, menuReady)
  if (opened) {
    const vis = delNodes.find((n) => isVisible(n))
    if (vis) {
      diag('CHAT', '头部菜单已展开，点击「删除」')
      clickDirect(vis)
      return true
    }
  }

  // 触发器没找到/展开无效 → 强制显示后再点。
  //
  // 上一版只把标记打在**直接父节点**上，但真正被隐藏的往往是更外层的下拉容器，
  // 于是标记打了也没用 —— 实测日志：`强制显示后点击「删除」{forced:true,visible:false}`。
  // 现在沿祖先链往上找「第一个自身不可见的容器」并一路标记，覆盖到真正的闸门。
  const target = delNodes[0]
  const marked: HTMLElement[] = []
  ensureMenuStyle()
  let cur: HTMLElement | null = target
  for (let i = 0; i < 6 && cur && cur !== header; i++) {
    cur.classList.add(MARK_MENU)
    marked.push(cur)
    cur = cur.parentElement
  }
  await new Promise((r) => setTimeout(r, 180))

  const vis = delNodes.find((n) => isVisible(n)) || target
  const forcedVisible = isVisible(vis)
  diag('CHAT', '头部菜单强制显示后点击「删除」', {
    forced: true,
    visible: forcedVisible,
    markedAncestors: marked.length,
  })
  // 只点**一个**节点，且只点一次：delNodes 里可能有多个文本为「删除」的节点，
  // 逐个点会让 Vue 的 handler 触发多次 —— 实测出现两个「确认删除吗？」弹窗
  // （用户反馈：删成功了但弹窗还在）。
  clickDirect(vis)
  for (const m of marked) m.classList.remove(MARK_MENU)
  return true
}

/**
 * 点开会话头部的菜单触发器（「更多」/「···」之类）。
 *
 * 不写死 class：BOSS 头部改版频繁。两路找候选 ——
 *   1. 按**文案**（用户截图里头部右上角是「⊙ 更多」，语义明确，优先）
 *   2. 按类名含 operate/more/dot/setting/menu 且尺寸像小图标
 *
 * @param isReady 每次点击后用它判断菜单是否真的展开了（成了立刻停，别再点）
 */
async function openHeaderMenu(
  header: HTMLElement,
  insideList: (el: HTMLElement) => boolean,
  isReady: () => boolean,
): Promise<boolean> {
  const byClass = (
    Array.from(
      header.querySelectorAll(
        '[class*="operate"],[class*="more"],[class*="dot"],[class*="setting"],[class*="menu"]',
      ),
    ) as HTMLElement[]
  ).filter((e) => {
    if (insideList(e)) return false
    const r = e.getBoundingClientRect()
    // 触发器是个小图标；太大的是容器，点它可能命中别的东西
    return r.width >= 8 && r.width <= 48 && r.height >= 8 && r.height <= 48
  })

  // 按**文案**找触发器：用户截图里头部右上角是「⊙ 更多」，class 未知。
  // 只认叶子节点，避免命中把整个头部圈进去的外层容器。
  const byText = (Array.from(header.querySelectorAll('*')) as HTMLElement[]).filter((e) => {
    if (insideList(e) || e.querySelector('*')) return false
    if (!/^(更多|···|\.\.\.|…)$/.test((e.textContent || '').replace(/\s/g, ''))) return false
    return isVisible(e)
  })

  // 文案命中的优先（语义明确），再退回 class 猜测
  const cands = [...byText, ...byClass]

  if (!cands.length) {
    diag('CHAT', '头部未找到菜单触发器候选')
    return false
  }
  diag('CHAT', `头部菜单触发器候选 ${cands.length} 个，逐个尝试`, {
    els: cands
      .slice(0, 5)
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className || '').slice(0, 24)}`),
  })
  // 点一个就检查一次，成了立刻停。
  //
  // 不能连点多个再统一判定（上一版如此）：菜单展开后点别处通常会把它关掉，
  // 于是「第 1 个点开、第 2 个又点关」，最终看起来一个都没成。
  for (const c of cands.slice(0, 6)) {
    clickDirect(c)
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 130))
      if (isReady()) {
        diag('CHAT', '头部菜单已展开', {
          by:
            `${c.tagName.toLowerCase()}.${String(c.className || '').slice(0, 20)}` +
            `"${(c.textContent || '').replace(/\s/g, '').slice(0, 6)}"`,
        })
        return true
      }
    }
  }
  diag('CHAT', '头部菜单触发器全部点过仍未展开')
  return false
}
