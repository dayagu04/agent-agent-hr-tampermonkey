// BOSS 聊天页操作（/web/geek/chat）
//
// 职责：读会话列表与消息 → 交后端分类并生成回复 → 在页面内发送 → 回报结果。
// 投递在 /web/geek/jobs，沟通在 /web/geek/chat，两页 DOM 完全不同，故单独成模块。
//
// 红线：只在用户显式启动「会话托管」后运行。发给 HR 的消息不可撤回，
// 全过程由后端 conversation_* 三表留痕（意图/回复/发送结果）供事后评判。
import { diag } from '../logger'
import type { PluginConfig } from '../types'
import { markChatSent, markConversationDeleted, syncChatOne } from '../api'
import { removeMirrorByKey } from '../ledger'
import { loadConfig } from '../config'
import { findByText, findChatPanel, findEditable } from '../domprobe'
import { clickDirect, realClick } from '../dom-events'
import {
  clickDeleteInHeaderMenu,
  confirmDeleteDialog,
  deleteViaRowVue,
  dumpDeleteDiagnostics,
  findBossObject,
  findDeleteItemInPopup,
  isTopmostAtCenter,
  revealOperateBtn,
  unmarkOperateRow,
} from './boss-delete'
import { reportThreadSnapshotOnce } from '../thread-snapshot'

/** 聊天页单个会话条目 */
export interface ChatThread {
  el: HTMLElement
  /** HR 姓名（span.name-text） */
  name: string
  company: string
  jobTitle: string
  unread: boolean
  /** 列表行最后一条消息预览（.last-msg / .friend-content），用于免开预判 */
  preview: string
}

const SEL = {
  // 会话列表项（多套候选，BOSS 改版频繁）
  thread: [
    '.geek-item',
    '.user-list li',
    '[class*="chat-user-item"]',
    'li[role="listitem"]',
  ],
  // 消息正文在 span.text-content
  msgText: ['span.text-content', '.text-content'],
  // 会话身份锚点：头部姓名 + 岗位名，用于发送前校验「当前会话是否仍是目标会话」
  headerPosition: ['span.position-name', '.position-name'],
  // 头部薪资/城市：给 HR 主动打招呼的岗位补匹配分 ——
  // 这类岗位用户没投过、库里没 JD，但头部字段足够让匹配引擎跑出分辨力
  headerSalary: ['span.salary', '.salary'],
  headerCity: ['span.city', '.city'],
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

/**
 * 记录一条会话的完整对话历史到插件日志（批量上传后端 /api/plugin/logs）。
 *
 * 用途：后续根据对话历史决定「会话删除策略」（如 HR 已读超时未回、
 * 我方最后发言且 HR 长时间未回应 → 判定流程结束可删除）。
 * 逐条成行记录避免日志截断；消息正文服务端上限 4000 字符。
 *
 * @param t      会话列表项（提供公司/岗位与最后消息时间文本）
 * @param messages 读取到的消息（sender: hr | me）
 */
function logChatHistory(
  t: ChatThread,
  messages: Array<{ sender: 'hr' | 'me' | 'system'; content: string }>,
): void {
  const company = t.company || '未知公司'
  const jobTitle = t.jobTitle || '未知岗位'
  const timeText = (t.el.querySelector('span.time, .time')?.textContent || '').trim()
  diag('HIST', `会话历史 ${company} | ${jobTitle} | 共 ${messages.length} 条 | 最后消息 ${timeText || '未知时间'}`)
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const who = m.sender === 'hr' ? 'HR' : m.sender === 'system' ? '系统' : '我'
    const content = (m.content || '').replace(/\s+/g, ' ').trim().slice(0, 500)
    if (content) diag('HIST', `  #${i + 1} [${who}] ${content}`)
  }
}

/** 是否在 BOSS 聊天页 */
export function onChatPage(): boolean {
  return /\/web\/geek\/chat/.test(location.pathname)
}

/**
 * 通过 Vue 实例直接切换会话（首选方案）。
 *
 * 合成鼠标/pointer 事件点击会话列表不可靠（头部 nowId 始终不变），
 * 而会话项挂着 __vue__，可直接读组件数据、调组件方法，绕开事件模拟。
 *
 * @returns 是否成功触发切换
 */
function switchThreadViaVue(el: HTMLElement): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vm = (el as any).__vue__
  if (!vm) return false

  // 元素必须仍挂在文档上：虚拟列表滚动时会重建节点，脱离 DOM 的引用
  // 即使 __vue__ 仍在、方法调得通，页面也不会响应。
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
    // 结构：div.title-box > span.name-box > span.name-text + i.vline + <公司/职位元素>。
    // 列表项没有独立岗位名元素；公司取 name-box 全文去掉姓名后的剩余。
    const name = text(el.querySelector('.name-text'))
    let company = text(el.querySelector('.name-box'))
    if (name && company.startsWith(name)) {
      company = company.slice(name.length).trim()
    }
    const jobTitle = text(el.querySelector('[class*="job"], .source-job'))
    // 未读标记：红点/数字气泡
    const unread = !!el.querySelector('.badge-count, [class*="badge"], [class*="unread"]')
    const preview = text(
      el.querySelector('.gray.last-msg') ||
      el.querySelector('.last-msg') ||
      el.querySelector('.friend-content'),
    ).replace(/\s+/g, ' ').trim()
    threads.push({ el, name, company: company || name, jobTitle, unread, preview })
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
  // 岗位名提取缺失诊断：BOSS 列表条目通常含岗位名，提取不到说明选择器需要修正。
  // 每次页面加载只 dump 一次前 3 条的结构到日志，用户回传日志即可开发（不靠猜测）。
  if (!dumpedMissingJobTitle) {
    const missingJob = threads.filter((t) => !t.jobTitle).slice(0, 3)
    if (missingJob.length) {
      dumpedMissingJobTitle = true
      diag(
        'CHAT',
        `会话条目缺少岗位名（${missingJob.length}/${threads.length} 条），dump 结构`,
        missingJob.map((t) => ({
          el: `${t.el.tagName.toLowerCase()}.${String(t.el.className || '').split(/\s+/).slice(0, 3).join('.')}`,
          text: (t.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          children: Array.from(t.el.querySelectorAll('[class]')).slice(0, 15).map(
            (e) =>
              `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).split(/\s+/).slice(0, 2).join('.')}`,
          ),
        })),
      )
    }
  }
  return threads
}

