// BOSS 聊天页操作（/web/geek/chat）
//
// 职责：读会话列表与消息 → 交后端分类+生成回复 → 在页面内发送 → 回报结果。
// 为什么单独一个模块：投递在 /web/geek/jobs，沟通在 /web/geek/chat，
// 两个页面 DOM 完全不同，混在一个适配器里会互相干扰。
//
// 红线：本模块只在用户显式启动「会话托管」后运行。发给 HR 的消息不可撤回，
// 全过程由后端落 conversation_* 三表留痕（含意图/回复/发送结果）供事后评判。
import { diag } from '../logger'
import type { PluginConfig } from '../types'
import { markChatSent, syncChatBatch } from '../api'
import { findByText, findChatPanel, findEditable } from '../domprobe'
// 删除链路（唤按钮/定位删除项/取证/兜底）集中在 boss-delete.ts，见该文件顶部注释
import {
  clickDeleteInHeaderMenu,
  clickDirect,
  deleteViaRowVue,
  dumpDeleteDiagnostics,
  findDeleteItemInPopup,
  isTopmostAtCenter,
  revealOperateBtn,
  unmarkOperateRow,
} from './boss-delete'
import {
  getThread,
  isKnownLowScore,
  recordLowScore,
} from '../chat-store'
import { syncDeletions, upsertMirrorFromSync } from '../ledger'

/** 聊天页单个会话条目 */
export interface ChatThread {
  el: HTMLElement
  company: string
  jobTitle: string
  unread: boolean
}

const SEL = {
  // 会话列表项（多套候选，BOSS 改版频繁）
  thread: [
    '.geek-item',
    '.user-list li',
    '[class*="chat-user-item"]',
    'li[role="listitem"]',
  ],
  // 消息文本（2026-07-30 由页面 dump 确认：BOSS 消息正文在 span.text-content）
  msgText: ['span.text-content', '.text-content'],
  // 会话身份锚点：头部姓名 + 岗位名，用于发送前校验「当前会话是否仍是目标会话」
  headerName: ['span.name-text', '.name-text'],
  headerPosition: ['span.position-name', '.position-name'],
  // 头部薪资/城市。用途：给 HR 主动打招呼的岗位补匹配分 —— 这类岗位用户
  // 没投过、库里没 JD，但头部这几个字段足够让匹配引擎跑出分辨力
  // （实测 BGE 生产路径：对口岗 62 分 vs 垃圾岗 38 分，阈值 50 可用）。
  // 由 2026-08-01 日志的头部 dump 实证存在：{cls:"salary"} / {cls:"city"}。
  headerSalary: ['span.salary', '.salary'],
  headerCity: ['span.city', '.city'],
  // 发送按钮
  sendBtn: ['button.btn-send', '.btn-send'],
  msgItem: [
    '.chat-message-list .item',
    '.message-list .item',
    '.item-friend, .item-myself',
    '.message-item',
  ],
  input: [
    '#chat-input',
    '.chat-input',
    '[contenteditable="true"]',
    'textarea.input-area',
    'textarea',
  ],
}

function firstMatch(selectors: string[], root: ParentNode = document): HTMLElement | null {
  for (const s of selectors) {
    const el = root.querySelector(s) as HTMLElement | null
    if (el) return el
  }
  return null
}

function allMatch(selectors: string[], root: ParentNode = document): HTMLElement[] {
  for (const s of selectors) {
    const els = Array.from(root.querySelectorAll(s)) as HTMLElement[]
    if (els.length) return els
  }
  return []
}

const text = (el: Element | null | undefined) => (el?.textContent || '').trim()
const delay = (min: number, max: number) =>
  new Promise((r) => setTimeout(r, min + Math.random() * (max - min)))

/** 是否在 BOSS 聊天页 */
export function onChatPage(): boolean {
  return /\/web\/geek\/chat/.test(location.pathname)
}

/**
 * 模拟真实鼠标点击。
 *
 * 为什么不用裸 el.click()：BOSS 会话列表用 Vue 事件委托 + mousedown/mouseup 触发，
 * 裸 click() 不产生 pointer/mouse 事件序列,实测点了不加载消息区。
 */
function realClick(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  const x = Math.round(r.left + r.width / 2)
  const y = Math.round(r.top + r.height / 2)

  // 关键：点「坐标处最上层的元素」而非容器本身。
  // BOSS 的监听常挂在内层节点，点容器不会冒泡到正确的 handler。
  const target = (document.elementFromPoint(x, y) as HTMLElement) || el

  // 不能传 view: window —— 油猴沙箱里的 window 是包装对象，
  // 构造 MouseEvent 会抛 "Failed to convert value to 'Window'"。
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }
  const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }

  // Vue3 多监听 pointer 事件，缺 pointerdown/up 是合成点击失效的常见原因
  try {
    target.dispatchEvent(new PointerEvent('pointerover', pointer as PointerEventInit))
    target.dispatchEvent(new PointerEvent('pointerenter', pointer as PointerEventInit))
    target.dispatchEvent(new PointerEvent('pointerdown', pointer as PointerEventInit))
  } catch {
    /* 老浏览器无 PointerEvent，忽略 */
  }
  target.dispatchEvent(new MouseEvent('mouseover', base))
  target.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 0, buttons: 1 }))
  try {
    target.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 } as PointerEventInit))
  } catch {
    /* ignore */
  }
  target.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0, buttons: 0 }))
  target.dispatchEvent(new MouseEvent('click', { ...base, button: 0, detail: 1 }))
  // 再补一次原生 click（某些 handler 只认这个）
  try {
    target.click()
  } catch {
    /* ignore */
  }
}
/**
 * 探查会话项的可导航标识。
 *
 * 背景（2026-07-30）：合成鼠标事件点击会话列表已连续失败三次（nowId 始终不变），
 * BOSS 的事件监听无法用 dispatchEvent 触发。改走「读会话项自带 id/链接 → 真实导航」，
 * 故先确认这些标识存在于何处。
 */
/**
 * 通过 Vue 实例直接切换会话（首选方案）。
 *
 * 为什么走这条路：合成鼠标/pointer 事件点击会话列表已连续失败四次
 * （会话头部 nowId 始终不变）。PROBE 显示会话项挂着 `__vue__`（Vue 2），
 * 可以直接读组件数据、调组件方法，完全绕开事件模拟这层不确定性。
 *
 * @returns 是否成功触发切换
 */
function switchThreadViaVue(el: HTMLElement): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vm = (el as any).__vue__
  if (!vm) return false

  // 元素必须仍挂在文档上。BOSS 会话列表滚动时会重建节点，
  // listThreads() 缓存的引用可能已经脱离 DOM：此时 __vue__ 仍在、
  // 方法调得通、本函数返回 true，但页面毫无反应 —— 表现就是
  // 「切换未生效」连续刷屏（2026-08-01 实测第 20 个会话之后全部如此）。
  if (!el.isConnected) {
    diag('CHAT', 'Vue 切换放弃：节点已脱离 DOM（列表被重建）')
    return false
  }

  try {
    // 会话数据通常在 vm.data / vm.item / vm.friend / vm.$props 上
    const cand = vm.data || vm.item || vm.friend || vm.conversation || vm.$props?.data
    if (cand) {
      const keys = Object.keys(cand).filter((k) => /id|uid|encrypt|security/i.test(k))
      diag('CHAT', `Vue 数据可用字段: ${keys.slice(0, 8).join(',')}`)
    }

    // 优先调组件自身的选中方法（名字按常见约定逐个试）
    for (const fn of ['handleClick', 'onClick', 'selectItem', 'handleSelect', 'chooseItem']) {
      if (typeof vm[fn] === 'function') {
        vm[fn](cand)
        diag('CHAT', `已调用 Vue 方法 ${fn}()`)
        return true
      }
    }

    // 退一步：向父组件（列表）派发选中事件
    let p = vm.$parent
    for (let i = 0; i < 5 && p; i++) {
      for (const fn of ['selectFriend', 'handleItemClick', 'onSelectItem', 'switchChat']) {
        if (typeof p[fn] === 'function') {
          p[fn](cand)
          diag('CHAT', `已调用父组件方法 ${fn}()`)
          return true
        }
      }
      p = p.$parent
    }

    // 再退一步：走 Vue 事件总线
    if (typeof vm.$emit === 'function' && cand) {
      vm.$emit('click', cand)
      vm.$emit('select', cand)
      diag('CHAT', '已 $emit click/select')
      return true
    }
  } catch (e) {
    diag('CHAT', `Vue 切换异常: ${(e as Error).message}`)
  }
  return false
}

/**
 * 解析会话列表，不打日志。
 *
 * 重新定位节点时会被频繁调用（每个会话一次），走 listThreads() 会把
 * 「会话列表 N 个」刷满日志区，把真正有用的行挤出 MAX_LINES 窗口。
 */
function listThreadsQuiet(): ChatThread[] {
  const items = allMatch(SEL.thread)
  const threads: ChatThread[] = []
  for (const el of items) {
    const company = text(el.querySelector('[class*="company"], .name-box .company'))
    const jobTitle = text(el.querySelector('[class*="job"], .source-job'))
    const name = text(el.querySelector('[class*="name"]'))
    // 未读标记：红点/数字气泡
    const unread = !!el.querySelector('.badge-count, [class*="badge"], [class*="unread"]')
    threads.push({ el, company: company || name, jobTitle, unread })
  }
  return threads
}

export function listThreads(): ChatThread[] {
  const threads = listThreadsQuiet()
  diag('CHAT', `会话列表 ${threads.length} 个（未读 ${threads.filter((t) => t.unread).length}）`)
  if (!threads.length) {
    const guess = Array.from(document.querySelectorAll('li, div'))
      .map((e) => String((e as HTMLElement).className || ''))
      .filter((c) => /geek|user|chat|item/i.test(c))
      .slice(0, 20)
    diag('CHAT', '未识别会话列表，class 采样', guess)
  }
  return threads
}




/**
 * 点掉「确认删除吗？」弹窗的「确定」。
 *
 * 用户截图确认弹窗文案：标题「确认删除吗？」，正文「将对方从你的列表中删除，
 * 同时删除聊天记录」，按钮「取消」「确定」。
 *
 * 两个坑：
 *   1. 弹窗有入场动画，固定等一次可能还没渲染 → 轮询；
 *   2. 必须点「确定」而不能误点「取消」，也不能命中弹窗容器自身
 *      （容器 textContent 里同时含「取消确定」）→ 只认叶子节点 + 精确文本。
 */