/** boss 对象上可能的岗位名字段（与头部 span.position-name 同名优先） */
const JOB_TITLE_KEYS = ['positionName', 'position_name', 'jobTitle', 'jobName', 'postName']
/** boss 对象上可能的薪资字段 */
const SALARY_KEYS = ['salary', 'salaryDesc', 'salaryText', 'salaryInfo', 'price', 'jobSalary']
/** 泛化键（position/job）可能是「人事/招聘经理」这类角色而非岗位名，需过滤 */
const ROLE_ONLY = /^(hr|人事|招聘经理|招聘主管|招聘专员|猎头顾问|总监|经理|主管|顾问)$/i

/**
 * 无感读取列表行的岗位名/薪资。
 *
 * 列表项 DOM 里没有岗位名（岗位名只在会话头部），但行组件 Vue 实例的
 * boss 对象通常带 positionName / salary，直接读对象即可，无需切换会话。
 * 找不到时 dump 一次 boss 对象键供适配（不往 BOSS 对象上写任何字段）。
 */
export function readRowJobInfo(li: HTMLElement): {
  title: string
  salary: string
  jobId: string
  brandName: string
  hrName: string
} {
  const hosts = [
    li.querySelector('.gray.last-msg'),
    li.querySelector('.last-msg'),
    li.querySelector('.friend-content'),
    li,
  ].filter(Boolean) as HTMLElement[]
  for (const host of hosts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vm = (host as any).__vue__
    if (!vm) continue
    const boss = findBossObject(vm)
    if (!boss?.obj) continue
    let title = ''
    let salary = ''
    const jobId = String(boss.obj.encryptJobId || boss.obj.jobId || '')
    const brandName = String(boss.obj.brandName || '')
    const hrName = String(boss.obj.name || '')
    for (const k of JOB_TITLE_KEYS) {
      const v = boss.obj[k]
      if (typeof v === 'string' && v.trim()) {
        title = v.trim()
        break
      }
    }
    for (const k of ['position', 'job']) {
      const v = boss.obj[k]
      if (!title && typeof v === 'string' && v.trim() && !ROLE_ONLY.test(v.trim())) {
        title = v.trim()
        break
      }
    }
    for (const k of SALARY_KEYS) {
      const v = boss.obj[k]
      if (typeof v === 'string' && /\d/.test(v)) {
        salary = v.trim()
        break
      }
    }
    if (title || salary || jobId) {
      return { title, salary, jobId, brandName, hrName }
    }
    // 页面加载内只 dump 一次，避免刷屏
    if (!dumpedBossKeys) {
      dumpedBossKeys = true
      diag('CHAT', 'boss 对象无岗位名/薪资/jobId，dump 键（供适配）', {
        path: boss.path,
        keys: Object.keys(boss.obj).filter((k) => !k.startsWith('_')).slice(0, 25),
        strings: Object.entries(boss.obj)
          .filter(([, v]) => typeof v === 'string' && (v as string).length < 30)
          .slice(0, 15),
      })
    }
    return { title: '', salary: '', jobId: '', brandName, hrName }
  }
  return { title: '', salary: '', jobId: '', brandName: '', hrName: '' }
}

/** 页面加载内只 dump 一次 boss 对象键 */
let dumpedBossKeys = false

/** 页面加载内只 dump 一次岗位名缺失诊断，避免 60s 刷新刷屏日志 */
let dumpedMissingJobTitle = false
/**
 * 删除指定会话。
 *
 * 完整流程：
 *   1. 滚动找到目标会话项（虚拟列表只渲染约 40 项，窗口外的找不到）
 *   2. 鼠标移到该项 → 右下角出现「···」按钮（Vue 条件渲染，非 CSS 隐藏）
 *   3. 点「···」→ 弹出浮层菜单（只有「置顶」「删除」两项）
 *   4. 点「删除」→ 弹「确认删除吗？」→ 点「确定」
 *   5. 校验该会话确实从列表消失
 *
 * 不走右侧会话头部菜单：那条路要先切换会话（多一次切换 + 身份核对，
 * 且会改变用户当前正在看的会话）。
 *
 * @returns 'ok' 已删除 | 'not-found' 列表里没有匹配项 | 'failed' 找到但删除失败
 */
async function deleteThreadImpl(
  company: string,
  jobTitle = '',
): Promise<'ok' | 'not-found' | 'failed'> {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const target = norm(company)
  if (!target) return 'not-found'
  const wanted = norm(jobTitle)

  // 只按公司名匹配，不要求岗位名对上：列表项 company 是「姓名+公司+职务」
  // 的拼接串（如"余先生新东方招聘主管"），且通常没有独立的岗位名字段，
  // jobTitle 恒为空。同公司多会话会命中第一个，这是 DOM 信息量的限制。
  const match = (t: ChatThread) => norm(t.company).includes(target)
  void wanted

  // 步骤 1：找到会话项（含滚动查找）
  const hit = await findThreadByScrolling(match)
  if (!hit) {
    diag('CHAT', `deleteThread 未找到会话（含滚动查找）: ${company}`)
    return 'not-found'
  }

  // 删除结果校验按「身份是否还在列表里」判断：虚拟列表节点数恒定，
  // 删一条后下一条补位、长度不变，不能比长度或 isConnected。
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

    // 首选：直接调用该行组件自己的 deleteBoss()。
    // 它就是「删除」菜单项最终调用的方法，跳过全部 DOM 交互，
    // 且作用对象就是这一行，不存在删错会话的可能。
    if (deleteViaRowVue(hit.el)) {
      if (await confirmAndVerify('deleteViaRowVue')) return 'ok'
      diag('CHAT', 'deleteViaRowVue 调用成功但会话仍在列表，继续尝试点击路径')
    }

    // 步骤 2：唤出「···」按钮（注入 CSS 绕过 :hover 闸门，见 boss-delete.ts）
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

    // 步骤 3：点「···」展开菜单。判据是「中心点处最上层的节点是不是它自己」，
    // 被其它节点盖住时必须直接派发到目标元素本身。
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
      // 降级到头部菜单（常驻 DOM、点击展开）；它作用于当前打开的会话，
      // 必须先切到目标会话并核对身份 —— 由 deleteViaHeaderMenu 内部把关。
      if (await deleteViaHeaderMenu(hit)) return 'ok'
      return 'failed'
    }

    // 步骤 4：点「删除」→ 确认弹窗
    unmarkOperateRow(hit.el) // 菜单已出，撤掉强制样式，避免留下视觉异常
    realClick(del)
    await delay(300, 450)
    const confirmed = await confirmDeleteDialog()
    if (!confirmed) {
      // 可能 BOSS 已改为无需确认，交给后续校验判定
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
    diag('CHAT', 'deleteThread 流程走完但会话仍在列表中，改走头部菜单', { company: hit.company })
    // 列表路径走完仍在 → 再试头部菜单（同上，身份由内部核对）
    if (await deleteViaHeaderMenu(hit)) return 'ok'
    return 'failed'
  } catch (e) {
    diag('CHAT', `deleteThread 异常: ${(e as Error).message}`)
    unmarkOperateRow(hit.el)
    return 'failed'
  }
}