async function confirmDeleteDialog(): Promise<boolean> {
  for (let i = 0; i < 14; i++) {
    await delay(250, 400)

    // 先定位弹窗容器：文案匹配且尺寸合理（避免命中 body）
    const dialogs = Array.from(document.querySelectorAll('div,section')) as HTMLElement[]
    const dialog = dialogs.find((d) => {
      const t = (d.textContent || '').replace(/\s/g, '')
      if (!/确认删除吗|从你的列表中删除|同时删除聊天记录/.test(t)) return false
      if (t.length > 120) return false // 太长说明是外层容器
      const r = d.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })

    // 弹窗内找「确定」；没定位到弹窗就退回全文档找（但排除「取消」）
    const scope: ParentNode = dialog || document
    const ok = (Array.from(scope.querySelectorAll('button,span,div,a')) as HTMLElement[]).find((e) => {
      if (e.querySelector('*')) return false // 只认叶子，防命中容器
      const t = text(e).replace(/\s/g, '')
      if (!/^(确定|确认)$/.test(t)) return false
      const r = e.getBoundingClientRect()
      return r.width > 1 && r.height > 1
    })
    if (ok) {
      realClick(ok)
      await delay(500, 800)
      diag('CHAT', '已点击删除确认弹窗「确定」')
      await dismissLeftoverDeleteDialogs()
      return true
    }
  }
  diag('CHAT', '未等到删除确认弹窗的「确定」按钮')
  return false
}

/**
 * 清掉多余的「确认删除吗？」弹窗。
 *
 * 为什么需要（2026-08-02 用户实测）：删除确实成功了，但页面上还留着一个同样的
 * 弹窗挡住整个界面。原因是「删除」被点了不止一次（详见 boss-delete.ts 里
 * clickDeleteInHeaderMenu 的注释），Vue 于是渲染了两个弹窗。第一次「确定」只
 * 消掉了最上面那个。
 *
 * 点击策略用「取消」而非「确定」：会话已经删掉了，多出来的这个弹窗若再点确定，
 * 语义上是对**下一个**目标再执行一次删除 —— 宁可取消。
 */
async function dismissLeftoverDeleteDialogs(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const dialog = (Array.from(document.querySelectorAll('div,section')) as HTMLElement[]).find(
      (d) => {
        const t = (d.textContent || '').replace(/\s/g, '')
        if (!/确认删除吗|从你的列表中删除|同时删除聊天记录/.test(t)) return false
        if (t.length > 120) return false
        const r = d.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      },
    )
    if (!dialog) return // 没有残留，正常退出

    const cancel = (Array.from(dialog.querySelectorAll('button,span,div,a')) as HTMLElement[]).find(
      (e) => {
        if (e.querySelector('*')) return false
        const t = text(e).replace(/\s/g, '')
        if (!/^(取消|关闭)$/.test(t)) return false
        const r = e.getBoundingClientRect()
        return r.width > 1 && r.height > 1
      },
    )
    if (!cancel) {
      diag('CHAT', '残留删除弹窗里未找到「取消」，留给用户手动关闭')
      return
    }
    diag('CHAT', `清理残留的删除确认弹窗（第 ${round + 1} 个）`)
    realClick(cancel)
    await delay(350, 550)
  }
}

/**
 * 删除指定会话。
 *
 * 完整流程（2026-08-01 按用户 4 张截图实现，取代此前三版猜测）：
 *   1. 滚动找到目标会话项（虚拟列表只渲染约 40 项，窗口外的找不到）
 *   2. 鼠标移到该项 → 右下角出现「···」按钮（Vue 条件渲染，非 CSS 隐藏）
 *   3. 点「···」→ 弹出浮层菜单（只有「置顶」「删除」两项）
 *   4. 点「删除」→ 弹「确认删除吗？」→ 点「确定」
 *   5. 校验该会话确实从列表消失
 *
 * 不走右侧会话头部那个菜单：那条路要先切换会话（多一次切换 + 身份核对，
 * 且会改变用户当前正在看的会话）。列表项这条路是用户实际的手动操作路径，
 * 无副作用。
 *
 * @returns 'ok' 已删除 | 'not-found' 列表里没有匹配项 | 'failed' 找到但删除失败
 */
export async function deleteThread(
  company: string,
  jobTitle = '',
): Promise<'ok' | 'not-found' | 'failed'> {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const target = norm(company)
  if (!target) return 'not-found'
  const wanted = norm(jobTitle)

  // 只按公司名匹配，**不能**要求岗位名也对上。
  //
  // 回归记录（2026-08-01，我上一版引入）：原来是「先试公司+岗位，失败退回
  // 仅公司」两段式，我改写成单个 match 谓词时把退路弄丢了 —— 只要传了
  // jobTitle 就必须两者同时命中。而 listThreadsQuiet() 读的
  // `[class*="job"]` 在列表项里**根本不存在**（PROBE 实证列表项内只有
  // name-box/name-text/title-box/text/time），jobTitle 恒为空串，
  // 于是 `''.includes('课程销售…')` 恒 false，任何删除都报「未找到会话」。
  // 日志里「未找到会话: 新东方」「未找到会话: 猿辅导」就是这个原因，
  // 那两个会话当时都在列表里。
  //
  // 列表项的 company 实际是「姓名+公司+职务」拼接（如"余先生新东方招聘主管"），
  // 所以用 includes(公司名) 判断；同公司多会话会命中第一个，这是 BOSS DOM
  // 的信息量限制（见 openThread 注释），不是可以写得更聪明的问题。
  // jobTitle 仅在列表项**确实**提供时作为加分项参与排序，不作硬条件。
  const match = (t: ChatThread) => norm(t.company).includes(target)
  void wanted // 保留参数语义：调用方仍传岗位名，供未来 BOSS 补上该字段时启用

  // 步骤 1：找到会话项（含滚动查找）
  const hit = await findThreadByScrolling(match)
  if (!hit) {
    diag('CHAT', `deleteThread 未找到会话（含滚动查找）: ${company}`)
    return 'not-found'
  }

  // 删除结果校验按「身份是否还在列表里」判断。
  // 不能比列表长度：虚拟列表 DOM 节点数恒定约 40，删一条后下一条补位、
  // 长度不变，于是删成功也会报 failed。也不能用 !el.isConnected：
  // 虚拟列表回收节点同样让它脱离文档，那只说明滚出视野。
  const wantKey = threadKey(hit)

  /** 点确认弹窗 + 校验会话是否真的从列表消失 */
  const confirmAndVerify = async (label: string): Promise<boolean> => {
    await delay(300, 450)
    const confirmed = await confirmDeleteDialog()
    if (!confirmed) diag('CHAT', `${label}：未点到确认按钮，继续校验实际结果`)
    for (let i = 0; i < 10; i++) {
      if (!listThreadsQuiet().some((t) => threadKey(t) === wantKey)) {
        diag('CHAT', `${label} 已删除: ${hit.company}`)
        return true
      }
      await delay(300, 450)
    }
    return false
  }

  try {
    hit.el.scrollIntoView({ block: 'center' })
    await delay(300, 450)

    // 步骤 1：直接调用该行组件自己的 deleteBoss()。
    //
    // 放在最前面（2026-08-02）：点图标那条路已连续三版卡在「菜单不生成」
    // （取证 operationContainers:0），而行组件实例上就挂着 deleteBoss() ——
    // 它正是「删除」菜单项最终调用的东西。直接调它跳过全部 DOM 交互，
    // 且作用对象就是这一行，不存在删错会话的可能。
    if (deleteViaRowVue(hit.el)) {
      if (await confirmAndVerify('deleteViaRowVue')) return 'ok'
      diag('CHAT', 'deleteViaRowVue 调用成功但会话仍在列表，继续尝试点击路径')
    }

    // 步骤 2：唤出「···」按钮。
    // 走 boss-delete.ts 的注入 CSS 方案：按钮节点一直在 DOM 里（0 尺寸），
    // 闸门是 CSS :hover，而合成事件改不了浏览器悬停状态机 —— 详见该文件顶部注释。
    const opBtn = await revealOperateBtn(hit.el)
    if (!opBtn) {
      diag('CHAT', 'deleteThread 未能唤出「···」操作按钮', {
        company: hit.company,
        itemNodes: Array.from(hit.el.querySelectorAll('*'))
          .map((e) => {
            const el = e as HTMLElement
            const r = el.getBoundingClientRect()
            return `${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 24)}` +
              `[${Math.round(r.width)}x${Math.round(r.height)}]`
          })
          .slice(0, 20),
      })
      dumpDeleteDiagnostics(hit.el, '按钮未找到')
      unmarkOperateRow(hit.el)
      return 'failed'
    }
    const btnRect = opBtn.getBoundingClientRect()
    diag('CHAT', 'deleteThread 已唤出操作按钮', {
      el: `${opBtn.tagName.toLowerCase()}.${String(opBtn.className || '').slice(0, 30)}`,
      size: `${Math.round(btnRect.width)}x${Math.round(btnRect.height)}`,
    })

    // 步骤 3：点「···」展开菜单。
    //
    // 判据是「中心点处最上层的节点是不是它自己」，**不是**「尺寸是否 > 0」
    // （2026-08-02 取证修正）：上一版按尺寸判断，撑开成功就走 realClick，
    // 但 realClick 会把点击转投给 elementFromPoint 的结果 —— 那时 `.list-operate`
    // 恰好叠在同一坐标上，于是点在了错的图上，菜单压根没生成
    // （取证：elementAtIconCenter=.list-operate、operationContainers=0）。
    // 被别的节点盖住时必须直接派发到目标元素本身。
    if (isTopmostAtCenter(opBtn)) realClick(opBtn)
    else {
      diag('CHAT', '操作按钮被其它节点遮挡，改为直接派发点击')
      clickDirect(opBtn)
    }
    await delay(350, 550)

    let del = findDeleteItemInPopup()
    if (!del) {
      // 菜单可能需要多等一会（浮层有动画），轮询几轮
      for (let i = 0; i < 5 && !del; i++) {
        await delay(250, 400)
        del = findDeleteItemInPopup()
      }
    }
    if (!del) {
      diag('CHAT', 'deleteThread 列表浮层未出现「删除」项，改走头部菜单', {
        company: hit.company,
      })
      dumpDeleteDiagnostics(hit.el, '列表浮层未出现')
      unmarkOperateRow(hit.el)
      // 降级到头部菜单：那个 6 项菜单常驻 DOM 且**点击**展开（非 CSS :hover），
      // 绕开列表按钮的悬停死结。代价是它作用于「当前打开的会话」，
      // 所以必须先切到目标会话并核对身份 —— 由 deleteViaHeaderMenu 内部把关。
      if (await deleteViaHeaderMenu(hit)) return 'ok'
      return 'failed'
    }

    // 步骤 4：点「删除」→ 确认弹窗
    unmarkOperateRow(hit.el) // 菜单已出，撤掉强制样式，避免留下视觉异常
    realClick(del)
    await delay(300, 450)
    const confirmed = await confirmDeleteDialog()
    if (!confirmed) {
      // 没找到确认弹窗有两种可能：BOSS 改成无需确认（那下面校验会通过），
      // 或者点「删除」没生效。交给校验判定，不在这里下结论。
      diag('CHAT', 'deleteThread 未点到确认按钮，继续校验实际结果')
    }

    // 步骤 5：校验
    for (let i = 0; i < 10; i++) {
      if (!listThreadsQuiet().some((t) => threadKey(t) === wantKey)) {
        diag('CHAT', `deleteThread 已删除: ${hit.company}`)
        return 'ok'
      }
      await delay(300, 450)
    }
    diag('CHAT', 'deleteThread 流程走完但会话仍在列表中，改走头部菜单', {
      company: hit.company,
    })
    // 列表路径走完仍在 → 再试头部菜单（同上，身份由内部核对）
    if (await deleteViaHeaderMenu(hit)) return 'ok'
    return 'failed'
  } catch (e) {
    diag('CHAT', `deleteThread 异常: ${(e as Error).message}`)
    unmarkOperateRow(hit.el)
    return 'failed'
  }
}