/** 删除会话（手动路径）：成功后同步标记后端记录 + 清本地镜像 */
export async function deleteThread(
  company: string,
  jobTitle = '',
): Promise<'ok' | 'not-found' | 'failed'> {
  const r = await deleteThreadImpl(company, jobTitle)
  if (r === 'ok') afterConversationDeleted(company, jobTitle, 'manual')
  return r
}

/**
 * 降级路径：切到目标会话，用会话头部那个常驻菜单删除。
 *
 * 头部菜单（置顶/备注/不感兴趣/黑名单/删除/举报）常驻 DOM 且靠点击展开，
 * 不依赖列表项按钮的 CSS :hover。它作用于「当前打开的会话」，
 * 切错人就删错会话且不可撤回，故必须核对身份：目标本来已打开（身份对上）
 * 或切换后头部姓名出现在列表项 company 串里，任一不过就放弃。
 */
async function deleteViaHeaderMenu(hit: ChatThread): Promise<boolean> {
  const wantKey = threadKey(hit)
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()

  // 列表项是「姓名+公司+职务」拼接串，头部只有姓名，
  // 用「头部姓名 ⊂ 列表串」判定是同一个人。
  const identityMatches = (): boolean => {
    const h = findChatHeader()
    const hName = norm(text(h ? headerNameIn(h) : null))
    return !!hName && norm(hit.company).includes(hName)
  }

  // 目标本来就是当前会话时无需切换（身份对得上即可，不能只看 id 变没变）
  if (!identityMatches()) {
    const beforeId = currentThreadId()
    try {
      if (!switchThreadViaVue(hit.el)) realClick(hit.el)
    } catch (e) {
      diag('CHAT', `头部菜单删除：切换会话异常 ${(e as Error).message}`)
      return false
    }

    // 等切换生效：以「身份对上」为准
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
 * 虚拟列表只渲染当前窗口约 40 项，窗口外的会话需滚动加载。
 * 查找完成后把滚动位置复位，避免影响用户视野。
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
 * 匹配依据只能是公司名子串：列表项把「姓名+公司+职务」拼成一串且通常不含
 * 独立岗位名，无法按 company+jobTitle 精确匹配；同公司多岗位会命中第一个，
 * 这是 BOSS DOM 的信息量限制。
 *
 * @returns 'ok' 已触发切换 | 'not-found' 列表里没有匹配项 | 'failed' 找到但切换失败
 */
export function openThread(company: string, jobTitle = ''): 'ok' | 'not-found' | 'failed' {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const target = norm(company)
  if (!target) return 'not-found'

  const threads = listThreads()
  // 先试「公司+岗位都能对上」，退回「仅公司对上」；列表项通常没有岗位名
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

/** 读当前打开会话的消息（区分 hr / me）。会先滚动到底部确保全部加载。 */
/** BOSS 系统通知文本模式（不是 HR 说话，不能当 HR 消息回复/统计） */
const SYSTEM_MSG_RE = /对方已(查看|同意|接受|拒绝)|附件简历已(发送|送达)|撤回了一条消息|已交换联系方式|职位(已下线|已关闭)|系统消息/

/**
 * 会话已在 BOSS 端删除：同步标记后端记录（status=deleted，跨轮次不再残留）
 * 并清本地镜像。三个删除路径（超时清理/被拒删除/手动删除）共用。
 */
function afterConversationDeleted(company: string, jobTitle: string, reason: string): void {
  const cfg = loadConfig()
  void markConversationDeleted(cfg, { company, job_title: jobTitle, reason })
  void removeMirrorByKey(company, jobTitle)
}

async function readMessages(): Promise<Array<{ sender: 'hr' | 'me' | 'system'; content: string }>> {
  // 滚到消息区底部，确保读到最后一条。findChatPanel() 返回的容器不一定是
  // 可滚动节点，需从消息节点往上找真正可滚动的祖先。
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

  const out: Array<{ sender: 'hr' | 'me' | 'system'; content: string }> = []
  const dbg: string[] = []
  if (!panel) return out
  const pr = panel.getBoundingClientRect()
  const mid = pr.left + pr.width / 2

  for (const el of allMatch(SEL.msgText, panel)) {
    const content = text(el)
    if (!content || content.length > 800) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue

    // 收发方判断：优先用 BOSS 自己的语义标记，几何位置只作最后兜底
    // （我方气泡中心仅比中线右移十几像素，纯几何判断会误判）。
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
    // 系统通知单独归类：优先用 BOSS 的 item-system 类（2026-08 实测 DOM），
    // 再退回文本模式（对方已查看/同意发送/撤回消息等）
    const isSystem = /item-system|system/.test(cls) || (!isMe && SYSTEM_MSG_RE.test(content))
    const sender = isMe ? 'me' : isSystem ? 'system' : 'hr'
    out.push({ sender, content })
    dbg.push(`${isMe ? 'ME' : isSystem ? 'SYS' : 'HR'}|cls=${cls.slice(0, 24)}|st=${hasStatus ? 1 : 0}|av=${hasAvatar ? 1 : 0}|x=${Math.round(r.left)}`)
  }
  if (dbg.length) diag("CHAT", "消息判定 mid=" + Math.round(mid), dbg.slice(0, 8))
  return out
}

/**
 * 定位会话头部容器。
 *
 * 以 span.position-name（岗位名）为锚点向上找：.name-text 在列表项里也有，
 * 直接 querySelector 会命中列表第一项而不是头部；position-name 只存在于头部。
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
 * 向上爬时要求容器内存在不属于列表项的 .name-text，且容器不得包含任何
 * 列表项 —— 爬到第 5、6 层时容器会大到同时包住左侧列表，导致
 * header.querySelector('.name-text') 按文档顺序拿到列表第一项的姓名。
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

function currentThreadId(): string {
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
 * 列表项把「姓名+公司+职务」拼在一起且没有岗位名，后端无法据此唯一定位
 * 投递记录；头部区域有独立的公司名节点和 span.position-name，准确得多。
 */
export function currentThreadInfo(): {
  company: string
  jobTitle: string
  salary: string
  city: string
} {
  const jobTitle = text(firstMatch(SEL.headerPosition))
  // 薪资/城市取头部的，且排掉列表项里的同名 class（否则按文档顺序会
  // 拿到列表第一项的值）
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
async function sendText(content: string, expectThread?: string): Promise<boolean> {
  // 安全校验：会话必须还是当初读消息时那个（发给 HR 不可撤回，宁可不发）
  if (expectThread) {
    const now = currentThreadId()
    if (now !== expectThread) {
      diag('CHAT', '已中止发送：会话已被切换', { expect: expectThread, now })
      return false
    }
  }

  // 记录发送前的列表滚动位置，发送后若被 BOSS 复位则恢复
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
      const ta = input as HTMLTextAreaElement
      ta.value = content
      // React 受控组件要 setter 派发才认：直接赋值会丢 valueTracker
      const proto = ta.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      setter?.call(ta, content)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      input.textContent = content
      // 富文本/可编辑区：带 inputType + data 的 InputEvent 才能被 Vue/React 识别
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: content,
      }))
    }
    await delay(500, 1100)

    // 发送：Enter 键盘事件（keydown+keyup，补 keyCode/which 兼容旧 handler）
    for (const type of ['keydown', 'keyup'] as const) {
      input.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }))
    }
    await delay(800, 1500)

    // 兜底：找「发送」按钮（文本/aria/title/图标型，限定输入框附近，避免误点）
    const sendBtn = findSendButton(input)
    if (sendBtn) {
      sendBtn.click()
      await delay(500, 1000)
    }

    // 校验上屏：读会话区最后几条「我方」气泡是否包含发送内容（比全文 contains 可靠）
    const ok = await confirmMessageSent(content)
    diag('CHAT', `发送${ok ? '成功' : '未确认'}: ${content.slice(0, 30)}`)

    // 发送成功后，检查并恢复列表滚动位置
    if (ok && container) {
      await delay(800, 1200) // 等 BOSS 更新列表（会话置顶动画）

      const currentScroll = container.scrollTop
      // 滚动位置被 BOSS 改动超过 100px 时恢复
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
interface ChatCard {
  kind: 'resume_request' | 'contact_exchange' | 'location_confirm' | 'unknown'
  question: string
  acceptBtn: HTMLElement | null
  rejectBtn: HTMLElement | null
}

/**
 * 按卡片问题文本判定类型。
 *
 * 「同意/拒绝」按钮对同时用于「要简历」和「交换联系方式」两类卡片，
 * 只看按钮会把联系方式当简历自动同意（手机号/微信会被发给垃圾招聘方）。
 * 判定必须以问题文本为准，按钮对只作为「这是个卡片」的信号；
 * 认不出来的类型一律不自动点，宁可漏也不能乱点。
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
 * BOSS 的「索要附件简历」「确认工作地点」是带按钮的卡片而非文本消息，
 * 只发文本回复无效，必须点按钮。
 */
/**
 * 卡片是否已经答过。
 *
 * 卡片答完后按钮仍留在消息流里可点击，不加判重会把同一份简历重复发给 HR。
 * 判据：卡片垂直位置之下已有我方消息（消息流自上而下按时间排列），
 * 或结果文本已出现在消息流中。
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

function findPendingCards(): ChatCard[] {
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
 * 工作地点是否接受取决于用户偏好城市，按配置处理；
 * 联系方式卡片一律不自动同意：手机号/微信一旦给出无法收回，且大量索要
 * 联系方式的是垃圾招聘方，只记日志留给用户手动决定。
 */
async function handleCard(
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

  // 联系方式：不点任何按钮（同意泄露隐私、拒绝可能误伤好岗位）
  if (card.kind === 'contact_exchange') {
    log('  ⚠ HR 索要联系方式 → 不自动处理，请手动决定（同意会发出手机号/微信）')
    diag('CHAT', '⚠ 跳过联系方式交换卡片（需人工决定）', {
      question: card.question.slice(0, 80),
    })
    return false
  }

  // 认不出的卡片一律不点：盲点等于把未知授权交给对方
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
    // 同意后 BOSS 弹简历选择框（多简历时）：选默认简历并发送
    const cfg = loadConfig()
    const targetName =
      cfg.defaultSendResumeId && cfg.resumeNames
        ? cfg.resumeNames[String(cfg.defaultSendResumeId)] || null
        : null
    return await completeResumeSend(targetName)
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

/** 按钮禁用判定（unable/disabled/aria/pointer-events） */
function isDialogButtonDisabled(el: HTMLElement): boolean {
  const cls = String(el.className || '')
  return (
    /unable|disabled|is-disabled/.test(cls) ||
    el.getAttribute('aria-disabled') === 'true' ||
    getComputedStyle(el).pointerEvents === 'none'
  )
}

/** 在弹窗里找按钮：只匹配叶子节点自身文本，排除 拒绝/取消，且可见 */
function findDialogButton(root: HTMLElement, re: RegExp): HTMLElement | null {
  const els = Array.from(root.querySelectorAll('div,span,button,a,[role="button"]')) as HTMLElement[]
  for (const el of els) {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent || '').trim())
      .join('')
      .replace(/\s+/g, '')
    if (!own || !re.test(own)) continue
    if (/拒绝|取消/.test(own)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return el
  }
  return null
}

/** 简历名归一化：小写、去空白/点/加号、去 .pdf 等扩展名。
 * BOSS 会用字体混淆文件名里的特殊字符（实测 "蔡韬的简历c++.pdf" 显示成 "蔡韬的简历c .pdf"），
 * 精确匹配会失败，必须归一化后做包含匹配。 */
function normResumeName(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/\.(pdf|docx?|txt|jpg|jpeg|png)$/i, '')
    .replace(/[\s.+\-_]+/g, '')
}