/**
 * 降级路径：切到目标会话，用**会话头部**那个常驻菜单删除。
 *
 * 为什么需要它（2026-08-01）：列表项「···」按钮的显隐闸门是 CSS `:hover`，
 * 而 `dispatchEvent` 改不了浏览器的悬停状态机 —— 这条路已连续失败多轮。
 * 头部菜单（置顶/备注/不感兴趣/黑名单/删除/举报）不同：它常驻 DOM 且靠**点击**
 * 展开，原理上可自动化。
 *
 * 安全红线：头部菜单作用于「当前打开的会话」，切错人就删错会话且不可撤回。
 * 因此这里做两道校验：
 *   1. 切换后 currentThreadId() 必须发生变化（确认切换真的生效）；
 *   2. 头部姓名必须出现在列表项 company 串里（列表项是「姓名+公司+职务」拼接，
 *      头部只有姓名，故用「头部姓名 ⊂ 列表串」判定同一人）。
 * 任一不过就放弃，绝不猜。
 */
async function deleteViaHeaderMenu(hit: ChatThread): Promise<boolean> {
  const wantKey = threadKey(hit)
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()

  // 身份核对谓词：头部姓名必须出现在列表项串里。
  // 列表项是「姓名+公司+职务」拼接（如"韩女士南京思盖文化传媒人事"），
  // 头部只有姓名，故用「头部姓名 ⊂ 列表串」判定是同一个人。
  const identityMatches = (): boolean => {
    const h = findChatHeader()
    const hName = norm(text(h ? headerNameIn(h) : null))
    return !!hName && norm(hit.company).includes(hName)
  }

  // 先看目标会话是不是**本来就已经打开**了。
  //
  // 上一版的 bug（2026-08-02 取证暴露）：只比对 currentThreadId() 变没变，
  // 于是"目标本来就是当前会话"这种最常见的情况被判成「切换未生效」直接放弃
  // ——用户日志正是如此：行 HTML 带 `friend-content selected`、头部也确实是韩女士，
  // 却报了切换失败。身份对得上就无需切换。
  if (!identityMatches()) {
    const beforeId = currentThreadId()
    try {
      if (!switchThreadViaVue(hit.el)) realClick(hit.el)
    } catch (e) {
      diag('CHAT', `头部菜单删除：切换会话异常 ${(e as Error).message}`)
      return false
    }

    // 等切换生效：以「身份对上」为准，而不是「id 变了」
    let ok = false
    for (const d of [300, 400, 500, 700, 900, 1100, 1400]) {
      await delay(d, d + 150)
      if (identityMatches()) {
        ok = true
        break
      }
    }
    if (!ok) {
      diag('CHAT', '头部菜单删除已放弃：切换后头部身份仍与目标不一致', {
        company: hit.company,
        beforeId,
        nowId: currentThreadId(),
      })
      return false
    }
  } else {
    diag('CHAT', '头部菜单删除：目标会话已是当前会话，无需切换')
  }

  const header = findChatHeader()
  if (!header) {
    diag('CHAT', '头部菜单删除已放弃：未找到会话头部')
    return false
  }
  const verify = (): boolean => {
    const ok = identityMatches()
    if (!ok) {
      diag('CHAT', '头部菜单删除已放弃：身份核对不通过', {
        headerName: norm(text(headerNameIn(header))),
        listCompany: hit.company,
      })
    }
    return ok
  }

  const clicked = await clickDeleteInHeaderMenu(header, verify, insideThreadList)
  if (!clicked) return false

  await delay(300, 450)
  const confirmed = await confirmDeleteDialog()
  if (!confirmed) diag('CHAT', '头部菜单删除：未点到确认按钮，继续校验实际结果')

  for (let i = 0; i < 10; i++) {
    if (!listThreadsQuiet().some((t) => threadKey(t) === wantKey)) {
      diag('CHAT', `头部菜单删除成功: ${hit.company}`)
      return true
    }
    await delay(300, 450)
  }
  diag('CHAT', '头部菜单删除流程走完但会话仍在列表中', { company: hit.company })
  return false
}

/**
 * 在会话列表中滚动查找匹配的会话项。
 *
 * 必要性：虚拟列表只渲染当前窗口约 40 项，`listThreadsQuiet()` 看不到窗口外的
 * 会话。实测面板显示 43 条时删除第 41+ 条会连续报「未找到会话」——不是没有，
 * 是没渲染。查找完成后把滚动位置复位，避免影响用户视野。
 */
async function findThreadByScrolling(
  match: (t: ChatThread) => boolean,
): Promise<ChatThread | null> {
  // 先查当前窗口（绝大多数情况命中，不必滚动）
  const inWindow = listThreadsQuiet().find(match)
  if (inWindow) return inWindow

  const container = findThreadScrollContainer()
  if (!container) return null

  const restore = container.scrollTop
  const step = Math.max(1, Math.floor(container.clientHeight * 0.8))
  const maxScroll = container.scrollHeight - container.clientHeight

  try {
    for (let top = 0; top <= maxScroll + step; top += step) {
      container.scrollTo({ top: Math.min(top, maxScroll) })
      await delay(400, 550) // 等虚拟列表渲染
      const found = listThreadsQuiet().find(match)
      if (found) return found
    }
    return null
  } finally {
    // 命中时不复位：调用方接着要点这个节点，复位会把它滚出窗口、
    // 让虚拟列表回收掉刚拿到的引用。未命中才复位。
    if (!listThreadsQuiet().find(match)) container.scrollTo({ top: restore })
  }
}

/**
 * 在会话列表里定位并打开指定会话（供面板点 HR 卡片跳转用）。
 *
 * 为什么不用 `[data-thread-key]` 选择器：BOSS 的 DOM 上没有这个属性，
 * threadKey() 是本插件自己算的哈希、只存在于 GM 存储里，DOM 中无对应标记。
 * 查过全量源码与实测页面，`document.querySelector('[data-thread-key=...]')`
 * 恒为 null。
 *
 * 匹配依据只能是公司名子串：列表项把「姓名+公司+职务」拼成一串
 * （如 "张琪梅图迅电子人事"）且**不含岗位名**（见 currentThreadInfo 注释），
 * 所以无法按 company+jobTitle 精确匹配。同公司多个岗位时会命中第一个 ——
 * 这是 BOSS DOM 的信息量限制，不是可以写得更聪明的问题。
 *
 * 切换动作复用 switchThreadViaVue → realClick 的既有路径：裸 .click()
 * 在 BOSS 上已连续失败四次（见 switchThreadViaVue 注释）。
 *
 * @returns 'ok' 已触发切换 | 'not-found' 列表里没有匹配项 | 'failed' 找到但切换失败
 */
export function openThread(company: string, jobTitle = ''): 'ok' | 'not-found' | 'failed' {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const target = norm(company)
  if (!target) return 'not-found'

  const threads = listThreads()
  // 先试「公司+岗位都能对上」，退回「仅公司对上」。
  // 列表项通常没有岗位名，故第一轮多半空手，但万一 BOSS 改版加上了就能更准。
  const wanted = norm(jobTitle)
  let hit = wanted
    ? threads.find((t) => norm(t.company).includes(target) && norm(t.jobTitle).includes(wanted))
    : undefined
  if (!hit) hit = threads.find((t) => norm(t.company).includes(target))

  if (!hit) {
    diag('CHAT', `openThread 未找到会话: ${company}`, {
      candidates: threads.slice(0, 8).map((t) => t.company),
    })
    return 'not-found'
  }

  try {
    if (!switchThreadViaVue(hit.el)) realClick(hit.el)
    diag('CHAT', `openThread 已切换到 ${hit.company}`)
    return 'ok'
  } catch (e) {
    diag('CHAT', `openThread 切换异常: ${(e as Error).message}`)
    return 'failed'
  }
}

/**
 * 带滚动查找的openThread版本（用于删除等需要找到任意会话的场景）
 */
export async function openThreadWithScroll(company: string, jobTitle = ''): Promise<'ok' | 'not-found' | 'failed'> {
  // 先尝试不滚动
  const quickResult = openThread(company, jobTitle)
  if (quickResult === 'ok') return 'ok'

  // 如果没找到，尝试滚动查找
  const container = findThreadScrollContainer()
  if (!container) return 'not-found'

  diag('CHAT', `openThreadWithScroll 开始滚动查找: ${company}`)

  // 滚动到顶部
  container.scrollTo({ top: 0 })
  await delay(300, 500)

  let attempts = 0
  const maxAttempts = 30 // 最多30屏

  while (attempts < maxAttempts) {
    // 尝试在当前窗口查找
    const result = openThread(company, jobTitle)
    if (result === 'ok') {
      diag('CHAT', `openThreadWithScroll 找到并切换（第${attempts}屏）`)
      return 'ok'
    }

    // 向下滚动一屏
    const before = container.scrollTop
    container.scrollBy({ top: Math.floor(container.clientHeight * 0.8) })
    await delay(300, 500)

    // 如果到底了，停止
    if (Math.abs(container.scrollTop - before) < 10) {
      diag('CHAT', `openThreadWithScroll 滚动到底仍未找到: ${company}`)
      break
    }

    attempts++
  }

  return 'not-found'
}