/** 定位简历弹窗：优先「请选择要发送的简历」选择框，其次确认框，兜底 .dialog-wrap.active */
function findResumeDialog(): HTMLElement | null {
  const cands = Array.from(document.querySelectorAll(
    '[class*="dialog"], [class*="modal"], [class*="layer"], [class*="popup"]',
  )) as HTMLElement[]
  const visible = cands.filter((d) => {
    const r = d.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
  // 1) 简历选择弹窗（实测：.dialog-wrap.active，标题「请选择要发送的简历」）
  const picker = visible.find((d) => {
    const t = (d.textContent || '').replace(/\s+/g, '')
    return t.length < 1500 && t.includes('请选择要发送的简历') && !t.includes('上传简历')
  })
  if (picker) return picker
  // 2) 确认弹窗文案
  const confirm = visible.find((d) => {
    const t = (d.textContent || '').replace(/\s+/g, '')
    return t.length < 500 && /确定向Boss发送简历|该附件简历将直接发送/.test(t)
  })
  if (confirm) return confirm
  // 3) 兜底：带 active 且含「简历」的弹窗
  for (const d of visible) {
    if (d.classList.contains('active') && /简历/.test(d.textContent || '')) return d
  }
  return null
}

/** 在简历选择弹窗里选目标简历：按归一化名称模糊匹配列表项，点其可点祖先；
 * 找不到则保持弹窗默认选中项（BOSS 默认第一份）。 */
function selectResumeInDialog(dialog: HTMLElement, targetName: string): boolean {
  const targetNorm = normResumeName(targetName)
  if (!targetNorm) return false
  // 只扫叶子节点（自身文本），避免父容器把整弹窗文本算进去
  const leaves = Array.from(dialog.querySelectorAll('*')) as HTMLElement[]
  for (const el of leaves) {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent || '').trim())
      .join('')
    if (!own) continue
    const norm = normResumeName(own)
    if (!norm || norm.length < 3) continue
    if (!(norm.includes(targetNorm) || targetNorm.includes(norm))) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const clickTarget = (
      el.closest('[role="radio"], [role="checkbox"], label, [class*="item"], [class*="resume"]') ||
      el
    ) as HTMLElement
    clickTarget.click()
    diag('CHAT', `已选择默认简历: ${targetName}`)
    return true
  }
  diag('CHAT', `弹窗里未匹配到默认简历「${targetName}」，用弹窗默认选中项`)
  return false
}