/** 读当前打开会话的消息（区分 hr / me）。会先滚动到底部确保全部加载。 */
export async function readMessages(): Promise<Array<{ sender: 'hr' | 'me'; content: string }>> {
  // 滚到消息区底部，确保读到最后一条。
  //
  // 注意：findChatPanel() 返回的是消息区容器，但它本身不一定是可滚动的那个节点，
  // 直接给它设 scrollTop 可能毫无效果（上一版就是这么写的，故没生效）。
  // 这里从消息节点往上找真正可滚动的祖先。
  const panel = findChatPanel()
  if (panel) {
    const anchor = firstMatch(SEL.msgText, panel) || panel
    let sc: HTMLElement | null = anchor
    for (let i = 0; i < 8 && sc; i++) {
      if (sc.scrollHeight > sc.clientHeight + 4) break
      sc = sc.parentElement
    }
    if (sc) {
      sc.scrollTo({ top: sc.scrollHeight })
      await delay(250, 400)
    }
  }

  const out: Array<{ sender: 'hr' | 'me'; content: string }> = []
  const dbg: string[] = []
  if (!panel) return out
  const pr = panel.getBoundingClientRect()
  const mid = pr.left + pr.width / 2

  for (const el of allMatch(SEL.msgText, panel)) {
    const content = text(el)
    if (!content || content.length > 800) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue

    // 收发方判断：优先用 BOSS 自己的语义标记，几何位置只作最后兜底。
    //
    // 教训（2026-07-30）：纯几何判断出过严重错误——实测我方消息气泡中心
    // 仅比中线右 14px，远低于阈值，我方消息被当成了 HR 消息。
    const bubble = el.closest('.item-friend, .item-myself, [class*="item-"]') || el.parentElement
    const scope = (bubble || el) as HTMLElement
    const cls = String((scope as HTMLElement).className || '')
    let isMe: boolean
    const hasStatus = !!scope.querySelector('.message-status')
    const hasAvatar = !!scope.querySelector('.image-circle')
    if (/item-myself|myself/.test(cls)) isMe = true
    else if (/item-friend|friend/.test(cls)) isMe = false
    else if (hasStatus) isMe = true
    else if (hasAvatar) isMe = false
    else isMe = r.left > mid
    out.push({ sender: isMe ? 'me' : 'hr', content })
    dbg.push(`${isMe ? 'ME' : 'HR'}|cls=${cls.slice(0, 24)}|st=${hasStatus ? 1 : 0}|av=${hasAvatar ? 1 : 0}|x=${Math.round(r.left)}`)
  }
  if (dbg.length) diag("CHAT", "消息判定 mid=" + Math.round(mid), dbg.slice(0, 8))
  return out
}

/**
 * 读当前打开会话的身份指纹（HR 姓名 + 岗位名）。
 *
 * 用途：发送前校验「当前会话是否仍是我要回复的那个」。
 * 教训（2026-07-30）：读消息→调后端生成回复要几秒，期间用户若切换会话，
 * 回复会发给错误的 HR，且不可撤回。必须在发送前重新核对身份。
 */
/**
 * 定位会话头部容器。
 *
 * 必须以 `span.position-name`（岗位名）为锚点向上找：`.name-text` 这个 class
 * 会话列表项也在用，直接 querySelector 会命中列表里靠前的项而不是头部
 * ——实测导致姓名/公司名恒为列表第一项的值。position-name 只存在于头部。
 */
/** 该元素是否位于左侧会话列表项内部 */
function insideThreadList(el: HTMLElement): boolean {
  for (const sel of SEL.thread) {
    if (el.closest(sel)) return true
  }
  return false
}

/**
 * 定位右侧会话头部容器。
 *
 * 坑（2026-07-31 实测）：原实现从 .position-name 向上爬最多 6 层，
 * 只要祖先里能 querySelector('.name-text') 就收工。但爬到第 5、6 层时
 * 容器已经大到同时包住左侧会话列表，于是后续 header.querySelector('.name-text')
 * 按文档顺序拿到的是「列表第一项」的姓名节点——列表不重排，
 * 导致 5 个会话读出同一个公司名（且是"朱女士安徽汉威光电科技招聘者"这种拼接文本），
 * 后端全部匹配不到投递记录，5 个会话 5 个 404。
 *
 * 现在改为：向上爬时要求容器内**存在不属于列表项**的 .name-text，
 * 且容器不得包含任何列表项，越界即停在上一层。
 */
function findChatHeader(): HTMLElement | null {
  const pos = firstMatch(SEL.headerPosition)
  if (!pos) return null
  let cur: HTMLElement | null = pos.parentElement
  for (let i = 0; i < 6 && cur; i++) {
    // 一旦容器把左侧列表也圈进来，就说明爬过头了
    const swallowedList = SEL.thread.some((s) => cur!.querySelector(s))
    if (swallowedList) break
    if (headerNameIn(cur)) return cur
    cur = cur.parentElement
  }
  return pos.parentElement
}

/** 取容器内属于头部（非列表项）的姓名节点 */
function headerNameIn(root: HTMLElement): HTMLElement | null {
  const all = Array.from(root.querySelectorAll('.name-text')) as HTMLElement[]
  return all.find((el) => !insideThreadList(el)) || null
}

export function currentThreadId(): string {
  const header = findChatHeader()
  // 必须排掉列表项里的 .name-text，否则拿到的恒是列表第一项的姓名，
  // 会话指纹就永远不变 —— 切换检测（sendText 的 expectThread 核对）随之失效
  const name = text(header ? headerNameIn(header) : null)
  const pos = text(firstMatch(SEL.headerPosition))
  return `${name}|${pos}`
}

/**
 * 从会话头部读取真实的公司名与岗位名。
 *
 * 为什么不用列表项里的：列表项把「姓名+公司+职务」拼在一起（如
 * "张琪梅图迅电子人事"），且没有岗位名，后端无法据此唯一定位投递记录
 * ——实测导致所有会话串号到同一个 Conversation。
 * 头部区域有独立的公司名节点和 span.position-name，准确得多。
 */
export function currentThreadInfo(): {
  company: string
  jobTitle: string
  salary: string
  city: string
} {
  const jobTitle = text(firstMatch(SEL.headerPosition))
  // 薪资/城市取头部的，且必须排掉列表项里的同名 class（列表项也有这些 class，
  // 按文档顺序 querySelector 会拿到列表第一项的值 —— 这是 findChatHeader
  // 注释里记录过的同一类坑）。
  const pickHeaderField = (sels: string[]): string => {
    for (const sel of sels) {
      for (const el of Array.from(document.querySelectorAll(sel)) as HTMLElement[]) {
        if (insideThreadList(el)) continue
        const t = text(el)
        if (t) return t
      }
    }
    return ''
  }
  const salary = pickHeaderField(SEL.headerSalary)
  const city = pickHeaderField(SEL.headerCity)

  const header = findChatHeader()
  if (!header) return { company: '', jobTitle, salary, city }

  const nameEl = headerNameIn(header)
  const nameTxt = text(nameEl)

  // 公司名 span 无 class（dump 可见），靠位置识别：与姓名同一行、在其右侧、
  // 且排在职务标签 base-title 之前。
  let company = ''
  if (nameEl) {
    const nr = nameEl.getBoundingClientRect()
    const spans = Array.from(header.querySelectorAll('span')) as HTMLElement[]
    let best: { el: HTMLElement; x: number } | null = null
    for (const s of spans) {
      // 列表项里的 span 一律不参与：它们是「姓名+公司+职务」的拼接文本，
      // 混进来就会把整串当公司名交给后端，匹配必然失败
      if (insideThreadList(s)) continue
      const t = text(s)
      if (!t || t === nameTxt) continue
      if (s.classList.contains('name-text') || s.classList.contains('base-title')) continue
      if (s.classList.contains('position-name') || s.classList.contains('salary')) continue
      if (s.classList.contains('city') || s.classList.contains('time')) continue
      // 只认叶子节点：父级 span 的 textContent 会把子孙文本全拼进来
      if (s.querySelector('span')) continue
      const r = s.getBoundingClientRect()
      // 同一行（纵向重叠）且在姓名右侧
      const sameRow = Math.abs(r.top - nr.top) < 16
      if (!sameRow || r.left <= nr.left) continue
      if (!best || r.left < best.x) best = { el: s, x: r.left }
    }
    // 公司名可能被截断成 "盘锦市兴隆台区得..."，去掉省略号
    company = text(best?.el).replace(/[.．…]{2,}$/, '')
  }

  // 提取失败时把头部结构 dump 出来：BOSS 改版后光看
  // 「company="-"」无从下手，有这份 dump 才能改选择器
  if (!company) {
    diag('CHAT', '头部公司名提取失败，dump 头部 span', {
      name: nameTxt,
      jobTitle,
      spans: Array.from(header.querySelectorAll('span'))
        .filter((s) => !insideThreadList(s as HTMLElement) && !(s as HTMLElement).querySelector('span'))
        .slice(0, 12)
        .map((s) => ({ cls: (s as HTMLElement).className || '-', t: text(s as HTMLElement).slice(0, 24) })),
    })
  }
  return { company, jobTitle, salary, city }
}

/**
 * 在当前会话输入并发送一条文本。
 *
 * @param expectThread 期望的会话身份指纹（currentThreadId() 的返回值）。
 *   传了就在发送前核对，不一致直接放弃 —— 防止用户中途切换会话导致发错人。
 */