function dumpDialogCandidates(): string[] {
  return Array.from(document.querySelectorAll(
    '[class*="dialog"], [class*="modal"], [class*="layer"]',
  )).map((el) => {
    const r = el.getBoundingClientRect()
    return `${String(el.className || '').slice(0, 50)}[${Math.round(r.width)}x${Math.round(r.height)}]`
  }).slice(0, 10)
}

/**
 * 简历发送弹窗流：确认（同意/确定）→ 选择默认简历 → 发送。
 *
 * BOSS 实际弹窗（2026-08 实测结构）：
 * 1. 确认弹窗：按钮是「同意/拒绝」卡片（不是"确定"）；
 * 2. 简历选择弹窗：多份简历时默认选中第一个，点「发送」；
 * 账号有多份简历时，按用户配置的默认简历（defaultSendResumeId）选中后发送。
 */
async function completeResumeSend(
  targetName: string | null,
  alreadyAgreed = false,
): Promise<boolean> {
  let agreed = alreadyAgreed
  for (let i = 0; i < 20; i++) {
    await delay(400, 600)
    const dialog = findResumeDialog()
    if (!dialog) continue

    // 发送按钮（选择弹窗/直接发送）
    const sendBtn = findDialogButton(dialog, /^(发送|确定)$/)
    if (sendBtn && !isDialogButtonDisabled(sendBtn)) {
      if (targetName) selectResumeInDialog(dialog, targetName)
      sendBtn.click()
      await delay(1000, 1500)
      diag('CHAT', `已发送简历（${targetName ? `默认: ${targetName}` : '未配置默认，用弹窗默认'}）`)
      return true
    }

    // 确认弹窗：BOSS 用「同意/拒绝」，点了之后等选择弹窗
    if (!agreed) {
      const agreeBtn = findDialogButton(dialog, /^(同意|确定|确认)$/)
      if (agreeBtn && !isDialogButtonDisabled(agreeBtn)) {
        agreeBtn.click()
        agreed = true
        await delay(900, 1300)
        diag('CHAT', '已点击简历确认（同意），等待选择弹窗')
      }
    }
  }
  diag('CHAT', '⚠ 简历弹窗处理失败：未找到发送/确认按钮', dumpDialogCandidates())
  return false
}

/** 点「发简历」（HR 要简历时用）→ 确认 + 选择默认简历 + 发送 */
async function sendResume(): Promise<boolean> {
  // 按可见文本定位（"发简历" 这类文案比 class 稳定得多）
  const btn = findByText(/^(发简历|发送简历|附件简历)$/, { clickable: true })
  if (!btn) {
    diag('CHAT', '未找到「发送简历」按钮')
    return false
  }
  if (isDialogButtonDisabled(btn)) {
    diag('CHAT', '「发简历」按钮处于禁用态，跳过', { cls: String(btn.className || '').slice(0, 60) })
    return false
  }
  btn.click()
  await delay(1200, 1800)

  const cfg = loadConfig()
  const targetName =
    cfg.defaultSendResumeId && cfg.resumeNames
      ? cfg.resumeNames[String(cfg.defaultSendResumeId)] || null
      : null
  return completeResumeSend(targetName)
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
  opts: {
    mode?: 'full' | 'snapshot'
    runId?: string
    replyScope?: 'this_round' | 'all'
  } = {},
): Promise<{
  handled: number
  replied: number
  resumes_sent?: number
  pending?: number
  synced?: number
  cleaned?: number
}> {
  if (chatRoundRunning) {
    log('已有会话托管在运行，本次跳过（防止重复发消息给 HR）')
    diag('CHAT', '拒绝并发的会话托管请求')
    return { handled: 0, replied: 0 }
  }
  chatRoundRunning = true
  // 必须在这里复位而不是在 stop 里：上一轮若因 abort 结束，标志还是 true，
  // 不复位则下一轮启动即刻自杀（表现为「点了开始，一条没处理就完成了」）。
  chatRoundAbort = false
  try {
    return await runChatRoundInner(cfg, maxThreads, log, opts)
  } finally {
    chatRoundRunning = false
    chatRoundAbort = false
  }
}

/** 找输入框附近的「发送」按钮（文本/aria/title/图标 class，可见才算） */
function findSendButton(input: HTMLElement): HTMLElement | null {
  const scope = input.closest('div, section') || document
  const cands = Array.from(scope.querySelectorAll(
    'button, [role="button"], [class*="send"], [class*="Send"], [class*="btn"]',
  )) as HTMLElement[]
  for (const el of cands) {
    const t = (el.textContent || '').replace(/\s+/g, '')
    const aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '')
    if (!/^发送$/.test(t) && !/发送/.test(aria)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return el
  }
  return null
}