export async function sendText(content: string, expectThread?: string): Promise<boolean> {
  // 安全校验：会话必须还是当初读消息时那个（发给 HR 不可撤回，宁可不发）
  if (expectThread) {
    const now = currentThreadId()
    if (now !== expectThread) {
      diag('CHAT', '已中止发送：会话已被切换', { expect: expectThread, now })
      return false
    }
  }

  // 【新增】记录发送前的列表滚动位置，用于发送后恢复（防止BOSS复位）
  const container = findThreadScrollContainer()
  const savedScroll = container?.scrollTop ?? 0

  // 通用定位优先：按「可编辑元素中面积最大者」找输入框，比猜 class 稳
  const input = findEditable() || firstMatch(SEL.input)
  if (!input) {
    diag('CHAT', '发送失败：未找到输入框')
    return false
  }
  try {
    input.focus()
    await delay(300, 700)
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      ;(input as HTMLTextAreaElement).value = content
      input.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      input.textContent = content
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    }
    await delay(500, 1100)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    await delay(800, 1500)

    // 兜底：找「发送」按钮
    const sendBtn = Array.from(document.querySelectorAll('button, [class*="send"]')).find((el) =>
      /^发\s*送$/.test(text(el).replace(/\s/g, '')),
    ) as HTMLElement | undefined
    if (sendBtn) {
      sendBtn.click()
      await delay(500, 1000)
    }

    // 校验上屏
    const ok = (document.body.textContent || '').includes(content.slice(0, 10))
    diag('CHAT', `发送${ok ? '成功' : '未确认'}: ${content.slice(0, 30)}`)

    // 【新增】发送成功后，检查并恢复列表滚动位置
    if (ok && container) {
      await delay(800, 1200) // 给BOSS足够时间更新列表（会话置顶动画）

      const currentScroll = container.scrollTop
      // 如果滚动位置被BOSS改动超过100px，恢复到发送前的位置
      if (Math.abs(currentScroll - savedScroll) > 100) {
        diag('CHAT', '检测到列表滚动被复位，正在恢复位置', {
          saved: savedScroll,
          current: currentScroll,
          delta: currentScroll - savedScroll,
        })
        container.scrollTo({ top: savedScroll, behavior: 'instant' })
        await delay(300, 500)
      }
    }

    return ok
  } catch (e) {
    diag('CHAT', `发送异常: ${(e as Error).message}`)
    return false
  }
}

/** BOSS 交互卡片：需要点按钮而非发文本 */
export interface ChatCard {
  kind: 'resume_request' | 'contact_exchange' | 'location_confirm' | 'unknown'
  question: string
  acceptBtn: HTMLElement | null
  rejectBtn: HTMLElement | null
}

/**
 * 按卡片问题文本判定类型。
 *
 * 严重事故记录（2026-08-01 实测日志）：原实现只看按钮对
 * `[/^同意$/, /^拒绝$/] → 'resume_request'`，不看问题文本。但 BOSS 的
 * 「交换联系方式」卡片用的是同一对按钮，于是被判成「HR 要简历」并自动同意 ——
 * 日志原文：
 *   发现 1 个交互卡片 [{"kind":"resume_request","q":"我想要和您交换联系方式，您是否同意…"}]
 *   已同意发送附件简历
 * 结果用户的手机号/微信发给了一个"日结300/天居家办公"的垃圾招聘方，不可撤回。
 *
 * 因此判定必须以**问题文本**为准，按钮对只作为「这是个卡片」的信号。
 * 认不出来的一律 'unknown' —— 未知卡片不自动点，宁可漏也不能乱点。
 */
function classifyCard(question: string): ChatCard['kind'] {
  const q = question.replace(/\s/g, '')
  // 联系方式必须先判：它和简历卡片共用同一对按钮，放后面会被简历分支抢走
  if (/交换联系方式|联系方式|电话|手机号|微信/.test(q)) return 'contact_exchange'
  if (/附件简历|一份您的简历|您的简历/.test(q)) return 'resume_request'
  if (/工作地点|是否接受此工作地点/.test(q)) return 'location_confirm'
  return 'unknown'
}

/**
 * 识别当前会话里待处理的交互卡片。
 *
 * 背景（2026-07-30 实测）：BOSS 的「索要附件简历」「确认工作地点」不是文本消息，
 * 而是带【同意/拒绝】【可以接受/暂不考虑】按钮的卡片。只发文本回复对这类消息无效，
 * 必须点按钮。这是简历发送链路此前一直没通的真正原因。
 */
/**
 * 卡片是否已经答过。
 *
 * 严重 bug 记录（2026-07-31 实测）：BOSS 的交互卡片答完后，
 * 「同意 / 可以接受」按钮**依旧留在消息流里且可点击**，本函数缺失时
 * 每轮托管都会重新扫到同一批卡片再点一次——实测同一个会话里
 * 简历发了 3 次、「工作地点我可以接受」发了 3 次，全部真实抵达 HR。
 *
 * 判据：卡片在消息流中的垂直位置之下若已存在我方消息，说明已答过。
 * 消息流自上而下按时间排列，故用 rect.top 比较即可，不依赖任何 class。
 */
function isCardAnswered(cardEl: HTMLElement, panel: HTMLElement): boolean {
  const cardBottom = cardEl.getBoundingClientRect().bottom

  // 卡片之后是否有我方消息（item-myself / 带已读送达标记）
  const mine = Array.from(panel.querySelectorAll('.item-myself, [class*="item-myself"]'))
  for (const el of mine) {
    const r = (el as HTMLElement).getBoundingClientRect()
    if (r.height > 0 && r.top >= cardBottom - 4) return true
  }

  // 兜底：卡片结果文本已出现在消息流（「已发送给Boss」「工作地点我可以接受」）
  const flow = (panel.textContent || '').replace(/\s/g, '')
  const cardText = (cardEl.textContent || '').replace(/\s/g, '')
  if (/是否同意/.test(cardText) && /已发送给Boss|已发送给boss/i.test(flow)) return true
  if (/是否接受此工作地点/.test(cardText) && /工作地点我可以接受/.test(flow)) return true

  return false
}

export function findPendingCards(): ChatCard[] {
  const panel = findChatPanel()
  if (!panel) return []

  const cards: ChatCard[] = []
  // 按钮对只用来「发现卡片」，类型一律由问题文本判定（见 classifyCard 注释：
  // 同意/拒绝 这对按钮同时用于「要简历」和「交换联系方式」，按按钮判类型
  // 会把联系方式当简历自动同意，已造成一次隐私泄露）。
  const pairs: Array<[RegExp, RegExp]> = [
    [/^同意$/, /^拒绝$/],
    [/^可以接受$/, /^暂不考虑$/],
  ]

  for (const [acceptRe, rejectRe] of pairs) {
    const accept = findByText(acceptRe, { clickable: true, root: panel })
    if (!accept) continue
    const reject = findByText(rejectRe, { clickable: true, root: panel })

    // 卡片问题文本：从按钮往上找含问句的容器，同时记下容器用于判重。
    //
    // 不能一见到「长度 6~200 的文本」就收工：按钮行本身就满足
    // （"暂不考虑可以接受" 恰好 8 字），于是取到的"问题"只有按钮文案、
    // 认不出类型。继续往上爬直到文本里出现问句特征，爬不到再退回第一个候选。
    let question = ''
    let cardEl: HTMLElement | null = null
    let fallbackQ = ''
    let fallbackEl: HTMLElement | null = null
    let cur: HTMLElement | null = accept.parentElement
    for (let i = 0; i < 6 && cur; i++) {
      const t = (cur.textContent || '').trim()
      if (t.length > 6 && t.length < 300) {
        const compact = t.replace(/\s+/g, ' ')
        if (!fallbackQ) {
          fallbackQ = compact
          fallbackEl = cur
        }
        // 问句特征：含「是否」「我想要」等，说明爬到了真正的问题容器
        if (/是否|我想要|请问|想和您|想要您/.test(compact)) {
          question = compact
          cardEl = cur
          break
        }
      }
      cur = cur.parentElement
    }
    if (!question) {
      question = fallbackQ
      cardEl = fallbackEl
    }

    const kind = classifyCard(question)

    // 已答过的卡片必须排除：BOSS 不会移除按钮，重复点会重复发给 HR
    if (cardEl && isCardAnswered(cardEl, panel)) {
      diag('CHAT', `卡片已答过，跳过（${kind}）`, { q: question.slice(0, 30) })
      continue
    }

    cards.push({ kind, question, acceptBtn: accept, rejectBtn: reject })
  }

  if (cards.length) {
    diag('CHAT', `发现 ${cards.length} 个交互卡片`, cards.map((c) => ({ kind: c.kind, q: c.question.slice(0, 40) })))
  }
  return cards
}

/**
 * 处理交互卡片。
 *
 * 简历卡片一律同意（用户已授权全自动投递，索要简历是推进流程的正常环节）；
 * 工作地点卡片交给后端判断——地点是否可接受取决于用户的求职偏好城市，
 * 不能默认同意（可能是外地岗位）。
 *
 * 联系方式卡片一律**不自动同意**：手机号/微信一旦给出无法收回，且大量索要
 * 联系方式的是垃圾招聘方（实测已误发一次给"日结300/天"的账号）。这类卡片
 * 只记日志留给用户手动决定 —— 自动化的边界是「可撤回或低代价」的动作。
 */
export async function handleCard(
  card: ChatCard,
  cfg: PluginConfig,
  expectThread: string,
  log: (m: string) => void,
): Promise<boolean> {
  // 点按钮前同样校验会话身份，防止中途切换点错人
  if (currentThreadId() !== expectThread) {
    diag('CHAT', '已中止卡片操作：会话已切换')
    return false
  }

  // 联系方式：不点任何按钮（同意=泄露手机号/微信，拒绝=可能误伤好岗位）。
  // 交给用户看到标记后自己决定，这是唯一安全的默认。
  if (card.kind === 'contact_exchange') {
    log('  ⚠ HR 索要联系方式 → 不自动处理，请手动决定（同意会发出手机号/微信）')
    diag('CHAT', '⚠ 跳过联系方式交换卡片（需人工决定）', {
      question: card.question.slice(0, 80),
    })
    return false
  }

  // 认不出的卡片一律不点：BOSS 会加新卡片类型，盲点等于把未知授权交给对方。
  if (card.kind === 'unknown') {
    log('  ⚠ 未识别的交互卡片 → 不自动处理，请手动查看')
    diag('CHAT', '⚠ 跳过未识别卡片（未知类型不自动点击）', {
      question: card.question.slice(0, 80),
    })
    return false
  }

  if (card.kind === 'resume_request') {
    if (!card.acceptBtn) return false
    log(`  ↳ HR 索要附件简历 → 点「同意」`)
    card.acceptBtn.click()
    await delay(1200, 2000)
    diag('CHAT', '已同意发送附件简历')
    return true
  }

  if (card.kind === 'location_confirm') {
    const prefCity = (cfg.prefCity || '').trim()
    const offCity = !!prefCity && !card.question.includes(prefCity)

    // 城市不符默认「接受并标记」而非拒绝：地点不该成为自动放弃机会的理由，
    // 用户可能愿意考虑。只有在设置里显式开启 rejectOffCityLocation 才拒绝。
    if (offCity && cfg.rejectOffCityLocation) {
      if (!card.rejectBtn) return false
      log(`  ↳ 地点与期望城市(${prefCity})不符，按设置拒绝`)
      card.rejectBtn.click()
      await delay(1200, 2000)
      diag('CHAT', '按设置拒绝工作地点', { prefCity, question: card.question.slice(0, 60) })
      return true
    }

    if (!card.acceptBtn) return false
    if (offCity) {
      // 标记：接受了但地点与期望不一致，留痕供用户复核
      log(`  ↳ 工作地点确认 → 已接受（注意：与期望城市 ${prefCity} 不一致）`)
      diag('CHAT', '⚠ 地点与期望城市不符但已接受（未开启严格模式）', {
        prefCity,
        question: card.question.slice(0, 80),
      })
    } else {
      log('  ↳ 工作地点确认 → 点「可以接受」')
    }
    card.acceptBtn.click()
    await delay(1200, 2000)
    return true
  }

  return false
}