/** 确认消息已上屏：轮询会话区最后几条「我方」气泡是否包含发送内容 */
async function confirmMessageSent(content: string): Promise<boolean> {
  const needle = content.replace(/\s+/g, '').slice(0, 12)
  if (!needle) return false
  for (let i = 0; i < 6; i++) {
    await delay(500, 800)
    const panel = findChatPanel()
    if (panel) {
      const mine = Array.from(panel.querySelectorAll('.item-myself'))
      for (let j = mine.length - 1; j >= Math.max(0, mine.length - 3); j--) {
        const t = (mine[j].textContent || '').replace(/\s+/g, '')
        if (t.includes(needle)) return true
      }
    }
    // 兜底：全文包含（BOSS 改版选择器失效时仍能确认）
    if ((document.body.textContent || '').includes(content.slice(0, 10))) return true
  }
  return false
}

/**
 * 会话身份键：用于跨滚动窗口去重（虚拟列表节点会被复用，引用不可靠）
 *
 * 优先用 BOSS 原生 ID（data-user-id / data-conversation-id 等属性），
 * 缺失时降级为公司名 + 岗位名（文本可能被截断，不如原生 ID 稳定）。
 */
let warnedThreadKeyFallback = false

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
  if (!warnedThreadKeyFallback) {
    diag('CHAT', `threadKey 未找到原生ID，使用文本键（可能不稳定）`, {
      sample: fallback.slice(0, 50),
    })
    warnedThreadKeyFallback = true
  }
  return fallback
}

/**
 * 滚动会话列表并回调新出现的会话（增量遍历）。
 *
 * BOSS 会话列表是虚拟列表：DOM 恒定只有约 40 个节点，向下滚时节点被复用、
 * 只换数据，「数量稳定」和底部占位符都不能当作到底判据。把「加载」和
 * 「遍历」合成一件事：每滚一屏处理当前窗口里没见过的会话（按身份键去重），
 * 处理完再滚；终止条件是「连续 N 屏没有新身份出现」。
 *
 * @param onThread 处理单个会话，返回 'stop' 可提前终止整轮滚动
 */