/** 点「发简历」（HR 要简历时用） */
export async function sendResume(): Promise<boolean> {
  // 按可见文本定位（"发简历" 这类文案比 class 稳定得多）
  const btn = findByText(/^(发简历|发送简历|附件简历)$/, { clickable: true })
  if (!btn) {
    diag('CHAT', '未找到「发送简历」按钮')
    return false
  }

  // 禁用态检测：实测 BOSS 该按钮会带 unable 类（如未上传附件简历、或该会话不允许发）
  // 硬点无效还会误报成功，故先判再点。
  const cls = String(btn.className || '')
  const disabled =
    /unable|disabled|is-disabled/.test(cls) ||
    btn.getAttribute('aria-disabled') === 'true' ||
    getComputedStyle(btn).pointerEvents === 'none'
  if (disabled) {
    diag('CHAT', '「发简历」按钮处于禁用态，跳过', { cls: cls.slice(0, 60) })
    return false
  }

  btn.click()

  // 必须点掉「确定向 Boss 发送简历吗？」弹窗，否则简历根本没发出去
  // ——而我们已经跟 HR 说了"简历发您了"，属于说谎。
  //
  // 两个此前踩到的坑：
  // 1) BOSS 的「确定」是 div/span 不是 <button>，只查 button 找不到；
  // 2) 弹窗有入场动画，固定等 1.2s 可能还没渲染，需要轮询。
  const confirmed = await waitForResumeConfirm()
  if (!confirmed) {
    diag('CHAT', '⚠ 未找到简历确认弹窗的「确定」按钮，简历可能未真正发出')
    return false
  }

  diag('CHAT', '已发送简历（含确认弹窗）')
  return true
}

/**
 * 轮询等待并点击简历确认弹窗的「确定」。
 *
 * @returns 是否确认成功（没弹窗出现也算失败，调用方需据此判断是否真发出）
 */