async function forEachThreadScrolling(
  log: (m: string) => void,
  onThread: (t: ChatThread, seq: number) => Promise<'ok' | 'stop'>,
): Promise<void> {
  // 容器每屏重新定位：切换会话会让 BOSS 重建左侧列表，孤儿节点设
  // scrollTop 不会有任何效果。
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

  // 从列表顶部开始：scrollTop 可能被上一轮或用户操作留在中间，
  // 不显式复位会导致第 0 屏从中段开始、后续又往回滚。
  if (container) {
    container.scrollTo({ top: 0 })
    await delay(400, 600)
  }

  const seen = new Set<string>()
  let seq = 0
  // 连续 3 屏无新身份即认定到底：BOSS 偶发一屏内全是已处理会话
  // （未读上浮导致顺序变动），单屏无新增不足以判定结束。
  const EMPTY_SCREENS_TO_END = 3
  let emptyScreens = 0
  // 兜底上限，防止 BOSS 改版导致的死循环
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
    let skippedThisScreen = 0
    for (const t of windowThreads) {
      const key = threadKey(t)
      if (!key || key === '|') {
        diag('CHAT', '跳过无效键的会话项', { company: t.company, jobTitle: t.jobTitle })
        continue // 身份不可辨的项跳过，避免污染去重集
      }
      if (seen.has(key)) {
        // 已处理会话只计数不逐条打日志：数百个会话的逐条日志会挤掉
        // 发送失败等更关键的诊断行（历史问题：日志被刷掉看不全）。
        skippedThisScreen++
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
    if (skippedThisScreen > 0) {
      diag('CHAT', `本屏跳过已处理会话 ${skippedThisScreen} 个（共已见 ${seen.size}）`)
    }

    // 容器可能已被重建（处理会话时切换过），重新定位后再滚
    if (!container?.isConnected) container = findThreadScrollContainer()
    if (!container) {
      diag('CHAT', '滚动容器已失效且无法重新定位，结束遍历', { total: seen.size })
      return
    }

    // 目标位置按「已滚过的屏数」算而非「当前 scrollTop + 一屏」：
    // 切换会话后 BOSS 可能把列表 scrollTop 复位为 0，按当前值递增会
    // 从头再滚一遍，误判遍历完毕。
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
 * 按「实际可滚动」判定（scrollHeight 明显大于 clientHeight）：
 * BOSS 的滚动容器可能用 overlay，也可能滚动发生在更外层的祖先上，
 * 只认 overflowY 样式会找不到。
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

/** BOSS 会话行时间文本 → epoch 毫秒（"刚刚"/"昨天"/"HH:mm"/"MM-DD"/"YYYY-MM-DD"）。 */
function parseThreadTimeMs(text: string, now: number): number | null {
  const t = (text || '').trim()
  if (!t) return null
  if (t === '刚刚') return now
  const num = Number(t)
  if (!Number.isNaN(num)) {
    // 纯数字：可能是 epoch 秒/毫秒，也可能是"3分钟前"这类被解析成数字
    return num > 1e12 ? num : now - num * 1000
  }
  const nowDate = new Date(now)
  const y = nowDate.getFullYear()
  if (t === '昨天') return now - 24 * 3600 * 1000
  const full = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (full) {
    return new Date(
      Number(full[1]), Number(full[2]) - 1, Number(full[3]),
      full[4] ? Number(full[4]) : 0, full[5] ? Number(full[5]) : 0,
    ).getTime()
  }
  const md = t.match(/^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (md) {
    return new Date(
      y, Number(md[1]) - 1, Number(md[2]),
      md[3] ? Number(md[3]) : 0, md[4] ? Number(md[4]) : 0,
    ).getTime()
  }
  const hm = t.match(/^(\d{1,2}):(\d{2})$/)
  if (hm) {
    const d = new Date(now)
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0)
    return d.getTime()
  }
  return null
}

/** 删除当前已打开的会话（头部菜单 → 确认弹窗）。 */
async function deleteCurrentThread(): Promise<boolean> {
  const header = findChatHeader()
  if (!header) {
    diag('CHAT', '清理删除：未找到会话头部')
    return false
  }
  const before = currentThreadId()
  const ok = await clickDeleteInHeaderMenu(
    header,
    () => currentThreadId() === before,
    (el) => insideThreadList(el),
  )
  if (!ok) {
    diag('CHAT', '清理删除：头部菜单未触发删除')
    return false
  }
  const confirmed = await confirmDeleteDialog()
  diag('CHAT', `清理删除：${confirmed ? '已确认删除' : '确认弹窗未出现'}`)
  return confirmed
}

/**
 * 清理「已读且超时未回」的会话：
 * - 无未读标记（我方已读）；
 * - 最后一条消息是**我方发送**（我方已回应/已打招呼），HR 之后再没回过；
 * - 最后消息时间超过 cleanReadAfterHours；
 * 满足则删除会话，判定该岗位流程已结束。
 *
 * 注意（2026-08-05 修正）：不能删「最后一条是 HR」的会话 —— 那是我方还没回复的
 * 待办机会，删掉等于丢掉潜在回复；只有「我方最后发言、HR 长时间未回」才说明
 * 流程已冷，可以清理。
 */
async function cleanupAgedReadThreads(
  cfg: PluginConfig,
  log: (m: string) => void,
): Promise<number> {
  const hours = Math.max(1, cfg.cleanReadAfterHours || 16)
  const agedMs = hours * 3600 * 1000
  let cleaned = 0

  await forEachThreadScrolling(log, async (t) => {
    if (t.unread) return 'ok' // 未读消息不清理（还要回）

    const timeEl = t.el.querySelector('span.time, .time')
    if (!timeEl) return 'ok'
    const age = parseThreadTimeMs((timeEl.textContent || '').trim(), Date.now())
    if (age === null || Date.now() - age < agedMs) return 'ok'

    // 打开确认最后一条是「我方发送」：HR 长时间未回 → 流程结束可删；
    // 最后一条是 HR = 我方还没回，属于待办，绝不删。
    await openThread(t.company, t.jobTitle)
    await delay(500, 900)
    const messages = await readMessages()
    // 记录对话历史：删除是策略终点，保留删除前的完整会话供回溯
    logChatHistory(t, messages)
    const last = messages[messages.length - 1]
    if (!last || last.sender !== 'me') return 'ok'

    diag('CHAT', `清理已读超时未回会话`, {
      company: t.company,
      jobTitle: t.jobTitle,
      timeText: (timeEl.textContent || '').trim(),
      lastMsg: (last.content || '').slice(0, 30),
    })
    log(`  ↳ 删除已读超时会话：${t.company || t.name}`)
    if (await deleteCurrentThread()) {
      cleaned++
      afterConversationDeleted(t.company, t.jobTitle, 'aged_cleanup')
    }
    return 'ok'
  })
  return cleaned
}


/**
 * 免开预判：根据会话列表行信息判断「大概率无需回复」，跳过 openThread。
 *
 * 背景（2026-08-06）：投递 50 个后进入会话托管，一次遍历要逐个打开 70+ 会话，
 * 多数会话只有我方打招呼语、最后一条不是 HR，完全不需要打开。
 * 判定基于列表行预览文本（.last-msg / .friend-content），只跳过特征明确的：
 *   - 未读 → 必须打开（HR 有新消息）；
 *   - 预览是我方打招呼语/我方消息特征 → 最后一条是我方，无需回复；
 *   - 预览是系统/状态提示 → 无需回复；
 *   - 特征不明（含预览为空）→ 保守打开，走完整读取判定。
 */
function likelyNoReplyRow(t: ChatThread): boolean {
  if (t.unread) return false
  const p = t.preview || ''
  if (!p) return false

  const SYSTEM_PATTERNS = [
    '对方查看了你的简历',
    '查看过你的简历',
    '对方已查看',
    '职位已关闭',
    '已交换联系方式',
    '系统通知',
    '您已投递',
    '已发送',
  ]
  if (SYSTEM_PATTERNS.some((s) => p.includes(s))) return true

  const OWN_LAST_PATTERNS = [
    '看到贵司',
    '觉得我挺合适',
    '是否可以聊聊',
    '我对贵司',
    '您好，我对贵司',
  ]
  if (OWN_LAST_PATTERNS.some((s) => p.includes(s))) return true
  return false
}


async function runChatRoundInner(
  cfg: PluginConfig,
  maxThreads: number,
  log: (m: string) => void,
  opts: {
    mode?: 'full' | 'snapshot'
    runId?: string
    replyScope?: 'this_round' | 'all'
  },
): Promise<{
  handled: number
  replied: number
  resumes_sent?: number
  pending?: number
  synced?: number
  cleaned?: number
}> {
  let handled = 0
  let replied = 0
  let resumesSent = 0
  let cleaned = 0
  const mode = opts.mode || 'full'

  log(
    mode === 'snapshot'
      ? `开始消息快照（只读统计待回复会话，不发送）。运行中请勿手动点击会话列表。`
      : `开始遍历会话列表（回复预算 ${maxThreads}）。运行中请勿手动点击会话列表。`,
  )
  // 影响「回不回复」的判断同时写进导出日志，便于事后排查
  diag('CHAT', `本轮开始遍历会话，mode=${mode} 预算 ${maxThreads}`)

  // 快照模式：只统计待回复（未读）会话数，不打开会话、不调后端、不发送。
  // 「精确到岗位」由聊天页会话列表行提供（公司+岗位+未读标记），
  // 后端在 chat_snapshot_done 事件里取 max(DOM 未读数, DB 待回复数) 作为真相源。
  if (mode === 'snapshot') {
    // 全量会话行快照（DOM 结构 + 送达/已读等状态标签）上报，供评估数据可用性
    void reportThreadSnapshotOnce(cfg, { runId: opts.runId, reason: 'snapshot' })

    let pending = 0
    await forEachThreadScrolling(log, async (t) => {
      handled++
      if (t.unread) pending++
      return 'ok'
    })
    log(`消息快照完成：扫描 ${handled} 个会话，待回复 ${pending} 个`)
    diag('CHAT', `消息快照完成 handled=${handled} pending=${pending}`)
    return { handled, replied: 0, pending }
  }

  // 清理已读超时未回会话（用户设置开启时）：HR 消息已被读且超过 N 小时未回复，
  // 判定该岗位流程已结束 → 删除会话。先清理再回复，避免给「已结束」的会话发消息。
  if (cfg.cleanReadConversations) {
    log(`清理已读超时未回会话（${cfg.cleanReadAfterHours}h 未回则删）...`)
    cleaned = await cleanupAgedReadThreads(cfg, log)
    if (cleaned > 0) log(`已清理 ${cleaned} 个超时未回会话`)
    else log('本轮没有需要清理的超时未回会话')
  }

  // 回复范围：只有编排器运行时才有「本轮」概念（runId 存在）；手动开启会话托管
  // 没有本轮，一律按 all 处理，否则后端 this_round 缺 run_id 会全部拒回。
  const replyScope: 'this_round' | 'all' = opts.runId
    ? (opts.replyScope || cfg.replyScope || 'this_round')
    : 'all'

  // 单遍流水线：遍历到哪个会话，就在「当前已打开」的状态下直接 同步+发送。
  // 不再三阶段重开 —— 历史问题：阶段1把虚拟列表滚到底后，阶段3再按公司名
  // re-open，每个会话都要滚整张列表，一轮回复卡在消息页好几分钟。
  // 预算（maxThreads）用完后提前结束遍历。
  log(`开始单遍处理会话（回复预算 ${maxThreads}）...`)
  diag('CHAT', `开始单遍处理，replyScope=${replyScope}`)
  let synced = 0
  let skippedPreview = 0

  await forEachThreadScrolling(log, async (t, seq) => {
    if (synced >= maxThreads) return 'stop'   // 预算用完，提前结束
    if (shouldAbortChatRound()) return 'stop'

    handled++

    // 免开预判（2026-08-06 提速）：大部分会话只有我方打招呼语、无需回复，
    // 逐个 openThread 会把一轮 70+ 会话拖到 2-3 分钟。列表行预览可判定的直接跳过。
    if (likelyNoReplyRow(t)) {
      skippedPreview++
      return 'ok'
    }

    // 切换到该会话
    const opened = await openThread(t.company, t.jobTitle)
    await delay(500, 1000)
    if (opened !== 'ok') {
      // 打不开目标会话就跳过：读消息/发回复都必须在正确的会话里进行
      diag('CHAT', `跳过会话：无法打开 ${t.company}（${opened}）`)
      return 'ok'
    }
    // 目标会话指纹：必须在切换完成后捕获，作为发送前「仍是同一会话」的校验基准。
    // 历史 bug：在 openThread 之前捕获，expectThread 恒为上一会话，切到目标后
    // 必然失配 → 所有回复「未发送（会话已切换或发送失败）」（2026-08-05 现场）。
    const threadId = currentThreadId()

    // 读取消息：不再只看未读标记 —— 已读未回（最后一条是 HR）同样需要回复。
    // 只以「最后一条消息是否为 HR」判定，避免漏掉用户手动读过的消息。
    const messages = await readMessages()
    // 记录对话历史（供会话删除策略分析，覆盖所有打开的会话）
    logChatHistory(t, messages)
    const last = messages[messages.length - 1]
    const needsReply = !!last && last.sender === 'hr'
    const hrCount = messages.filter((m) => m.sender === 'hr').length
    diag(
      'CHAT',
      `消息读取 mid=${seq}：${messages.length} 条（HR ${hrCount} / 我方 ${messages.length - hrCount}）` +
        ` needsReply=${needsReply}`,
    )

    if (!needsReply) {
      return 'ok'
    }

    // 读取会话信息
    const info = currentThreadInfo()
    const { company, jobTitle, salary, city } = info
    diag('CHAT', `会话归属信息 company="${company}" job="${jobTitle}"`)

    // 单条同步后端（完整版 sync_chat：去重/已回复判定/评分/建档）
    const res = await syncChatOne(cfg, {
      platform: 'zhipin',
      platform_job_id: '',
      company,
      job_title: jobTitle,
      // 系统通知（对方已查看简历/撤回消息等）不进后端：不是对话内容，
      // 混进去会污染意图分类与「最后一条 HR 消息」判定。
      messages: messages
        .filter((m) => m.sender !== 'system')
        .map((m) => ({
          sender: m.sender === 'hr' ? 'hr' : 'me',
          content: m.content,
          timestamp: '',
        })),
      auto_reply: true,
      // 透传用户设置的最低回复匹配分；0 或未设置时后端不过滤
      min_reply_score: cfg.minReplyScore || 0,
      salary: salary || '',
      city: city || '',
      run_id: opts.runId || '',
      reply_scope: replyScope,
    })
    synced++

    if (!res) {
      log(`  [${company || t.company}] 后端处理失败，跳过`)
      return 'ok'
    }

    diag('CHAT', `后端返回 ${company || t.company}`, {
      intent: res.intent,
      newMessages: res.new_messages,
      hasReply: !!res.reply,
      message: (res.message || '').slice(0, 80),
    })

    if (!res.reply) {
      log(`  [${company || t.company}] 无需回复（${res.message || ''}）`)
      // 低质量公司：不回复但要求删除会话（delete_after_send 且无回复）
      if (res.delete_after_send) {
        log(`  ↳ 低质量公司：删除会话`)
        if (await deleteCurrentThread()) {
          cleaned++
          afterConversationDeleted(company || t.company, jobTitle, 'low_quality')
        }
      }
      return 'ok'
    }

    // 发送回复（当前会话已打开，直接发，无需重开）
    log(`  [${company || t.company}] 回复: ${res.reply}`)
    const ok = await sendText(res.reply, threadId)

    if (ok) {
      replied++
      if (res.send_resume) {
        const resumeOk = await sendResume()
        if (!resumeOk) log('  ↳ 简历未发出，需手动处理')
        else resumesSent++
        // 简历未发出时不得标记 sent：否则后端统计会把「文本已发、简历没发」
        // 的动作也计成已发简历（历史计数虚高根因之一）。
        if (res.action_id) {
          await markChatSent(cfg, res.action_id, resumeOk, resumeOk ? '' : '简历未发出')
        }
      } else if (res.action_id) {
        await markChatSent(cfg, res.action_id, true, '')
      }
      // 明确被拒：后端已换成「拿信息」话术并标记 delete_after_send。
      // 发完删除该会话：BOSS 若回复仍能收到消息，不回复则删除无损失。
      if (res.delete_after_send) {
        log(`  [${company || t.company}] 被拒，已发反馈询问，删除会话`)
        if (await deleteCurrentThread()) {
          cleaned++
          afterConversationDeleted(company || t.company, jobTitle, 'rejection')
        } else {
          log('  ↳ 会话删除未确认（BOSS 端可能已无此会话）')
        }
      }
    } else {
      log(`  [${company || t.company}] 未发送（会话已切换或发送失败）`)
      if (res.action_id) {
        await markChatSent(cfg, res.action_id, false, '页面发送未确认')
      }
    }

    // 处理当前会话的交互卡片（重新检测，避免跨轮引用失效）
    for (const card of findPendingCards()) {
      await handleCard(card, cfg, threadId, log)
    }

    await delay(2000, 4000) // 会话间间隔
    return 'ok'
  })

  log(`单遍处理完成：扫描 ${handled} 个会话（免开跳过 ${skippedPreview}），同步 ${synced}，发送 ${replied} 条回复，简历 ${resumesSent} 次`)
  diag('CHAT', `单遍处理完成 handled=${handled} skippedPreview=${skippedPreview} synced=${synced} replied=${replied} resumes_sent=${resumesSent}`)

  return { handled, replied, resumes_sent: resumesSent, synced, cleaned }
}