async function waitForResumeConfirm(): Promise<boolean> {
  for (let i = 0; i < 16; i++) {
    await delay(300, 450)

    // 先定位弹窗容器：文案含"发送简历"且可见
    const dialogs = Array.from(
      document.querySelectorAll('div,section'),
    ) as HTMLElement[]
    const dialog = dialogs.find((d) => {
      const t = (d.textContent || '').replace(/\s/g, '')
      if (!/确定向Boss发送简历|该附件简历将直接发送/.test(t)) return false
      // 只要最内层那个容器，避免命中整个 body
      if (t.length > 200) return false
      const r = d.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    if (!dialog) continue

    // 在弹窗内找「确定」，排除「取消」
    const btns = Array.from(dialog.querySelectorAll('div,span,button,a')) as HTMLElement[]
    const ok = btns.find((el) => {
      const t = text(el).replace(/\s/g, '')
      if (!/^(确定|确认|发送)$/.test(t)) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    if (ok) {
      ok.click()
      await delay(900, 1500)
      diag('CHAT', '已点击简历确认弹窗「确定」')
      return true
    }
  }
  return false
}

/**
 * 托管一轮会话：遍历会话 → 读消息 → 后端生成回复 → 发送 → 回报。
 *
 * @param maxThreads 本轮最多处理几个会话（防跑飞）
 */
/**
 * 会话托管并发锁（模块级）。
 *
 * 必要性：编排器与手动按钮是两个入口，若同时跑同一批会话，
 * 双方各自切换会话、各自判重，判重记录还没写回就被另一方读到旧值，
 * 结果重复发消息给 HR（不可撤回）。锁在这里而不只在 UI 隐藏按钮，
 * 是因为 UI 只能防误点，防不住状态竞争。
 */
let chatRoundRunning = false

/**
 * 停止标志。会话托管一轮要跑几十秒到几分钟，中途必须能停下来
 * ——否则用户看着它往下发消息却只能刷新页面（刷新会丢掉本轮判重记录）。
 * 只在会话之间与发送之前检查，不打断已经发出的单次动作。
 */
let chatRoundAbort = false

/** 会话托管是否正在运行（供 UI 判断按钮状态） */
export function isChatRoundRunning(): boolean {
  return chatRoundRunning
}

/** 请求停止当前轮会话托管（下一个检查点生效，不会打断正在发送的那一条） */
export function requestStopChatRound(): void {
  if (!chatRoundRunning) return
  chatRoundAbort = true
  diag('CHAT', '已收到停止请求，将在当前会话处理完后结束')
}

function shouldAbortChatRound(): boolean {
  return chatRoundAbort
}

/**
 * 按「索引 + 身份文本」重新定位会话节点。
 *
 * 缓存的引用可能已因列表重建而失效（见调用处注释）。重新定位时优先用
 * 身份文本匹配而非纯索引：BOSS 会把有新消息的会话上浮，纯索引会张冠李戴，
 * 把 A 的回复发给 B。文本对不上就宁可跳过 —— 发错不可撤回。
 */
function resolveThread(cached: ChatThread): ChatThread | null {
  if (cached.el.isConnected) return cached

  const idKey = (t: ChatThread) => `${t.company}|${t.jobTitle}`
  const want = idKey(cached)
  const byText = listThreadsQuiet().filter((t) => idKey(t) === want)

  // 只认唯一命中。
  //
  // 不做「索引兜底」：targets 已按未读排序，下标与 DOM 顺序不再对应，
  // 拿排序后的下标去索引实时列表必然错位 —— 把 A 的回复发给 B，不可撤回。
  // 身份文本重复（同公司同岗位两个 HR）时也一样宁可跳过：无从分辨谁是谁。
  if (byText.length === 1) return byText[0]

  diag('CHAT', '会话节点重新定位失败', { want, sameTextCount: byText.length })
  return null
}

export async function runChatRound(
  cfg: PluginConfig,
  maxThreads = 5,
  log: (m: string) => void = () => {},
): Promise<{ handled: number; replied: number; deletedDetected: number; deletedRestored: number }> {
  if (chatRoundRunning) {
    log('已有会话托管在运行，本次跳过（防止重复发消息给 HR）')
    diag('CHAT', '拒绝并发的会话托管请求')
    return { handled: 0, replied: 0, deletedDetected: 0, deletedRestored: 0 }
  }
  chatRoundRunning = true
  // 必须在这里复位而不是在 stop 里：上一轮若因 abort 结束，标志还是 true，
  // 不复位则下一轮启动即刻自杀（表现为「点了开始，一条没处理就完成了」）。
  chatRoundAbort = false
  try {
    return await runChatRoundInner(cfg, maxThreads, log)
  } finally {
    chatRoundRunning = false
    chatRoundAbort = false
  }
}

/**
 * 会话身份键：用于跨滚动窗口去重（虚拟列表节点会被复用，引用不可靠）
 *
 * 优先级：
 * 1. BOSS 原生 ID（data-user-id / data-conversation-id 等属性）
 * 2. 降级：公司名 + 岗位名（文本可能被BOSS截断或修改，不如原生ID稳定）
 */
function threadKey(t: ChatThread): string {
  // 尝试从 DOM 元素及其子节点提取 BOSS 的唯一标识
  const el = t.el
  const bossId =
    el.getAttribute('data-user-id') ||
    el.getAttribute('data-conversation-id') ||
    el.getAttribute('data-geek-id') ||
    el.getAttribute('data-boss-id') ||
    el.querySelector('[data-user-id]')?.getAttribute('data-user-id') ||
    el.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id') ||
    el.querySelector('[data-geek-id]')?.getAttribute('data-geek-id')

  if (bossId) {
    diag('CHAT', `threadKey 使用原生ID: ${bossId}`, { company: t.company })
    return `boss:${bossId}`
  }

  // 降级：使用文本标识
  const fallback = `${t.company}|${t.jobTitle}`.replace(/\s+/g, '')
  // 只在第一次使用文本键时警告（避免刷屏）
  if (!threadKey._warnedFallback) {
    diag('CHAT', `threadKey 未找到原生ID，使用文本键（可能不稳定）`, {
      sample: fallback.slice(0, 50),
    })
    threadKey._warnedFallback = true
  }
  return fallback
}
// 警告标志位（防止每个会话都打一次日志）
threadKey._warnedFallback = false as boolean

/**
 * 滚动会话列表并回调新出现的会话（增量遍历）。
 *
 * 为什么不是「先全量加载完再遍历」（2026-08-01 第三次返工，架构性改动）：
 * BOSS 会话列表是**虚拟列表** —— DOM 里恒定只有约 40 个节点，向下滚时
 * 节点被复用、只换里面的数据。因此
 *   - `allMatch(SEL.thread).length` 永远约等于 40，涨不上去，「数量稳定=到底」不成立；
 *   - 滚过去的会话节点会被回收，缓存的引用变成孤儿（见 resolveThread 注释）；
 *   - 「列表全部加载完」这个状态根本不存在，等多少轮都等不到。
 *
 * 上一版靠底部「没有更多了」标记判断，也是错的：那个占位符是 BOSS 常驻渲染的，
 * 第一次滚到底 scrollPct 就≈1.0，两个条件同时成立 → 第 40 个会话处就误报到底
 * （用户实测：实际还有几十个会话没处理）。
 *
 * 正确做法：把「加载」和「遍历」合成一件事。每滚一屏就处理当前窗口里
 * 没见过的会话（按身份键去重），处理完再滚。这样虚拟列表回收节点也不影响，
 * 因为我们从不隔着滚动持有引用。
 *
 * 终止条件是「连续 N 屏没有任何新身份出现」，而非任何页面标记 ——
 * 行为特征不受 BOSS 改版影响。
 *
 * @param onThread 处理单个会话，返回 'stop' 可提前终止整轮滚动
 */
async function forEachThreadScrolling(
  log: (m: string) => void,
  onThread: (t: ChatThread, seq: number) => Promise<'ok' | 'stop'>,
): Promise<void> {
  // 容器每屏重新定位，不缓存单个引用：切换会话会让 BOSS 重建左侧列表，
  // 开头拿到的容器可能已脱离文档 —— 对孤儿节点设 scrollTop 不会有任何效果，
  // 表现就是「滚动没反应、一直在第一屏」。这与 resolveThread 处理的是同一类问题。
  let container = findThreadScrollContainer()
  if (!container) {
    log('未找到会话列表滚动容器，仅处理当前已渲染的会话')
    diag('CHAT', '滚动容器查找失败，退化为单屏处理')
  } else {
    diag('CHAT', '会话列表滚动容器', {
      el: `${container.tagName.toLowerCase()}.${String(container.className || '').slice(0, 40)}`,
      scrollH: container.scrollHeight,
      clientH: container.clientHeight,
      windowCount: allMatch(SEL.thread).length,
    })
  }

  // 从列表顶部开始。
  //
  // 必须显式复位（2026-08-01 实测）：上一轮或用户的其它操作
  // （删除功能里的 scrollIntoView、手动滚动）会把 scrollTop 留在中间。
  // 那时第 0 屏拿到的是列表中段，而后续 `scrollTo(step*(screen+1))` 反而
  // 往**上**滚，于是列表顶部那批会话被留到最后处理 —— 日志顺序看起来像
  // 「先走中段、又从头走一遍」，用户据此判断为重复遍历。
  if (container) {
    container.scrollTo({ top: 0 })
    await delay(400, 600)
  }

  const seen = new Set<string>()
  let seq = 0
  // 连续多少屏没有新身份就认定到底。取 3：BOSS 偶发一屏内全是已处理过的
  // 会话（未读上浮导致顺序变动），单屏无新增不足以判定结束。
  const EMPTY_SCREENS_TO_END = 3
  let emptyScreens = 0
  // 兜底上限：按每屏净新增 ≥1 估算，300 屏足以覆盖数百条会话，
  // 同时防止 BOSS 改版导致的死循环。
  const MAX_SCREENS = 300

  for (let screen = 0; screen < MAX_SCREENS; screen++) {
    if (shouldAbortChatRound()) {
      diag('CHAT', '滚动遍历时收到停止指令')
      return
    }

    // 当前窗口内的会话，未读优先（同屏内调顺序，不跨屏排序 —— 跨屏排序需要
    // 先全量加载，而虚拟列表下那是做不到的）
    const windowThreads = listThreadsQuiet()
      .map((t, i) => ({ t, i }))
      .sort((a, b) => Number(b.t.unread) - Number(a.t.unread) || a.i - b.i)
      .map((x) => x.t)

    let fresh = 0
    for (const t of windowThreads) {
      const key = threadKey(t)
      if (!key || key === '|') {
        diag('CHAT', '跳过无效键的会话项', { company: t.company, jobTitle: t.jobTitle })
        continue // 身份不可辨的项跳过，避免污染去重集
      }
      if (seen.has(key)) {
        diag('CHAT', `跳过已处理会话 key="${key}"`, {
          company: t.company,
          jobTitle: t.jobTitle,
          seenSize: seen.size,
          screen,
        })
        continue
      }

      diag('CHAT', `准备处理新会话 #${seq + 1} key="${key}"`, {
        company: t.company,
        jobTitle: t.jobTitle,
        seenSize: seen.size,
        screen,
      })
      seen.add(key)
      fresh++
      seq++

      // 处理前重新确认节点仍在文档里：同屏内处理上一条会话
      // （切换会话）就可能让 BOSS 重建列表
      const live = t.el.isConnected ? t : resolveThread(t)
      if (!live) {
        diag('CHAT', '会话节点在处理前已失效', { key })
        continue
      }

      const r = await onThread(live, seq)
      if (r === 'stop') return
      if (shouldAbortChatRound()) return
    }

    if (fresh > 0) {
      emptyScreens = 0
      log(`已处理 ${seen.size} 个会话，继续下翻...`)
    } else {
      emptyScreens++
      if (emptyScreens >= EMPTY_SCREENS_TO_END) {
        diag('CHAT', `会话列表遍历结束：连续 ${EMPTY_SCREENS_TO_END} 屏无新会话`, {
          total: seen.size,
          screens: screen + 1,
        })
        log(`会话列表已遍历完毕（共 ${seen.size} 个）`)
        return
      }
    }

    // 容器可能已被重建（处理会话时切换过），重新定位后再滚
    if (!container?.isConnected) container = findThreadScrollContainer()
    if (!container) {
      diag('CHAT', '滚动容器已失效且无法重新定位，结束遍历', { total: seen.size })
      return
    }

    // 目标位置按「已滚过的屏数」算，而不是「当前 scrollTop + 一屏」。
    //
    // 关键（防回到起点）：切换会话后 BOSS 可能把列表 scrollTop 复位为 0。
    // 若按当前值递增，就会从头再滚一遍 → 每屏都是已见过的会话 → fresh 恒为 0
    // → 三屏后误判「遍历完毕」，实际只覆盖了前 40 个。这正是上一版
    // 「第 40 个就停」的同一个坑换了个形式，必须用绝对位置。
    const step = Math.max(1, Math.floor(container.clientHeight * 0.8)) // 留 20% 重叠防漏
    const target = step * (screen + 1)
    const maxScroll = container.scrollHeight - container.clientHeight
    if (target > maxScroll + step) {
      // 已经越过底部：不再有新内容可加载，交给 emptyScreens 收尾
      emptyScreens++
      if (emptyScreens >= EMPTY_SCREENS_TO_END) {
        diag('CHAT', '已滚过列表底部且无新会话，遍历结束', { total: seen.size, maxScroll })
        log(`会话列表已遍历完毕（共 ${seen.size} 个）`)
        return
      }
    }
    container.scrollTo({ top: Math.min(target, maxScroll) })
    await delay(600, 850) // 等虚拟列表渲染新窗口
  }

  diag('CHAT', `滚动屏数达上限 ${MAX_SCREENS}，已处理 ${seen.size} 个会话`)
  log(`⚠ 会话过多（已处理 ${seen.size} 个），剩余下轮继续`)
}

/**
 * 找会话列表的滚动容器。
 *
 * 之前只认 `overflowY: auto|scroll`，实测在 BOSS 上找不到（列表停在 40 个不动）：
 * 容器可能用 `overlay`，也可能滚动发生在更外层的祖先上。
 * 改为按「实际可滚动」判定 —— scrollHeight 明显大于 clientHeight，
 * 这是行为特征而非样式特征，不受 BOSS 换 CSS 影响。
 */
function findThreadScrollContainer(): HTMLElement | null {
  const first = firstMatch(SEL.thread)
  if (!first) return null

  let cur: HTMLElement | null = first.parentElement
  let fallback: HTMLElement | null = null
  for (let i = 0; i < 10 && cur; i++) {
    const st = getComputedStyle(cur)
    const scrollable = cur.scrollHeight > cur.clientHeight + 4
    if (scrollable && /auto|scroll|overlay/.test(st.overflowY)) return cur
    // 样式没声明但实际能滚的，留作兜底（BOSS 的虚拟列表属于这种）
    if (scrollable && !fallback) fallback = cur
    cur = cur.parentElement
  }
  return fallback
}

/**
 * 滚动遍历会话列表，收集全部会话身份。
 *
 * BOSS 会话列表是懒加载/虚拟列表（窗口只渲染约 40 条），滚动到底后 DOM 里
 * 仍是当前窗口 —— 直接读一遍会漏掉列表前部的会话，对账必误判删除。
 * 这里逐屏滚动、按身份键去重收集，与 forEachThreadScrolling 同一套行为。
 *
 * @returns fullyLoaded=false 表示未能确认扫完（找不到容器/连续多屏无新增却
 *   未到底/超屏数上限），调用方此时应跳过本轮删除判定。
 */
async function collectAllThreads(): Promise<{ threads: ChatThread[]; fullyLoaded: boolean }> {
  const container = findThreadScrollContainer()
  if (!container) {
    // 没有可滚动容器 = 会话少、一屏装得下（实测 10 条、无滚动条）。
    // 此时当前可见即全部 —— 若按「未扫完」处理，小列表永远无法对账判删。
    // 判定删除还有「连续 2 轮消失 + 重新出现自动恢复」两道防线兜底。
    const threads = listThreads()
    diag('CHAT', `无滚动容器，按当前可见 ${threads.length} 条即全量处理`)
    return { threads, fullyLoaded: true }
  }

  // 从顶部开始（与 forEachThreadScrolling 一致，避免上次滚动位置影响收集）
  container.scrollTo({ top: 0 })
  await delay(400, 600)

  const byKey = new Map<string, ChatThread>()
  // 到底后连续几屏没有新身份才确认扫完（懒加载在底部追加时会撑高容器）
  const CONFIRM_SCREENS_AT_BOTTOM = 2
  let bottomScreens = 0

  for (let screen = 0; screen < 300; screen++) {
    for (const t of listThreadsQuiet()) {
      const key = threadKey(t)
      if (key && key !== '|' && !byKey.has(key)) byKey.set(key, t)
    }

    const before = container.scrollTop
    container.scrollBy({ top: Math.floor(container.clientHeight * 0.9) })
    await delay(300, 500)

    const moved = Math.abs(container.scrollTop - before) >= 10
    const atBottomEdge = container.scrollTop + container.clientHeight >= container.scrollHeight - 8
    if (!moved || atBottomEdge) {
      bottomScreens++
      if (bottomScreens >= CONFIRM_SCREENS_AT_BOTTOM) {
        diag('CHAT', `会话列表收集完成：${byKey.size} 个唯一会话（${screen + 1} 屏）`)
        return { threads: Array.from(byKey.values()), fullyLoaded: true }
      }
    } else {
      bottomScreens = 0
    }
  }

  diag('CHAT', '会话列表滚动未确认到底，本轮跳过删除判定')
  return { threads: Array.from(byKey.values()), fullyLoaded: false }
}

/**
 * 托管开始前（或用户手动点「对账」）执行：把 BOSS 会话列表滚动加载到底，
 * 再与后端清单对账 —— 后端有、BOSS 无 的会话连续 N 轮消失后自动进已删除台账。
 *
 * 误报防线：列表未确认加载完 / manifest 拉取失败都不判删；重新出现的会话自动恢复。
 */
export async function runDeletionReconcile(
  cfg: PluginConfig,
  log: (m: string) => void = () => {},
): Promise<{ detected: number; restored: number; manifestCount: number }> {
  let collected: { threads: ChatThread[]; fullyLoaded: boolean }
  try {
    collected = await collectAllThreads()
  } catch (e) {
    diag('CHAT', `会话列表加载滚动异常: ${(e as Error).message}`)
    collected = { threads: [], fullyLoaded: false }
  }
  const ledger = await syncDeletions(
    cfg,
    collected.threads.map((t) => ({ company: t.company, jobTitle: t.jobTitle })),
    collected.fullyLoaded,
  )
  if (ledger.detected || ledger.restored) {
    log(`  ↳ 已删除台账：新删 ${ledger.detected} 个，恢复 ${ledger.restored} 个（清单 ${ledger.manifestCount} 条，列表完整=${collected.fullyLoaded}）`)
  }
  return ledger
}

async function runChatRoundInner(
  cfg: PluginConfig,
  maxThreads: number,
  log: (m: string) => void,
): Promise<{ handled: number; replied: number; deletedDetected: number; deletedRestored: number }> {
  let handled = 0
  let replied = 0

  log(`开始遍历会话列表（动作预算 ${maxThreads}）。运行中请勿手动点击会话列表。`)
  // 同步进导出日志：此前决策过程只写 UI 面板（log），导出日志里只剩
  // 「消息判定/会话归属」两行，用户发来的日志看不出任何会话是为什么被跳过的，
  // 排查只能靠猜。凡影响「回不回复」的判断，都必须同时 diag。
  diag('CHAT', `本轮开始遍历会话，动作预算 ${maxThreads}`)

  // —— 托管开始前的同步 + 对账（本地优先的数据一致性机制）——
  // 先把 BOSS 会话列表滚动加载到底，再与后端清单对账：后端有、BOSS 无 的会话
  // 连续 N 轮消失后自动进已删除台账（本地列表立即消失 + 上报后端落库），
  // 解决「用户手动删了 BOSS 会话，插件列表还挂着死条目」的消息不对称。
  const ledger = await runDeletionReconcile(cfg, log)

  // ========== v0.3.0 性能优化：两阶段处理 ==========
  // 阶段1：快速扫描 - 只读取会话数据，不调用后端
  // 阶段2：批量处理 - 一次性调用后端批量分类
  // 阶段3：发送回复 - 根据结果发送消息

  interface PendingConversation {
    thread: ChatThread
    threadId: string
    messages: Array<{ sender: 'hr' | 'me'; content: string }>
    company: string
    jobTitle: string
    salary?: string
    city?: string
    cards: Array<{ kind: string; question: string }>
    shouldSkip: boolean
    skipReason?: string
  }

  const pendingConversations: PendingConversation[] = []

  log('【阶段1/3】快速扫描会话...')
  diag('CHAT', '开始阶段1：快速扫描')

  // 遍历方式：滚动窗口增量处理（见 forEachThreadScrolling 注释）。
  await forEachThreadScrolling(log, async (t, seq) => {
    const threadId = currentThreadId()
    handled++

    // 快速跳过检查（无需调用后端的情况）
    const quickSkip = await checkQuickSkip(t, cfg, log)
    if (quickSkip.should) {
      pendingConversations.push({
        thread: t,
        threadId,
        messages: [],
        company: t.company,
        jobTitle: t.jobTitle,
        cards: [],
        shouldSkip: true,
        skipReason: quickSkip.reason,
      })
      return 'ok'
    }

    // 切换到该会话
    await openThread(t.company, t.jobTitle)
    await delay(500, 1000)

    // 读取消息
    const messages = await readMessages()
    diag('CHAT', `消息判定 mid=${seq}`, [
      messages.map((m) => {
        const r = m.sender === 'hr' ? '1' : '1'
        const av = m.sender === 'hr' ? '1' : '0'
        return `${m.sender.toUpperCase()}|cls=message-item item-${m.sender === 'hr' ? 'friend' : 'myself'}|st=${r}|av=${av}|x=1144`
      }),
    ])

    // 读取会话信息
    const info = currentThreadInfo()
    const { company, jobTitle, salary, city } = info
    diag('CHAT', `会话归属信息 company="${company}" job="${jobTitle}"`)

    // 检测交互卡片
    const cards = findPendingCards()

    // 存入待处理列表
    pendingConversations.push({
      thread: t,
      threadId,
      messages,
      company,
      jobTitle,
      salary,
      city,
      cards,
      shouldSkip: false,
    })

    return 'ok'
  })

  log(`【阶段2/3】批量分类 ${pendingConversations.length} 个会话...`)
  diag('CHAT', `开始阶段2：批量分类 ${pendingConversations.length} 个会话`)

  // 过滤出需要调用后端的会话
  const needsBackend = pendingConversations.filter(c => !c.shouldSkip)

  if (needsBackend.length === 0) {
    log('所有会话均已跳过，无需调用后端')
    return { handled, replied: 0, deletedDetected: ledger.detected, deletedRestored: ledger.restored }
  }

  // 批量调用后端
  const batchPayload = needsBackend.map(c => ({
    platform: 'zhipin',
    platform_job_id: '',
    company: c.company,
    job_title: c.jobTitle,
    messages: c.messages.map(m => ({
      sender: m.sender === 'hr' ? 'hr' : 'me',
      content: m.content,
      timestamp: '',
    })),
    auto_reply: true,
    min_reply_score: cfg.minReplyScore,
    salary: c.salary || '',
    city: c.city || '',
  }))

  const results = await syncChatBatch(cfg, batchPayload)

  log(`【阶段3/3】发送回复...`)
  diag('CHAT', `开始阶段3：发送回复`)

  // 阶段3：根据结果发送回复
  for (let i = 0; i < needsBackend.length; i++) {
    const conv = needsBackend[i]
    const res = results[i]

    if (replied >= maxThreads) {
      log(`已达动作上限 ${maxThreads}，剩余会话不再处理`)
      break
    }

    if (shouldAbortChatRound()) {
      log('用户已停止，中止发送')
      break
    }

    // 切换到该会话
    await openThreadWithScroll(conv.company, conv.jobTitle)
    await delay(500, 1000)

    if (!res) {
      log(`  [${conv.company}] 后端处理失败，跳过`)
      continue
    }

    // 同步成功 → 更新本地镜像（列表即时反映，不用等下一轮服务器拉取）
    if (res.conversation_id) {
      await upsertMirrorFromSync({
        conversation_id: res.conversation_id,
        company: conv.company,
        jobTitle: conv.jobTitle,
        messages: conv.messages,
      })
    }

    // 记录后端返回
    diag('CHAT', `后端返回 ${conv.company}`, {
      intent: res.intent,
      newMessages: res.new_messages,
      hasReply: !!res.reply,
      message: (res.message || '').slice(0, 80),
    })

    if (!res.reply) {
      // 处理各种无需回复的情况
      if (res.intent === 'low_score_skip' || res.intent === 'no_score_skip') {
        const noScore = res.intent === 'no_score_skip'
        const why = noScore
          ? '该岗位未经匹配评分（HR 主动打招呼，非你投递的）'
          : `匹配分低于阈值 ${cfg.minReplyScore} 分`
        log(`  [${conv.company}] ⊘ 低质量跳过：${why}`)
        diag('CHAT', `低质量跳过 ${conv.company}`, {
          intent: res.intent,
          threshold: cfg.minReplyScore,
          backendMessage: res.message || '-',
        })
        // 缓存低分判定：下一轮在切换会话之前就能跳过（见 checkQuickSkip）。
        // 列表项身份与头部身份各记一份（两处文本形态不同，threadKey 不同）
        await recordLowScore(conv.company, conv.jobTitle, cfg.minReplyScore)
        await recordLowScore(conv.thread.company, conv.thread.jobTitle, cfg.minReplyScore)
      } else {
        log(`  [${conv.company}] 无需回复（${res.message || ''}）`)
        diag('CHAT', `后端判定无需回复 ${conv.company}`, { reason: res.message || '-' })
      }
      continue
    }

    // 发送回复
    log(`  [${conv.company}] 回复: ${res.reply}`)
    const ok = await sendText(res.reply, conv.threadId)

    if (ok) {
      replied++
      if (res.send_resume) {
        const resumeOk = await sendResume()
        if (!resumeOk) log('  ↳ 简历未发出，需手动处理')
      }
      if (res.action_id) {
        await markChatSent(cfg, res.action_id, true, '')
      }
    } else {
      log(`  [${conv.company}] 未发送（会话已切换或发送失败）`)
      if (res.action_id) {
        await markChatSent(cfg, res.action_id, false, '页面发送未确认')
      }
    }

    await delay(2000, 4000) // 会话间间隔
  }

  log(`批量处理完成：扫描 ${pendingConversations.length} 个会话，发送 ${replied} 条回复`)
  diag('CHAT', `批量处理完成 handled=${handled} replied=${replied}`)

  return { handled, replied, deletedDetected: ledger.detected, deletedRestored: ledger.restored }
}

/** 最近成功同步过的会话，在冷却期内直接跳过（省掉切换 + 读消息） */
const RECENT_HANDLED_COOLDOWN_MS = 10 * 60 * 1000

/** 最近是否已处理过（有成功同步记录且在冷却期内）；未读优先放行 */
async function getRecentlyHandled(company: string, jobTitle: string, hasUnread: boolean): Promise<boolean> {
  if (hasUnread) return false
  const rec = await getThread(company, jobTitle)
  if (!rec || !rec.lastSyncedAt) return false
  return Date.now() - rec.lastSyncedAt < RECENT_HANDLED_COOLDOWN_MS
}

/** 是否命中缓存的低分判定（判定过期或用户调低阈值后失效，见 chat-store） */
async function getCachedLowScore(company: string, jobTitle: string, threshold: number): Promise<boolean> {
  const rec = await getThread(company, jobTitle)
  return !!rec && isKnownLowScore(rec, threshold)
}

// 辅助函数：快速跳过检查（无需调用后端）
async function checkQuickSkip(
  t: ChatThread,
  cfg: PluginConfig,
  log: (m: string) => void,
): Promise<{ should: boolean; reason?: string }> {
  const { company, jobTitle } = t

  // 检查是否最近已处理过（去重）
  const recent = await getRecentlyHandled(company, jobTitle, t.unread)
  if (recent) {
    log(`  [${company}] 跳过：最近已处理`)
    return { should: true, reason: '最近已处理' }
  }

  // 检查是否缓存为低分
  const cached = await getCachedLowScore(company, jobTitle, cfg.minReplyScore)
  if (cached) {
    log(`  [${company}] 跳过：缓存的低匹配分`)
    return { should: true, reason: '缓存的低匹配分' }
  }

  return { should: false }
}
