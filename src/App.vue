<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, nextTick, watch } from 'vue'
import type { PluginConfig, ApplyProgress, TabKey, TabItem, HRMessageSummary } from './types'
import { loadConfig, saveConfig, isConfigReady, applyPluginPreferences } from './config'
import { fetchPluginConfig, login } from './api'
import { detectPlatform } from './platforms/factory'
import { onJobListPage } from './orchestrator'
import { ApplyEngine } from './engine'
import { diag, hhmmss } from './logger'
import {
  currentThreadInfo,
  deleteThread,
  listThreads,
  onChatPage,
  openThread,
  readRowJobInfo,
  requestStopChatRound,
  runChatRound,
} from './platforms/boss-chat'
import { probeChatPage } from './platforms/boss-probe'
import { clearChatStore, setPendingOpen, takePendingOpen } from './chat-store'
import {
  lookupCachedJob,
  refreshChatList,
  removeMirrorByKey,
  renderableMirror,
  updateMirrorChatIdentity,
  updateMirrorJobTitle,
  upsertMirrorFromDom,
} from './ledger'
import { dumpStructure, findEditable, findByText, findChatPanel } from './domprobe'
import { getOrchestrator, resumeOrchestrator } from './orchestrator'
import { storage } from './platform-bridge'
import { collectAndLogDom } from './dom-collector'
import { startDebugCapture } from './debug'
import { applyFilterOption, captureCurrentFilterQuery, readFilterOptions } from './search-filter'
import { VERSION_LABEL } from './version'

const platform = detectPlatform()
const config = reactive<PluginConfig>(loadConfig())

// ---- 悬浮球拖拽 + 位置记忆 ----
const collapsed = ref(true)
/** 悬浮球默认位（也是双击重置的目标位） */
const DEFAULT_BALL_POS = { top: 80, right: 20 }
const ballPosition = ref({ ...DEFAULT_BALL_POS })
const dragging = ref(false)

/** 悬浮球尺寸（与 .aah-ball 的 48px 对应，留 12px 余量避免贴边） */
const BALL_MARGIN = 60

/**
 * 把位置夹回当前视口内。
 *
 * 拖拽和窗口 resize 共用同一套边界：两处各算一遍必然会分叉，
 * 且 resize 后不重夹的话，缩小窗口会把球留在视口外点不到
 * （位置还会被存盘，下次打开依然在外面）。
 */
function clampBallPosition(pos: { top: number; right: number }): { top: number; right: number } {
  // 展开态按抽屉尺寸夹边：抽屉 560px 宽，若沿用悬浮球的 60px 余量，
  // 往右一拖整块面板就出了视口，标题栏和收起按钮都点不到，只能刷新页面。
  // 留 120px 可见宽度作为「还能抓回来」的把手。
  const w = collapsed.value ? BALL_MARGIN : 120
  const maxTop = Math.max(BALL_MARGIN, window.innerHeight - BALL_MARGIN)
  const maxRight = Math.max(20, window.innerWidth - w)
  return {
    top: Math.max(0, Math.min(pos.top, maxTop)),
    right: Math.max(0, Math.min(pos.right, maxRight)),
  }
}

/** resize 处理器（onUnmounted 时需按同一引用移除，故提到外层持有） */
let resizeTimer: number | undefined
function onWindowResize(): void {
  // 防抖：拖窗口边框会连续触发 resize，每次都写存储太浪费
  if (resizeTimer !== undefined) clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(async () => {
    const next = clampBallPosition(ballPosition.value)
    // 只有真被夹动了才落盘，避免无谓写入
    if (next.top !== ballPosition.value.top || next.right !== ballPosition.value.right) {
      ballPosition.value = next
      try {
        await storage.set('aah_panel_position', next)
      } catch {
        /* 存储失败不影响使用，下次 resize 会再试 */
      }
    }
  }, 200)
}

onMounted(async () => {
  // storage.get 需要显式默认值（StorageAPI 签名要求 2 个参数）
  const saved = await storage.get<{ top: number; right: number } | null>('aah_panel_position', null)
  if (saved && typeof saved === 'object' && 'top' in saved && 'right' in saved) {
    // 存的是上次窗口尺寸下的位置，本次窗口可能更小 → 先夹一次再用
    ballPosition.value = clampBallPosition(saved)
  }
  window.addEventListener('resize', onWindowResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  if (resizeTimer !== undefined) clearTimeout(resizeTimer)
  if (statsTimer !== undefined) clearInterval(statsTimer)
  if (hrTimer !== null) clearInterval(hrTimer)
  window.removeEventListener('aah:config-reload', onRemoteConfigReload)
  if (configTimer !== undefined) clearInterval(configTimer)
})

/**
 * 拖拽起手，悬浮球与展开态标题栏共用。
 *
 * 展开态也必须能拖：抽屉 560px 宽，固定在右侧会挡住 BOSS 的会话列表和
 * 消息区，用户想看被遮住的内容只能收起面板 —— 而收起就看不到运行状态了。
 */
function onDragStart(e: MouseEvent) {
  if (e.button !== 0) return
  // 标题栏里的按钮（设置/收起）不触发拖拽，否则按下即进入拖拽、click 被吞掉
  if ((e.target as HTMLElement).closest('button')) return
  e.preventDefault()
  dragging.value = true
  const startX = e.clientX
  const startY = e.clientY
  const startTop = ballPosition.value.top
  const startRight = ballPosition.value.right

  const onMove = (me: MouseEvent) => {
    const dx = me.clientX - startX
    const dy = me.clientY - startY
    ballPosition.value = clampBallPosition({
      top: startTop + dy,
      right: startRight - dx,
    })
  }

  const onUp = async () => {
    dragging.value = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    await storage.set('aah_panel_position', ballPosition.value)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

async function resetBallPosition() {
  ballPosition.value = clampBallPosition({ ...DEFAULT_BALL_POS })
  await storage.set('aah_panel_position', ballPosition.value)
}

// ---- Tab 状态 ----
const activeTab = ref<TabKey>('apply')

/** 左侧竖排导航项。顺序即展示顺序 */
const tabs: TabItem[] = [
  { key: 'apply', label: '投递' },
  { key: 'chat', label: '会话' },
  { key: 'settings', label: '设置' },
  { key: 'logs', label: '调试' },
]

/** 未配置时从各处跳去设置页（取代原来的 showSettings = true） */
function gotoSettings(): void {
  activeTab.value = 'settings'
}

/**
 * 键盘导航：ArrowUp/Down 在 tab 间移动，Home/End 跳首尾（WAI-ARIA tablist 规范）。
 * 本组件是竖排导航，故用上下键而非左右键。越界时循环：-1 → 末尾，末尾+1 → 0。
 */
function focusTab(index: number): void {
  const wrapped = (index + tabs.length) % tabs.length
  activeTab.value = tabs[wrapped].key
  // 下一帧 DOM 更新后新 tab 的 tabindex 变成 0，手动聚焦它
  nextTick(() => {
    const nav = document.querySelector('.aah-tab-nav')
    const target = nav?.children[wrapped] as HTMLElement | undefined
    target?.focus()
  })
}

const resumes = ref<Array<{ id: number; name: string; skills_count: number }>>([])
const configError = ref('')
const loadingConfig = ref(false)

// 插件内登录（省去手动复制 Token）
const loginEmail = ref('')
const loginPassword = ref('')
const loggingIn = ref(false)
const loginMsg = ref('')
// 是否已从网站同步到求职偏好（用于界面提示配置来源）
const prefsSynced = ref(false)

/** DOM 采集区独立缓冲（与行为日志分开，见日志 Tab） */
const domLines = ref<string[]>([])
const domCopyMsg = ref('')

/** 采集当前页真实 DOM 结构（岗位卡片/分页/聊天列表，见 dom-collector.ts） */
function collectPageDom() {
  domLines.value = collectAndLogDom()
  diag('DOM', `已采集当前页结构，共 ${domLines.value.length} 行（详见 DOM 采集区）`)
}

/** 手动调试：采集当前 DOM + 30s 内操作记录（DBG 标签进日志，供开发者适配） */
const debugCapturing = ref(false)
function startDebug() {
  if (debugCapturing.value) return
  debugCapturing.value = true
  startDebugCapture()
  window.setTimeout(() => {
    debugCapturing.value = false
  }, 31000)
}

function copyDom() {
  const text = domLines.value.join('\n')
  if (!text) {
    domCopyMsg.value = '暂无内容'
    setTimeout(() => (domCopyMsg.value = ''), 2000)
    return
  }
  try {
    void navigator.clipboard.writeText(text).then(
      () => {
        domCopyMsg.value = '已复制'
        setTimeout(() => (domCopyMsg.value = ''), 2000)
      },
      () => {
        domCopyMsg.value = '复制失败，请手动全选复制'
        setTimeout(() => (domCopyMsg.value = ''), 2000)
      },
    )
  } catch {
    domCopyMsg.value = '复制失败，请手动全选复制'
    setTimeout(() => (domCopyMsg.value = ''), 2000)
  }
}

function wipeDom() {
  domLines.value = []
}

/**
 * 清空会话记录（chat-store 里的判重 hash、失败计数、已答卡片等），
 * 让下次托管重新处理所有会话。用于排查「明明是新消息却被跳过」的问题。
 */
async function wipeChatStore() {
  if (!confirm('确定清空会话记录吗？\n\n清空后，下次托管会重新处理所有会话（包括之前已回复过的）。')) {
    return
  }
  try {
    await clearChatStore()
    domCopyMsg.value = '已清空，下次托管会重新处理'
    setTimeout(() => (domCopyMsg.value = ''), 3000)
  } catch (e) {
    domCopyMsg.value = `清空失败：${(e as Error).message}`
    setTimeout(() => (domCopyMsg.value = ''), 3000)
  }
}

/**
 * 导出当前页面真实结构。
 *
 * 用途：替代「猜 class 选择器」——反复猜已证明不可行，直接看真实 DOM。
 * 请在【手动点开一个会话、右侧已显示消息】的状态下点此按钮。
 */
async function dumpDom() {
  // 聊天页额外跑一遍专用采集：滚动容器、悬浮/右键菜单、头部结构。
  // 这三处是「翻不到底」「删不掉」「公司名为 -」的根源所在，
  // 而原有的 dumpStructure 只打印聊天面板子树，采不到它们。
  if (onChatPage()) {
    domCopyMsg.value = '采集中...'
    try {
      await probeChatPage()
    } catch (e) {
      diag('DOM', `采集异常：${(e as Error).message}`)
    }
  }

  const panel = findChatPanel()
  diag('DOM', `聊天面板: ${panel ? panel.tagName + '.' + String(panel.className).slice(0, 50) : '未找到'}`)

  const editable = findEditable()
  diag('DOM', `可输入元素: ${editable ? editable.tagName + '.' + String(editable.className).slice(0, 40) : '无'}`)

  for (const kw of ['发简历', '发送简历', '换电话', '换微信']) {
    const el = findByText(kw, { clickable: true })
    diag('DOM', `按钮"${kw}": ${el ? el.tagName + '.' + String(el.className).slice(0, 40) : '未找到'}`)
  }

  const nodes = dumpStructure(panel || document.body, 70)
  diag('DOM', `结构 dump（${nodes.length} 节点）`)
  nodes.forEach((n) =>
    diag('DOM', `  ${'·'.repeat(Math.min(n.depth, 8))}${n.tag}.${n.cls} [${n.rect}] ${n.text}`),
  )
  domCopyMsg.value = '结构已记录，请点复制'
  setTimeout(() => (domCopyMsg.value = ''), 3000)
}

// ---- 会话托管（BOSS 聊天页）----
/**
 * 是否在聊天页。
 *
 * 用 ref 而非 computed：onChatPage() 读的是 location.pathname，不是响应式源，
 * 包在 computed 里只会算一次并永久缓存。BOSS 是 SPA，搜索页→聊天页不会重新
 * 挂载组件，于是 isChatPage 一直是进入时的旧值——会话 Tab 的分支就判错了。
 * 改由下方 setInterval 里的 syncRouteState() 每秒重算。
 */
const isChatPage = ref(onChatPage())
const chatRunning = ref(false)

/** 每秒同步一次「跟路由/存储走」的状态（SPA 换页不重新挂载，只能轮询） */
function syncRouteState(): void {
  isChatPage.value = onChatPage()
}

// ---- HR 最近消息（会话 Tab）----
// 数据来自 GET /api/conversations/list 的 last_hr_message 字段。
// 不逐条补 GET /api/conversations/{id}：那个端点会对「已分类且未回复」的消息
// 调 LLM 生成回复草稿，30s 轮询 5 条约等于每小时 600 次 LLM 调用。
const recentHRMessages = ref<HRMessageSummary[]>([])

/**
 * DOM 独有（后端还没同步过）会话的稳定临时负 id。
 * 用 公司|岗位 哈希生成，刷新/换页都不变，避免 Vue key 抖动；
 * 负数区间与后端真实 id 天然隔离，deleteHRThread 据此判断「只删页面、不进台账」。
 */
function tempDomId(company: string, jobTitle: string): number {
  const s = `${company || ''}|${jobTitle || ''}`
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return -(1 + (Math.abs(h) % 1_000_000_000))
}
const hrMessagesError = ref('')
const hrMessagesLoading = ref(false)
/** 是否已拉取过一次 —— 用于区分「还没拉」与「拉过但确实是空的」 */
const hrMessagesLoaded = ref(false)
/** 卡片点击后的反馈（未找到会话时提示，不用 alert 打断） */
const openThreadMsg = ref('')

const HR_REFRESH_MS = 60_000
let hrTimer: number | null = null
/** 上次成功拉取的时刻，用于非聊天页降频（见 onMounted 里的轮询门禁） */
let lastHRFetchAt = 0
/** 会话 Tab 可见时的刷新节流：切 Tab 的即时刷新与定时器去重 */
let lastChatRefreshAt = 0
/** 非聊天页的最小拉取间隔：投递页不看会话卡片，3 分钟够了 */
const HR_IDLE_INTERVAL_MS = 180_000
/** 本地镜像渲染上限（与 ledger.MAX_MIRROR 一致，覆盖「有多少显示多少」的需求） */
const HR_LIST_LIMIT = 1000

/** 公司|岗位 归一化键（与 boss-chat 的 threadKey 同思路，做 DOM ↔ 后端映射用） */
function threadDisplayKey(company: string, jobTitle: string): string {
  return `${(company || '').trim()}|${(jobTitle || '').trim()}`
}

/**
 * 聊天页：以 BOSS 页面 DOM 为真相源，合并后端镜像。
 *
 * 列表以页面 DOM 为真相源：页面有、后端还没有的新会话也要展示；
 * BOSS 已删的会话不再展示。
 *
 * 规则：
 * - DOM 有的会话 → 展示（页面为准）；匹配到后端记录则富化内容/时间/分数，未读以页面为准
 * - DOM 有、后端无（新会话/未同步）→ 用稳定负 id 展示；删除时只删页面、不进台账
 *   （后端还没有这条记录，台账无从记起，等同步后再删才会记账）
 * - DOM 无、后端有（BOSS 已删）→ 不展示
 * - DOM 完全为空（面板先于 BOSS 列表渲染）→ 回退后端列表，避免闪空
 *
 * 调用方（loadHRMessages）会把结果通过 upsertMirrorFromDom 落进本地镜像，
 * 让镜像以页面为准、后端只做富化。
 */
function mergeChatListWithDom(backendList: HRMessageSummary[]): HRMessageSummary[] {
  const dom = listThreads()
  if (dom.length === 0) return backendList

  const byKey = new Map(backendList.map((m) => [threadDisplayKey(m.company, m.jobTitle), m]))
  // 公司名兜底索引：BOSS 列表条目常把「HR名+公司」拼成一串（如 "张女士作业帮HR.招聘专员"）
  // 且提取不到岗位名，此时按「后端公司名出现在 DOM 行文本中」匹配富化；
  // 同公司多个会话时取最近消息的那条（BOSS 列表本身也只显示一个）。
  const byCompany = new Map<string, HRMessageSummary>()
  for (const m of backendList) {
    const c = (m.company || '').trim().toLowerCase()
    const cur = byCompany.get(c)
    if (!cur || m.timestamp > cur.timestamp) byCompany.set(c, m)
  }

  const next: HRMessageSummary[] = []
  for (const t of dom) {
    const key = threadDisplayKey(t.company, t.jobTitle)
    const b = byKey.get(key)
    if (b) {
      next.push({ ...b, hrName: t.name || b.hrName, unread: t.unread })
      continue
    }
    // 岗位名缺失 → 公司名兜底：用后端记录的岗位名/内容/分数富化，
    // 但保留 DOM 展示的公司串（含 HR 名，满足「HR名称+公司+岗位」的展示需求）
    const domText = `${t.company} ${t.jobTitle}`.toLowerCase()
    const fb = Array.from(byCompany.values()).find((m) =>
      domText.includes((m.company || '').trim().toLowerCase()),
    )
    if (fb) {
      next.push({ ...fb, hrName: t.name || fb.hrName, company: t.company, unread: t.unread })
      continue
    }
    next.push({
      id: tempDomId(t.company, t.jobTitle),
      hrName: t.name,
      company: t.company,
      jobTitle: t.jobTitle,
      content: '',
      timestamp: 0,
      unread: t.unread,
      matchScore: null,
    })
  }
  // 与镜像同序（时间倒序）：会话页 / 投递页渲染同一份顺序，避免“换个页面就乱序”
  return next.sort((a, b) => b.timestamp - a.timestamp)
}

async function loadHRMessages(): Promise<void> {
  if (!ready.value) return
  lastHRFetchAt = Date.now()
  // 本地优先：先用本地镜像即时渲染（零等待），再后台增量拉服务器
  recentHRMessages.value = await renderableMirror()
  hrMessagesLoading.value = true
  try {
    // 拉取走增量（since 只取有变化的会话），失败时保留本地镜像渲染、仅提示
    const { list, failed } = await refreshChatList(config, HR_LIST_LIMIT)
    // 聊天页：以 BOSS 页面 DOM 为真相源对齐列表（见 mergeChatListWithDom 注释），
    // 并把结果落进本地镜像——镜像以页面为准，后端只做富化（非聊天页也渲染一致列表）
    if (isChatPage.value) {
      recentHRMessages.value = mergeChatListWithDom(list)
      await upsertMirrorFromDom(recentHRMessages.value)
    } else {
      recentHRMessages.value = list
    }
    hrMessagesLoaded.value = true
    hrMessagesError.value = failed ? '加载失败，稍后重试' : ''
  } finally {
    hrMessagesLoading.value = false
  }
}

/** 该会话是否会被自动回复跳过，以及原因（与后端判定保持一致）。null = 不会被跳过 */
function skipInfo(msg: HRMessageSummary): { label: string; title: string } | null {
  if (msg.matchScore === null) {
    return {
      label: '未评分',
      title:
        '这个岗位没有经过匹配评分（多为 HR 主动打招呼、不是你投的），' +
        '后端无从判断是否值得回复，因此不会自动回复，需要你手动看一眼。' +
        '注意：调低「最低回复匹配分」对这类会话无效——它不是分数低，是没有分数。',
    }
  }
  if (msg.matchScore < config.minReplyScore) {
    return {
      label: `${msg.matchScore.toFixed(0)} 分 < 阈值 ${config.minReplyScore}`,
      title:
        `匹配分 ${msg.matchScore.toFixed(1)} 低于「最低回复匹配分」${config.minReplyScore}，` +
        '判定为低质量岗位，不会自动回复。想回复这类岗位就在设置页调低该阈值。',
    }
  }
  return null
}

/**
 * 点 HR 卡片 → 打开对应会话。
 *
 * 分两种情况：
 *  - 已在聊天页：直接在会话列表里定位并切换，无需跳转。
 *  - 不在聊天页：把「要打开谁」落盘，再跳转。跳转后本次 JS 上下文销毁，
 *    由聊天页重新挂载时的 consumePendingOpen() 接手（同 orchestrator 跨页续跑思路）。
 */
async function openHRThread(msg: HRMessageSummary): Promise<void> {
  openThreadMsg.value = ''
  if (!onChatPage()) {
    await setPendingOpen(msg.company, msg.jobTitle)
    diag('UI', `待打开会话已落盘: ${msg.company}，跳转聊天页`)
    gotoChatPage()
    return
  }
  const r = openThread(msg.company, msg.jobTitle)
  if (r === 'ok') {
    openThreadMsg.value = `已打开「${msg.company}」的会话`
    // 列表项没有岗位名（只在打开的会话头部），打开后回填到镜像
    const info = currentThreadInfo()
    if (info.jobTitle || info.salary) {
      await updateMirrorJobTitle(msg.id, info.jobTitle, info.salary)
      recentHRMessages.value = await renderableMirror()
    }
  } else if (r === 'not-found') {
    // 常见原因：列表靠后还没加载（列表以页面 DOM 为准，理论上都在，先刷新再看）
    openThreadMsg.value = `会话列表里没找到「${msg.company}」，可能需要先向下滚动加载`
  } else {
    openThreadMsg.value = `打开「${msg.company}」失败，详见日志`
  }
}

/** 后台无感回填岗位名：读行组件 boss 对象（带 positionName），不切换会话、只读不发送 */
let backfillJobTitlesRunning = false
async function backfillChatJobTitles(): Promise<void> {
  if (backfillJobTitlesRunning || !onChatPage()) {
    return
  }
  backfillJobTitlesRunning = true
  try {
    const threads = listThreads()
    if (!threads.length) return
    let filled = 0
    for (const t of threads) {
      // 行组件数据（纯内存、极快）：岗位名/薪资/干净公司/HR名 + encryptJobId
      const info = readRowJobInfo(t.el)
      let title = info.title
      let salary = info.salary
      // boss 对象没有岗位名字段时，用 encryptJobId 查「投递扫描岗位缓存」
      // boss.encryptJobId 与投递扫描的岗位 URL id 一致
      if ((!title || !salary) && info.jobId) {
        const cached = await lookupCachedJob(info.jobId)
        if (cached) {
          title = title || cached.title
          salary = salary || cached.salary
        }
      }
      if (title || salary || info.brandName || info.hrName) {
        await updateMirrorChatIdentity(t.company, {
          hrName: info.hrName,
          company: info.brandName,
          jobTitle: title,
          salary,
        })
        filled++
      }
    }
    if (filled) {
      recentHRMessages.value = await renderableMirror()
      diag('CHAT', `后台无感回填岗位名 ${filled} 条（读取行组件 boss 对象）`)
    }
  } finally {
    backfillJobTitlesRunning = false
  }
}

/**
 * 删除指定会话（清理无效会话、降低列表噪声）。
 *
 * 仅在聊天页可用，删除后刷新 HR 消息列表。
 */
const deletingThread = ref<number | string | null>(null)

async function deleteHRThread(msg: HRMessageSummary, event: Event): Promise<void> {
  event.stopPropagation() // 防止触发卡片的 click 事件（打开会话）
  if (!onChatPage()) {
    openThreadMsg.value = '⚠ 删除会话仅在聊天页可用，请先跳转'
    return
  }

  // 会话托管期间禁止删除：托管正按索引遍历会话列表，删除会改变列表结构，
  // 让正在处理的那一条对不上号（resolveThread 会因此判定失败并跳过）。
  if (chatRunning.value || orchestratorRunning.value) {
    openThreadMsg.value = '⚠ 会话托管运行中，请先停止再删除会话'
    return
  }

  if (deletingThread.value) return
  deletingThread.value = msg.id

  try {
    const r = await deleteThread(msg.company, msg.jobTitle)
    if (r === 'ok') {
      openThreadMsg.value = `已删除「${msg.company}」的会话`
      // 页面已删：同步从本地镜像移除，避免非聊天页再渲染出这条死会话
      await removeMirrorByKey(msg.company, msg.jobTitle)
      recentHRMessages.value = await renderableMirror()
    } else if (r === 'not-found') {
      openThreadMsg.value = `会话列表里没找到「${msg.company}」，可能需要先向下滚动加载`
    } else {
      openThreadMsg.value = `删除「${msg.company}」失败（BOSS 菜单未响应），请手动删除`
    }
  } finally {
    deletingThread.value = null
  }
}

/**
 * 聊天页挂载时消费跨页交接单：打开用户在别的页面点过的那个会话。
 *
 * 需要等会话列表渲染出来 —— 面板挂载时 BOSS 的列表往往还是空的，
 * 立刻 openThread 必然 not-found。这里轮询等待，最多 ~12s。
 */
async function consumePendingOpen(): Promise<void> {
  if (!onChatPage()) return
  const pending = await takePendingOpen()
  if (!pending) return
  diag('UI', `消费跨页交接单: ${pending.company}`)
  for (let i = 0; i < 24; i++) {
    const r = openThread(pending.company, pending.jobTitle)
    if (r === 'ok') {
      activeTab.value = 'chat'
      openThreadMsg.value = `已打开「${pending.company}」的会话`
      return
    }
    if (r === 'failed') break
    await new Promise((res) => setTimeout(res, 500))
  }
  activeTab.value = 'chat'
  openThreadMsg.value = `未能自动打开「${pending.company}」，请在左侧会话列表手动选择`
  diag('UI', `跨页打开会话失败: ${pending.company}`)
}

/**
 * 跳到 BOSS 聊天页。
 *
 * 不在模板里直接写 location.href：Vue 模板作用域只认 setup 暴露的绑定，
 * 拿不到全局 location（编译期不报错、运行时才 undefined）。
 * 用平台适配器给的地址而非写死域名，将来接入别的平台不必改模板。
 */
function gotoChatPage(): void {
  if (platform?.chatUrl) window.location.href = platform.chatUrl
}

function gotoJobListPage(): void {
  window.location.href = 'https://www.zhipin.com/web/geek/job'
}

/** 相对时间文案（占位数据 timestamp=0 时不显示时间） */
function relativeTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

// ---- 编排器状态（智能投递 + 自动会话托管） ----
const orchestratorRunning = ref(false)
const orchestratorGoal = ref<'apply_count' | 'hr_reply_count' | 'time_elapsed'>('apply_count')
/**
 * 编排目标值。null = 跟随个人设置的「单次投递上限」。
 *
 * 优先级：用户在此处填了值 → 用它；留空 → 用 config.maxApply（网站个人设置同步来的）。
 * 早先两个数字各管一段又互不知情：设置页填 3、编排填 10，实际每批投 3 个跑 4 批，
 * 用户看不出这层关系，只觉得两个上限在打架。
 */
const orchestratorTarget = ref<number | null>(null)
const orchestratorKeywords = ref('C++,Python,Java')

// ---- 搜索筛选（动态读取当前搜索页选项，见 search-filter.ts） ----
const filterOptions = ref<{ jobCategory: string[]; district: string[] }>({
  jobCategory: [],
  district: [],
})
const filterMsg = ref('')
const filterMsgError = ref(false)

async function refreshFilterOptions(): Promise<void> {
  filterMsg.value = '正在读取页面筛选选项...'
  filterMsgError.value = false
  const [jc, d] = await Promise.all([
    readFilterOptions('jobCategory'),
    readFilterOptions('district'),
  ])
  filterOptions.value = { jobCategory: jc, district: d }
  filterMsg.value = `已读取：职位类型 ${jc.length} 项、区域 ${d.length} 项（需在搜索页操作）`
}

async function pickFilterOption(kind: 'jobCategory' | 'district', value: string): Promise<void> {
  const ok = await applyFilterOption(kind, value)
  filterMsg.value = ok
    ? `已应用「${value}」，可点「捕获当前页筛选」让编排记住`
    : `应用「${value}」失败，请在页面上手动选择后再捕获`
  filterMsgError.value = !ok
}

function captureSearchFilter(): void {
  const q = captureCurrentFilterQuery()
  config.searchFilterQuery = q
  persist()
  filterMsg.value = q
    ? `已捕获筛选参数：${q}（编排翻页/换关键词时自动带上）`
    : '当前页面没有额外筛选参数（仅 query 或 page）'
  filterMsgError.value = false
}

function clearSearchFilter(): void {
  config.searchFilterQuery = ''
  persist()
  filterMsg.value = '已清除保存的筛选'
  filterMsgError.value = false
}

/** 目标值的实际生效数：用户填了就用填的，否则回落到个人设置 */
const effectiveTarget = computed(() =>
  orchestratorTarget.value ?? (orchestratorGoal.value === 'time_elapsed' ? 60 : config.maxApply),
)
const orchestratorStats = reactive({
  appliedTotal: 0,
  hrRepliesTotal: 0,
  chatRoundsTotal: 0,
  phase: 'idle' as string,
  // 目标也镜像过来：进度条要用它当分母。只镜像 stats 的话，
  // 分母只能猜 config.maxApply，而编排器的目标来自个人中心配置，两者可能不同。
  goalType: '' as string,
  goalTarget: 0,
})

/** 已请求停止但当前会话还在收尾 —— 按钮据此显示「停止中」，避免用户重复点 */
const chatStopping = ref(false)

/**
 * 停止手动会话托管。
 *
 * 只置停止标志，不强杀：正在发送的那一条必须走完（半途中断会留下
 * 「发出去了但没记进判重」的状态，下轮会重复发给同一个 HR）。
 */
function stopChat(): void {
  if (!chatRunning.value || chatStopping.value) return
  chatStopping.value = true
  requestStopChatRound()
  progress.logs.unshift(`[${hhmmss()}] 已请求停止，等当前会话处理完毕...`)
}

async function startChat() {
  if (chatRunning.value) return
  if (!ready.value) {
    gotoSettings()
    return
  }
  chatRunning.value = true
  const log = (m: string) => {
    // 与 diag 用同一套格式（固定 24 小时制），两个日志区才能对照着看
    progress.logs.unshift(`[${hhmmss()}] ${m}`)
    if (progress.logs.length > 50) progress.logs.pop()
  }
  try {
    log('开始会话托管...')
    const r = await runChatRound(config, 5, log)
    log(
      `会话托管完成：处理 ${r.handled} 个会话，发送 ${r.replied} 条`,
    )
    // 托管轮内可能更新了镜像，立即重渲染会话列表
    recentHRMessages.value = await renderableMirror()
  } catch (e) {
    log(`会话托管出错: ${(e as Error).message}`)
  } finally {
    chatRunning.value = false
    chatStopping.value = false
  }
}

const progress = reactive<ApplyProgress>({
  scanned: 0, scanComplete: false, matched: 0, applied: 0, skipped: 0, failed: 0, running: false, logs: [], currentJob: null,
})

// currentJob 的响应式副本（从 progress 中提取，便于模板引用）
const currentJob = computed(() => progress.currentJob)

/**
 * 进度条的分母：整轮投递目标数。
 *
 * 注意与上面的 effectiveTarget 区分 —— 那个是"启动时用哪个目标值"（表单值 ??
 * config.maxApply），这个是"正在跑的这轮，分母是多少"。已跑起来后真实目标在
 * 编排器 state.goal 里，可能与表单当前显示值不同（用户改了表单但没重启）。
 *
 * 取值分两种运行方式：
 * - 编排器在跑且目标是 apply_count → 用 state.goal.target（整轮、跨批次）。
 *   若改用 config.maxApply 会把单批上限当整轮，投到第 3 个就 100% 然后卡住。
 * - 只跑 ApplyEngine（没启编排器）→ config.maxApply 就是本次上限。
 *
 * hr_reply_count / time_elapsed 目标返回 0：那两种目标下"已投 N 个"没有对应
 * 分母，进度条不该显示（显示了就是编的）。
 */
const progressTarget = computed<number>(() => {
  if (orchestratorRunning.value) {
    return orchestratorStats.goalType === 'apply_count' ? orchestratorStats.goalTarget : 0
  }
  return config.maxApply || 0
})

/** 进度条分子：编排器在跑时用累计值（跨批次），否则用本次引擎进度 */
const progressApplied = computed<number>(() =>
  orchestratorRunning.value ? orchestratorStats.appliedTotal : progress.applied
)

/** 填充百分比。分母为 0 → null，模板据此整块不渲染 */
const applyProgressPct = computed<number | null>(() => {
  const target = progressTarget.value
  if (!target || target <= 0) return null
  // 夹到 0..100：投递数可能因重试等原因短暂超过目标
  return Math.min(100, Math.max(0, (progressApplied.value / target) * 100))
})

let engine: ApplyEngine | null = null

const ready = computed(() => isConfigReady(config))
const platformName = computed(() => platform?.name || '不支持的页面')
const loggedIn = computed(() => !!config.token)

/** 当前页面是否适用本插件（职位列表 or 聊天页） */
const pageSupported = computed(() => onJobListPage() || onChatPage())

async function doLogin() {
  if (!config.apiBase) {
    loginMsg.value = '请先填写后端地址'
    return
  }
  if (!loginEmail.value || !loginPassword.value) {
    loginMsg.value = '请填写邮箱和密码'
    return
  }
  loggingIn.value = true
  loginMsg.value = ''
  try {
    const res = await login(config.apiBase, loginEmail.value, loginPassword.value)
    config.token = res.token
    saveConfig(config)
    loginPassword.value = ''
    loginMsg.value = `已登录：${res.username}`
    // 登录成功后自动拉取简历列表
    await loadRemoteConfig()
  } catch (e) {
    loginMsg.value = (e as Error).message
  } finally {
    loggingIn.value = false
  }
}

function logout() {
  config.token = ''
  config.resumeId = null
  resumes.value = []
  loginMsg.value = ''
  saveConfig(config)
}

async function loadRemoteConfig(silent = false) {
  if (!config.apiBase || !config.token) {
    configError.value = '请先登录'
    return
  }
  if (!silent) loadingConfig.value = true
  configError.value = ''
  try {
    const data = await fetchPluginConfig(config)
    resumes.value = data.resumes
    // 简历 id → 名称缓存：会话里发简历时，BOSS 选择弹窗按名称匹配默认简历
    config.resumeNames = Object.fromEntries(data.resumes.map((r) => [String(r.id), r.name]))
    if (!config.resumeId && data.resumes.length > 0) {
      config.resumeId = data.resumes[0].id
    }
    // 默认发送简历：优先网页端设置（plugin_preferences 随后合并覆盖）；
    // 未设置时跟随投递用的简历，保证「投哪份就发哪份」的一致性
    if (!config.defaultSendResumeId && config.resumeId) {
      config.defaultSendResumeId = config.resumeId
    }
    if (config.threshold === 60) config.threshold = data.default_threshold
    // 同步网站侧的求职偏好（唯一真相源），避免插件与网站各配一套
    if (data.preferences) {
      const p = data.preferences
      if (typeof p.threshold === 'number') config.threshold = p.threshold
      if (typeof p.apply_limit === 'number') config.maxApply = p.apply_limit
      // 期望城市：用于会话里判断 HR 发来的工作地点卡片能否接受
      if (p.city) config.prefCity = p.city
      // 搜索关键词同样以网站「个人设置」为准：同步后插件面板与网页端编排一致
      // （历史故障：网页端 start 不带关键词，插件回退 'C++'，与用户偏好脱节）
      if (p.keyword) orchestratorKeywords.value = p.keyword
      prefsSynced.value = true
    }
    // 网页端插件偏好（回复模式等）覆盖本地设置：网页端为唯一真相源
    if (data.plugin_preferences) {
      Object.assign(config, applyPluginPreferences(config, data.plugin_preferences))
      saveConfig(config)
    }
    // 从简历技能预填关键词（仅当用户未改过默认值时替换，改过就不覆盖）
    if (data.suggested_keywords && data.suggested_keywords.length > 0) {
      const DEFAULT_KW = 'C++,Python,Java'
      if (orchestratorKeywords.value === DEFAULT_KW) {
        orchestratorKeywords.value = data.suggested_keywords.join(',')
      }
    }
    saveConfig(config)
  } catch (e) {
    const msg = (e as Error).message
    configError.value = msg
    // Token 过期/无效：主动清空并退回登录界面。
    // 否则 loggedIn 仅判 !!token 会一直显示「已登录」，
    // 用户既看不到登录框也没法换 token，陷入死结。
    if (msg.includes('(401)')) {
      config.token = ''
      config.resumeId = null
      resumes.value = []
      saveConfig(config)
      configError.value = '登录已过期，请重新登录'
    }
  } finally {
    loadingConfig.value = false
  }
}

function persist() {
  saveConfig(config)
}

/** 手动粘贴 Token 后立即存盘并试拉配置（验证 Token 是否可用） */
async function onTokenPaste() {
  config.token = (config.token || '').trim()
  saveConfig(config)
  if (config.token) await loadRemoteConfig()
}

async function start() {
  if (!platform) return
  if (!ready.value) {
    gotoSettings()
    return
  }
  engine = new ApplyEngine(platform, config, (p) => Object.assign(progress, p))
  await engine.run()
}

function stop() {
  engine?.abort()
}

// ---- 编排器控制 ----
async function startOrchestrator() {
  if (orchestratorRunning.value) return
  if (!ready.value) {
    gotoSettings()
    return
  }

  const keywords = orchestratorKeywords.value.split(/[,，]/).map((k) => k.trim()).filter(Boolean)
  if (!keywords.length) {
    alert('请填写搜索关键词（多个用逗号分隔）')
    return
  }

  // 界面按「分钟」收时长，状态机内部统一按秒判断，在此处换算
  const target =
    orchestratorGoal.value === 'time_elapsed'
      ? effectiveTarget.value * 60
      : effectiveTarget.value

  const orch = getOrchestrator(config)
  await orch.start({ type: orchestratorGoal.value, target }, keywords)
  orchestratorRunning.value = true
  diag('APP', '编排器已启动')
}

async function stopOrchestrator() {
  const orch = getOrchestrator(config)
  await orch.stop('用户手动停止')
  orchestratorRunning.value = false
  diag('APP', '编排器已停止')
}

/** 状态轮询 timer（onUnmounted 需清掉，否则组件销毁后仍在跑） */
let statsTimer: number | undefined
/** 配置周期刷新 timer（网页端改偏好后 60s 内兜底同步） */
let configTimer: number | undefined

/** 网页端入队 config.reload 后的事件回调：静默重拉配置（核心配置实时生效） */
function onRemoteConfigReload() {
  void loadRemoteConfig(true)
}

// 定期更新编排器状态（从编排器实例读取最新统计）
function updateOrchestratorStats() {
  const orch = getOrchestrator(config)
  const state = orch.getState()
  if (state) {
    Object.assign(orchestratorStats, state.stats)
    orchestratorStats.phase = state.phase
    orchestratorStats.goalType = state.goal?.type || ''
    orchestratorStats.goalTarget = state.goal?.target || 0
    orchestratorRunning.value = orch.isRunning()
  }
}

onMounted(() => {
  // 注入确认 + 平台识别结果，便于「面板没出现/平台判错」类问题定位
  diag('INIT', `插件已注入 ${VERSION_LABEL}：平台=${platform?.name || '不支持'} url=${location.host}${location.pathname}`)
  if (config.apiBase && config.token) loadRemoteConfig()

  // 编排器内部自建 ApplyEngine，进度要回灌到面板，否则顶部五格恒为 0
  getOrchestrator(config).setApplyProgressHandler((p) => Object.assign(progress, p))

  // 尝试恢复编排器（页面刷新后自动续跑）
  resumeOrchestrator(config).then(() => {
    // 恢复成功后更新 UI 状态（从存储读取）
    updateOrchestratorStats()
  })

  // 每秒更新一次编排器状态 + 路由态（用于实时显示统计数据、SPA 换页后纠正分支）
  statsTimer = window.setInterval(() => {
    updateOrchestratorStats()
    syncRouteState()
  }, 1000)

  // HR 消息：立刻拉一次（本地镜像先渲染，再增量刷服务器），之后每 60s 一次；
  // 只在会话 Tab 可见时刷新，配合 since 增量参数，未变化时几乎零开销。
  // 定时器无条件建立、在回调里判断是否已配置 —— 若改成「已配置才建」，
  // 用户在设置页填完 Token 后本次会话就再也不会自动刷新了。
  loadHRMessages()
  hrTimer = window.setInterval(() => {
    if (!ready.value) return
    // 收起时不拉：面板收起时没人看这些卡片，请求纯属白打
    if (collapsed.value) return
    // 非会话 Tab 不拉：投递页不看会话卡片
    if (activeTab.value !== 'chat') return
    // 20s 节流：切 Tab 刚刷过就不重复拉
    if (Date.now() - lastChatRefreshAt < 20_000) return
    // 非聊天页降频：投递页不看会话卡片，3 分钟一次够了
    if (!isChatPage.value && Date.now() - lastHRFetchAt < HR_IDLE_INTERVAL_MS) return
    lastChatRefreshAt = Date.now()
    loadHRMessages()
  }, HR_REFRESH_MS)

  // 网页端「保存设置」会入队 config.reload 命令,这里监听事件即时重拉;
  // 60s 周期刷新兜底,确保网页端改的偏好最终一定生效。
  window.addEventListener('aah:config-reload', onRemoteConfigReload)
  configTimer = window.setInterval(() => {
    if (!ready.value) return
    if (collapsed.value) return
    void loadRemoteConfig(true)
  }, 60000)

  // 跨页交接：若用户在别的页面点了 HR 卡片，这里接手打开对应会话
  consumePendingOpen()

  // 聊天页：延迟后台静默回填岗位名（列表项无岗位名，需短暂打开会话读头部）
  if (onChatPage()) {
    window.setTimeout(() => void backfillChatJobTitles(), 4000)
  }
})

// 切到会话 Tab 时立即刷新一次（去重：20s 内已刷过则跳过）
watch(activeTab, (tab) => {
  if (tab === 'chat' && ready.value && Date.now() - lastChatRefreshAt > 20_000) {
    lastChatRefreshAt = Date.now()
    void loadHRMessages()
  }
})
</script>

<template>
  <div class="aah-root" :style="{ top: ballPosition.top + 'px', right: ballPosition.right + 'px' }">
    <!-- 折叠态：悬浮球（可拖拽） -->
    <div
      v-if="collapsed"
      class="aah-ball"
      :class="{ dragging }"
      @mousedown="onDragStart"
      @click.stop="collapsed = false; ready && loadHRMessages()"
      @dblclick="resetBallPosition"
      title="智能投递助手（拖动调位置，双击重置）"
    >
      <span>投</span>
    </div>

    <!-- 展开态：Tab 抽屉。slide 过渡见 .aah-slide-* 规则。
         注意用的是 v-if="!collapsed" 而非 v-else —— 外面套了 <Transition>，
         v-else 与悬浮球的 v-if 不再是相邻兄弟，会编译报错。 -->
    <Transition name="aah-slide">
    <div v-if="!collapsed" class="aah-drawer">
      <!-- 标题栏即拖拽把手（按钮区已在 onDragStart 里排除） -->
      <div
        class="aah-header"
        :class="{ dragging }"
        @mousedown="onDragStart"
        @dblclick="resetBallPosition"
        title="拖动标题栏移动面板，双击复位"
      >
        <span class="aah-title">智能投递 · {{ platformName }} <small style="opacity:0.6;font-size:11px">{{ VERSION_LABEL }}</small></span>
        <div class="aah-header-btns">
          <!-- ⚙ 是通用 UI 语言，首次打开时用户本能会点它找设置；
               与左侧 Tab 并存不冲突，仅作快捷入口（不再是开关） -->
          <button
            v-if="platform"
            class="aah-icon-btn"
            :class="{ active: activeTab === 'settings' }"
            @click="gotoSettings"
            title="设置"
          >⚙</button>
          <button class="aah-icon-btn" @click="collapsed = true" title="收起">─</button>
        </div>
      </div>

      <!-- 平台未识别（factory 返回 null）—— 理论上不会出现（@match 已限定域名） -->
      <div v-if="!platform" class="aah-body">
        <p class="aah-tip">当前页面不支持。请在 BOSS/智联/猎聘/51 的职位搜索列表页使用。</p>
      </div>

      <!-- Tab 容器：左侧导航 80px + 右侧内容区（独立滚动）。
           非适用页（如 BOSS 首页）也渲染——首页即智能编排的入口：
           编排器启动后会自动前往职位搜索列表开始投递，并在投递与会话托管间切换。 -->
      <div v-else class="aah-tabs-container">
        <div v-if="!pageSupported" class="aah-body" style="border-bottom:1px solid #e5e7eb;border-radius:0">
          <p class="aah-tip">
            当前在「{{ platformName }}」的非列表页（如首页）。可直接在「投递」Tab 启动
            <b>智能编排</b>：编排器会自动前往职位搜索列表开始投递，并在投递与会话托管间
            自动切换，跨页持续运行直到目标达成。城市将按账号的默认期望城市筛选。
          </p>
          <button class="aah-btn-secondary" @click="gotoJobListPage">前往职位搜索列表（手动）</button>
        </div>
        <div class="aah-tab-nav" role="tablist" aria-orientation="vertical">
          <div
            v-for="(tab, idx) in tabs"
            :key="tab.key"
            class="aah-tab"
            :class="{ active: activeTab === tab.key }"
            role="tab"
            :tabindex="activeTab === tab.key ? 0 : -1"
            :aria-selected="activeTab === tab.key"
            @click="activeTab = tab.key"
            @keydown.up.prevent="focusTab(idx - 1)"
            @keydown.down.prevent="focusTab(idx + 1)"
            @keydown.home.prevent="focusTab(0)"
            @keydown.end.prevent="focusTab(tabs.length - 1)"
          >
            {{ tab.label }}
          </div>
        </div>

        <!-- 内容区：各 pane 用 v-if 互斥，切走即销毁（隐藏 Tab 不参与渲染）。
             mode="out-in"：旧 pane 先淡出再淡入新的。不用默认的同时进出 ——
             两个 pane 高度不同，重叠期会把内容区撑成两者之和，看着抖一下。
             每个 pane 带 :key，否则 Vue 认为是同一个 <div> 只改内容，不触发过渡。 -->
        <div class="aah-tab-content">
        <Transition name="aah-fade" mode="out-in">
          <!-- ===== Tab: 设置 ===== -->
          <!-- 两列栅格：简单字段并排，复合/长字段用 .aah-field-wide 跨整行。
               button / p / .aah-loggedin 在 CSS 里默认跨整行，不用逐个标。 -->
          <div v-if="activeTab === 'settings'" key="settings" class="aah-tab-pane aah-form-grid">
            <!-- 服务器地址构建期固定,无需用户填写(测试版指向本机后端) -->
            <div class="aah-field aah-field-wide">
              <span>服务器地址</span>
              <code class="aah-static-value">{{ config.apiBase }}</code>
            </div>

            <!-- 未登录：显示登录表单。整块单列不拆 —— 邮箱/密码并排会被当成
                 两个无关字段，且密码管理器的自动填充在拆开后容易认错列。 -->
            <template v-if="!loggedIn">
              <label class="aah-field aah-field-wide">
                <span>邮箱</span>
                <input v-model="loginEmail" placeholder="登录后端的邮箱" autocomplete="username" />
              </label>
              <label class="aah-field aah-field-wide">
                <span>密码</span>
                <input v-model="loginPassword" type="password" placeholder="密码" autocomplete="current-password"
                  @keyup.enter="doLogin" />
              </label>
              <button class="aah-btn-primary" :disabled="loggingIn" @click="doLogin">
                {{ loggingIn ? '登录中...' : '登录' }}
              </button>
              <p v-if="loginMsg" class="aah-error">{{ loginMsg }}</p>
              <!-- 兜底：登录接口不通时可直接粘贴网页端 Token -->
              <label class="aah-field aah-field-wide">
                <span>或直接粘贴 Token（网页端 localStorage.token）</span>
                <input v-model="config.token" placeholder="eyJhbGciOi..." @change="onTokenPaste" />
              </label>
            </template>

            <!-- 已登录：显示简历选择 + 退出 -->
            <template v-else>
              <div class="aah-loggedin">
                <span class="aah-ok-text">✓ 已登录</span>
                <button class="aah-link-btn" @click="logout">退出</button>
              </div>
              <button class="aah-btn-secondary" :disabled="loadingConfig" @click="loadRemoteConfig()">
                {{ loadingConfig ? '加载中...' : '从网站同步配置（简历 + 求职偏好）' }}
              </button>
              <p v-if="prefsSynced" class="aah-tip">
                已同步网站「个人设置」的求职偏好，改配置请在网页端改后点上方同步。
              </p>
              <!-- 简历文件名长（含"-张三.pdf"后缀），单列会截断 → 整行 -->
              <label class="aah-field aah-field-wide" v-if="resumes.length">
                <span>选择简历</span>
                <select v-model="config.resumeId" @change="persist">
                  <option v-for="r in resumes" :key="r.id" :value="r.id">
                    {{ r.name }}（{{ r.skills_count }} 技能）
                  </option>
                </select>
              </label>
              <p v-if="resumes.length === 0 && !loadingConfig" class="aah-tip">
                暂无简历，请先在网页端上传简历
              </p>
            </template>

            <!-- 匹配开关：默认按阈值筛选；关闭后跳过匹配接口，规则过滤通过即全部投递 -->
            <label class="aah-field aah-field-wide">
              <span>投递筛选</span>
              <div class="aah-row">
                <label class="aah-row" style="gap:6px">
                  <input
                    type="checkbox"
                    v-model="config.matchEnabled"
                    @change="persist"
                  />
                  启用匹配度计算（按阈值筛选）
                </label>
              </div>
              <span class="aah-hint">
                关闭后跳过后端匹配接口，扫描到的岗位全部投递（黑名单/最低薪资规则仍生效）
              </span>
            </label>

            <!-- 投递/回复策略已收归网页端「我的助手」管理，插件不再提供本地输入。
                 改策略请在网页端操作，保存后点上方「从网站同步配置」生效。 -->
            <p class="aah-tip">
              投递额度、投递节奏、回复预算、翻页上限、最低回复分、会话清理等策略
              已收归网页端「我的助手」管理，插件只负责执行。
            </p>

            <p v-if="configError" class="aah-error">{{ configError }}</p>
          </div>

          <!-- ===== Tab: 投递 ===== -->
          <div v-else-if="activeTab === 'apply'" key="apply" class="aah-tab-pane">
            <div v-if="!ready" class="aah-config-notice">
              ⚠ 请先在「设置」Tab 配置：填后端地址 → 登录 → 选简历
            </div>
            <template v-else>
              <!-- 首页/非列表页：五格统计无意义（没有可扫描的职位卡片），只保留编排入口；
                   编排器启动后会自动跳去列表页，统计在那边才真实。 -->
              <div v-if="onJobListPage()" class="aah-stats">
                <div class="aah-stat"><b>{{ progress.scanned }}</b><span>扫描</span></div>
                <div class="aah-stat"><b>{{ progress.matched }}</b><span>匹配</span></div>
                <div class="aah-stat aah-ok"><b>{{ progress.applied }}</b><span>已投</span></div>
                <div class="aah-stat aah-skip"><b>{{ progress.skipped }}</b><span>跳过</span></div>
                <div class="aah-stat aah-fail"><b>{{ progress.failed }}</b><span>失败</span></div>
              </div>

              <!-- 当前投递岗位卡片（实时显示）。左侧 4px 竖条 = 整轮真实进度，
                   自下而上填充。不用无限转圈：投递间隔较长时转久了会被当成卡死。 -->
              <div v-if="currentJob" class="aah-current-job">
                <div
                  v-if="applyProgressPct !== null"
                  class="aah-job-progress"
                  role="progressbar"
                  :aria-valuenow="progressApplied"
                  aria-valuemin="0"
                  :aria-valuemax="progressTarget"
                  :aria-label="`整轮投递进度 ${progressApplied}/${progressTarget}`"
                >
                  <div class="aah-job-progress-fill" :style="{ height: applyProgressPct + '%' }" />
                </div>
                <div class="aah-current-job-body">
                  <div class="aah-current-job-title">
                    正在投递
                    <span v-if="applyProgressPct !== null" class="aah-job-progress-text">
                      {{ progressApplied }}/{{ progressTarget }}
                    </span>
                  </div>
                  <div class="aah-current-job-content">
                    <div class="aah-job-name">{{ currentJob.title }}</div>
                    <div class="aah-job-company">@ {{ currentJob.company }}</div>
                    <div class="aah-job-score">匹配分 {{ currentJob.score }}</div>
                  </div>
                </div>
              </div>

              <!-- 聊天页：投递编排要在搜索页启动，此处只显示状态并引导 -->
              <template v-if="isChatPage">
                <div v-if="orchestratorRunning" class="aah-orchestrator-running-notice">
                  <div class="aah-phase-badge" :class="'phase-' + orchestratorStats.phase">
                    {{ orchestratorStats.phase === 'chat' ? '🤖 会话托管运行中（编排器自动执行）' : '🎯 投递编排运行中' }}
                  </div>
                  <div class="aah-stats">
                    <div class="aah-stat aah-ok"><b>{{ orchestratorStats.appliedTotal }}</b><span>已投</span></div>
                    <div class="aah-stat"><b>{{ orchestratorStats.hrRepliesTotal }}</b><span>HR回复</span></div>
                    <div class="aah-stat"><b>{{ orchestratorStats.chatRoundsTotal }}</b><span>会话轮</span></div>
                  </div>
                  <p class="aah-tip">
                    编排器正在自动处理会话，请勿手动点击会话列表或发送消息。
                  </p>
                  <button class="aah-btn-danger" @click="stopOrchestrator">停止编排</button>
                </div>
                <p v-else class="aah-tip">
                  当前在聊天页。投递编排需在职位搜索列表页启动；会话托管请切到「会话」Tab。
                </p>
              </template>

              <template v-else>
                <!-- 编排器面板（智能投递 + 自动会话托管） -->
                <div class="aah-orchestrator-section">
                  <h3 class="aah-section-title">🎯 智能编排模式（Beta）</h3>
                  <p class="aah-tip">
                    自动投递 + 自动回复 HR，跨页持续运行直到目标达成。刷新页面会自动恢复。
                  </p>

                  <div v-if="orchestratorRunning" class="aah-orchestrator-status">
                    <div class="aah-phase-badge" :class="'phase-' + orchestratorStats.phase">
                      {{ orchestratorStats.phase === 'chat' ? '会话托管中' : orchestratorStats.phase === 'apply' ? '投递中' : orchestratorStats.phase }}
                    </div>
                    <div class="aah-stats">
                      <div class="aah-stat aah-ok"><b>{{ orchestratorStats.appliedTotal }}</b><span>已投</span></div>
                      <div class="aah-stat"><b>{{ orchestratorStats.hrRepliesTotal }}</b><span>HR回复</span></div>
                      <div class="aah-stat"><b>{{ orchestratorStats.chatRoundsTotal }}</b><span>会话轮</span></div>
                    </div>
                    <button class="aah-btn-danger" @click="stopOrchestrator">停止编排</button>
                  </div>

                  <div v-else class="aah-orchestrator-config">
                    <label class="aah-field">
                      <span>目标条件</span>
                      <select v-model="orchestratorGoal">
                        <option value="apply_count">投递数达到</option>
                        <option value="hr_reply_count">收到 HR 回复数</option>
                        <option value="time_elapsed">运行时长（分钟）</option>
                      </select>
                    </label>
                    <label class="aah-field">
                      <span>目标值</span>
                      <div class="aah-row">
                        <input
                          type="number"
                          v-model.number="orchestratorTarget"
                          min="1"
                          max="500"
                          :placeholder="`跟随设置（${effectiveTarget}）`"
                        />
                        <span class="aah-unit">
                          {{ orchestratorGoal === 'time_elapsed' ? '分钟' : '个' }}
                        </span>
                      </div>
                      <span class="aah-hint">
                        留空 = 用个人设置的上限（当前 {{ effectiveTarget }}{{ orchestratorGoal === 'time_elapsed' ? ' 分钟' : ' 个' }}）；填了以填的为准
                      </span>
                    </label>
                    <label class="aah-field">
                      <span>搜索关键词（多个用逗号分隔，轮换使用）</span>
                      <input v-model="orchestratorKeywords" placeholder="C++,Python,Java" />
                    </label>
                    <details class="aah-advanced">
                      <summary>搜索筛选（选项动态读取当前搜索页）</summary>
                      <div class="aah-filter-box">
                        <div class="aah-row" style="gap:8px;margin-bottom:8px;flex-wrap:wrap">
                          <button class="aah-btn-secondary" style="margin:0;padding:4px 10px" @click="refreshFilterOptions">
                            读取页面选项
                          </button>
                          <button class="aah-btn-secondary" style="margin:0;padding:4px 10px" @click="captureSearchFilter">
                            捕获当前页筛选
                          </button>
                          <button v-if="config.searchFilterQuery" class="aah-link-btn" @click="clearSearchFilter">
                            清除
                          </button>
                        </div>
                        <p v-if="config.searchFilterQuery" class="aah-hint" style="margin-bottom:6px">
                          已保存筛选：<code>{{ config.searchFilterQuery }}</code>
                        </p>
                        <template v-if="filterOptions.jobCategory.length">
                          <span class="aah-hint">职位类型：</span>
                          <span
                            v-for="o in filterOptions.jobCategory"
                            :key="'jc' + o"
                            class="aah-filter-chip"
                            @click="pickFilterOption('jobCategory', o)"
                          >{{ o }}</span>
                        </template>
                        <template v-if="filterOptions.district.length">
                          <span class="aah-hint">区域：</span>
                          <span
                            v-for="o in filterOptions.district"
                            :key="'d' + o"
                            class="aah-filter-chip"
                            @click="pickFilterOption('district', o)"
                          >{{ o }}</span>
                        </template>
                        <p v-if="filterMsg" :class="filterMsgError ? 'aah-error' : 'aah-hint'" style="margin-top:6px">
                          {{ filterMsg }}
                        </p>
                      </div>
                    </details>
                    <button class="aah-btn-primary" @click="startOrchestrator">
                      启动智能编排（目标 {{ effectiveTarget }}{{ orchestratorGoal === 'time_elapsed' ? ' 分钟' : ' 个' }}）
                    </button>
                  </div>
                </div>
              </template>

              <div class="aah-logs">
                <div v-if="!progress.logs.length" class="aah-log-line">暂无日志</div>
                <div v-for="(line, i) in progress.logs" :key="i" class="aah-log-line">{{ line }}</div>
              </div>
            </template>
          </div>

          <!-- ===== Tab: 会话 ===== -->
          <!-- aah-pane-fill：让本 Tab 纵向铺满，会话列表吃掉剩余高度 -->
          <div v-else-if="activeTab === 'chat'" key="chat" class="aah-tab-pane aah-pane-fill">
            <div v-if="!ready" class="aah-config-notice">
              ⚠ 请先在「设置」Tab 配置：填后端地址 → 登录 → 选简历
            </div>
            <template v-else>
              <!-- 编排器运行中：不显示手动托管按钮，避免两条链路同时操作会话 -->
              <div v-if="orchestratorRunning" class="aah-orchestrator-running-notice">
                <div class="aah-phase-badge" :class="'phase-' + orchestratorStats.phase">
                  {{ orchestratorStats.phase === 'chat' ? '🤖 会话托管运行中' : '🎯 投递编排运行中' }}
                </div>
                <div class="aah-stats">
                  <div class="aah-stat"><b>{{ orchestratorStats.hrRepliesTotal }}</b><span>HR回复</span></div>
                  <div class="aah-stat"><b>{{ orchestratorStats.chatRoundsTotal }}</b><span>会话轮</span></div>
                </div>
                <p class="aah-tip">
                  编排器正在自动处理会话，请勿手动点击会话列表或发送消息。
                </p>
                <button class="aah-btn-danger" @click="stopOrchestrator">停止编排</button>
              </div>

              <!-- 编排器未运行：手动托管入口 -->
              <template v-else>
                <template v-if="isChatPage">
                  <button v-if="!chatRunning" class="aah-btn-primary" @click="startChat">
                    开始会话托管（自动回复 HR）
                  </button>
                  <button v-else class="aah-btn-danger" @click="stopChat">
                    {{ chatStopping ? '停止中（等当前会话收尾）...' : '停止会话托管' }}
                  </button>
                  <button
                    class="aah-btn-secondary"
                    style="margin-top: 8px"
                    @click="wipeChatStore"
                    :disabled="chatRunning"
                    :title="chatRunning ? '托管运行中，停止后才能清空' : '清空本地会话记录（判重hash、失败计数），下次托管会重新处理所有会话'"
                  >
                    清空会话记录
                  </button>
                  <p class="aah-tip">
                    自动回复不可撤回；全过程记录在网页端「会话」页，可事后评判优化话术。
                  </p>
                </template>
                <template v-else>
                  <p class="aah-tip">会话托管需在 {{ platform?.name || '招聘平台' }} 聊天页使用。</p>
                  <!-- 无 chatUrl 的平台（如尚未支持聊天页的）不显示按钮，避免点了没反应 -->
                  <button
                    v-if="platform?.chatUrl"
                    class="aah-btn-secondary"
                    @click="gotoChatPage"
                  >
                    跳转到聊天页
                  </button>
                </template>
              </template>

              <div class="aah-divider"></div>

              <!-- HR 最近消息（数据来自 /api/conversations/list 的 last_hr_message） -->
              <div class="aah-hr-conversations">
                <div class="aah-diag-head">
                  <span>会话列表（{{ recentHRMessages.length }}）</span>
                  <span class="aah-head-right">
                    <span v-if="hrMessagesLoading">加载中...</span>
                  </span>
                </div>

                <p v-if="hrMessagesError" class="aah-error">{{ hrMessagesError }}</p>

                <!-- 点击卡片 → 打开对应会话（跨页时先落盘再跳转） -->
                <div
                  v-for="msg in recentHRMessages"
                  :key="msg.id"
                  class="aah-hr-message"
                  :class="{ unread: msg.unread, 'low-score': !!skipInfo(msg) }"
                  role="button"
                  tabindex="0"
                  :title="`打开与「${msg.company}」的会话`"
                  @click="openHRThread(msg)"
                  @keydown.enter="openHRThread(msg)"
                  @keydown.space.prevent="openHRThread(msg)"
                >
                  <div class="aah-hr-header">
                    <span class="aah-hr-company">
                      <span v-if="msg.hrName" class="aah-hr-name">{{ msg.hrName }}</span>{{ msg.company }}
                    </span>
                    <div class="aah-hr-actions">
                      <!-- 低分/无分标记：跳过是个决策，必须在界面上可见而不只在日志里。
                           title 里写清为什么跳过 + 在哪改，避免用户只看到一个红标不知所措。 -->
                      <span
                        v-if="skipInfo(msg)"
                        class="aah-skip-badge"
                        :title="skipInfo(msg)!.title"
                      >
                        ⊘ {{ skipInfo(msg)!.label }}
                      </span>
                      <span class="aah-hr-time">{{ relativeTime(msg.timestamp) }}</span>
                      <button
                        v-if="isChatPage"
                        class="aah-delete-btn"
                        :disabled="deletingThread !== null || chatRunning || orchestratorRunning"
                        :title="chatRunning || orchestratorRunning
                          ? '会话托管运行中，无法删除'
                          : '删除此会话（不可恢复）'"
                        @click="deleteHRThread(msg, $event)"
                      >
                        {{ deletingThread === msg.id ? '⏳' : '🗑️' }}
                      </button>
                    </div>
                  </div>
                  <div class="aah-hr-meta">
                    <span v-if="msg.jobTitle" class="aah-hr-job">{{ msg.jobTitle }}</span>
                    <span v-else class="aah-hr-job aah-hr-job-empty">岗位未知</span>
                    <span v-if="msg.salary" class="aah-hr-salary">{{ msg.salary }}</span>
                  </div>
                  <div class="aah-hr-content">{{ msg.content }}</div>
                </div>

                <p v-if="openThreadMsg" class="aah-hint">{{ openThreadMsg }}</p>

                <!-- 空态：区分「加载中」与「确实没有」 -->
                <p
                  v-if="!recentHRMessages.length && hrMessagesLoaded && !hrMessagesError"
                  class="aah-hint"
                >
                  暂无 HR 回复
                </p>
              </div>
            </template>
          </div>

          <!-- ===== Tab: 调试（行为日志已迁移到服务端,这里保留 DOM 采集/调试入口） ===== -->
          <div v-else-if="activeTab === 'logs'" key="logs" class="aah-tab-pane">
            <!-- ===== DOM 采集（独立缓冲，回传日志供开发用） ===== -->
            <div class="aah-diag-head">
              <span>DOM 采集（{{ domLines.length }} 行）</span>
              <span>
                <button class="aah-link-btn" @click="collectPageDom">采集当前页</button>
                <button class="aah-link-btn" @click="dumpDom">聊天页结构</button>
                <button class="aah-link-btn" :disabled="debugCapturing" @click="startDebug">
                  {{ debugCapturing ? '调试采集中(30s)' : '开始调试' }}
                </button>
                <button class="aah-link-btn" @click="copyDom">{{ domCopyMsg || '复制' }}</button>
                <button class="aah-link-btn" @click="wipeDom">清空</button>
              </span>
            </div>
            <p class="aah-hint">
              去目标页面（岗位搜索页 / 聊天页）点「采集当前页」，把下方内容复制回传给开发者，
              用于基于真实 DOM 开发（如岗位翻页）。「聊天页结构」输出在行为记录里。
            </p>
            <div class="aah-logs aah-diag aah-dom-view">
              <div v-if="!domLines.length" class="aah-log-line">
                尚未采集。请先到目标页面再点「采集当前页」。
              </div>
              <div v-for="(line, i) in domLines" :key="'x' + i" class="aah-log-line">{{ line }}</div>
            </div>

            <div class="aah-divider"></div>

            <!-- 调试入口：只投当前页、不跳转、不进会话托管。
                 编排出问题时用它单独验证平台适配器（卡片扫描/沟通按钮）。 -->
            <details class="aah-advanced">
              <summary>调试：只投当前页</summary>
              <p class="aah-tip">
                不跳转、不处理会话，仅对当前列表页投递。用于排查编排器故障。
              </p>
              <p v-if="!ready" class="aah-tip">⚠ 请先在「设置」Tab 完成配置。</p>
              <template v-else>
                <button v-if="!progress.running" class="aah-btn-secondary" @click="start">
                  投当前页
                </button>
                <button v-else class="aah-btn-danger" @click="stop">停止</button>
              </template>
            </details>
          </div>
        </Transition>
        </div>
      </div>
    </div>
    </Transition>
  </div>
</template>

<style>
.aah-root { position: fixed; z-index: 999999; font-size: 13px; font-family: -apple-system, sans-serif; transition: top 0.1s, right 0.1s; }
.aah-ball { width: 48px; height: 48px; border-radius: 50%; background: linear-gradient(135deg,#3b82f6,#2563eb); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:bold; cursor:move; box-shadow:0 4px 12px rgba(0,0,0,.2); user-select: none; }
.aah-ball.dragging { cursor: grabbing; box-shadow:0 8px 24px rgba(0,0,0,.3); }
.aah-drawer { width: 560px; background:#fff; border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,.18); overflow:hidden; border:1px solid #e5e7eb; }

/* ---- Tab 布局：左导航 80px + 右内容 480px ---- */
/* min-height:0 是必需的：flex 子项默认 min-height:auto，内容超高时不会收缩，
   导致 .aah-tab-content 的 overflow-y 失效、整个抽屉被撑破 70vh 限制。 */
.aah-tabs-container { display:flex; height:70vh; max-height:800px; min-height:0; }
.aah-tab-nav { width:80px; flex:0 0 80px; background:#f9fafb; border-right:1px solid #e5e7eb; display:flex; flex-direction:column; }
.aah-tab { padding:16px 12px; text-align:center; font-size:12px; color:#6b7280; cursor:pointer; border-left:3px solid transparent; transition:background .15s, color .15s, border-color .15s; user-select:none; }
.aah-tab:hover { background:#f3f4f6; color:#374151; }
.aah-tab.active { background:#fff; color:#2563eb; border-left-color:#2563eb; font-weight:600; }
.aah-tab-content { flex:1; min-width:0; overflow-y:auto; }
.aah-tab-pane { padding:16px; line-height:1.6; }
/* 铺满型 Tab（会话页）：整页纵向占满，内部由 flex:1 的子元素吃掉剩余高度。
   box-sizing 必不可少 —— 否则 16px padding 叠在 100% 之上会溢出、
   把外层 .aah-tab-content 的滚动条撑出来。
   min-height:0 是 flex 子项能收缩的前提，缺了它内部滚动区不会生效。 */
.aah-pane-fill { display:flex; flex-direction:column; height:100%; min-height:0; box-sizing:border-box; }
/* 铺满模式下，列表容器接管剩余空间并自己滚动 */
.aah-pane-fill .aah-hr-conversations { flex:1; min-height:0; max-height:none; }
/* 列表以外的元素（按钮/提示/分隔线）保持自然高度。
   flex 子项默认 flex-shrink:1，不锁住的话它们会被压缩变形。 */
.aah-pane-fill > *:not(.aah-hr-conversations) { flex:0 0 auto; }
/* 「会话列表（N）」表头在滚动时吸顶，长列表里才知道自己在看什么 */
.aah-pane-fill .aah-hr-conversations .aah-diag-head {
  position:sticky; top:0; background:#fff; z-index:1; padding-bottom:4px;
}
.aah-head-right { display:inline-flex; align-items:center; gap:8px; }

/* ===== 过渡 ===== */

/* Tab 切换：150ms 淡入淡出（mode=out-in，故总时长约 300ms）。
   只动 opacity，不动 transform —— 内容区可滚动，位移会连带滚动条抖动。 */
.aah-fade-enter-active, .aah-fade-leave-active { transition:opacity .15s ease; }
.aah-fade-enter-from, .aah-fade-leave-to { opacity:0; }

/* 抽屉展开/收起：右上角为原点的 slide + fade。
   收起比展开快（.18s vs .22s）：关闭时用户已决定离开，慢动画显得拖沓。 */
.aah-slide-enter-active { transition:opacity .22s ease, transform .22s cubic-bezier(.16,1,.3,1); }
.aah-slide-leave-active { transition:opacity .18s ease, transform .18s ease-in; }
.aah-slide-enter-from, .aah-slide-leave-to { opacity:0; transform:translateX(16px) scale(.97); }
/* 变换原点设在右上：抽屉贴着右上角的悬浮球，从那个角"长出来"才符合来处 */
.aah-drawer { transform-origin:100% 0; }

/* 尊重系统减少动画偏好：前庭功能敏感的用户会因位移动画不适。
   这里整体关掉过渡而非缩短时长 —— 半速的位移仍是位移。 */
@media (prefers-reduced-motion: reduce) {
  .aah-fade-enter-active, .aah-fade-leave-active,
  .aah-slide-enter-active, .aah-slide-leave-active,
  .aah-job-progress-fill { transition:none; }
  .aah-slide-enter-from, .aah-slide-leave-to { transform:none; }
}
.aah-config-notice { padding:12px; background:#fffbeb; border:1px solid #fcd34d; border-radius:8px; color:#92400e; font-size:12px; line-height:1.6; }

/* ---- 会话 Tab ---- */
.aah-hr-conversations { display:flex; flex-direction:column; gap:12px; max-height:320px; overflow-y:auto; }
/* 卡片可点击（打开对应会话）：给 pointer + hover/focus 反馈，
   否则用户看不出这块能点。focus-visible 保证键盘操作也有可见焦点。 */
.aah-hr-message { padding:12px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; cursor:pointer; transition:background .12s, border-color .12s; }
.aah-hr-message:hover { background:#f3f4f6; border-color:#d1d5db; }
.aah-hr-message:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
/* 未读用左侧蓝条标记，比整块变色克制，不至于让列表花掉 */
.aah-hr-message.unread { border-left:3px solid #2563eb; background:#f0f9ff; }
.aah-hr-message.unread:hover { background:#e0f2fe; }
/* 低分/无分（会被自动回复跳过）：左侧灰条 + 整体压暗，一眼能与正常会话分开。
   不用红色：这不是错误，是按用户设定的阈值做出的正常筛选，红色会造成误解。
   放在 .unread 之后，故低分未读会话显示为低分态 —— 这符合优先级：
   「它不会被自动回复」比「它未读」更需要用户注意。 */
.aah-hr-message.low-score { border-left:3px solid #9ca3af; background:#f3f4f6; opacity:.72; }
.aah-hr-message.low-score:hover { background:#e5e7eb; opacity:1; }
/* 跳过原因徽标：紧凑、可 hover 出完整解释（title） */
.aah-skip-badge { flex-shrink:0; padding:1px 6px; background:#e5e7eb; color:#4b5563; border-radius:4px; font-size:10px; white-space:nowrap; cursor:help; }
.aah-hr-header { display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:4px; }
.aah-hr-actions { display:flex; align-items:center; gap:8px; }
.aah-delete-btn { background:none; border:none; padding:2px 4px; cursor:pointer; font-size:14px; opacity:0.6; transition:opacity .15s, transform .15s; }
.aah-delete-btn:hover { opacity:1; transform:scale(1.15); }
.aah-delete-btn:active { transform:scale(0.95); }
.aah-delete-btn:disabled { opacity:0.25; cursor:not-allowed; transform:none; }
.aah-hr-company { font-size:13px; font-weight:600; color:#111827; word-break:break-all; }
.aah-hr-name { color:#7c3aed; font-weight:700; margin-right:4px; }  /* HR 姓名紫色，与公司/岗位区分 */
.aah-hr-message.unread .aah-hr-company { color:#1d4ed8; }
.aah-hr-time { font-size:11px; color:#9ca3af; white-space:nowrap; flex:0 0 auto; }
/* 岗位名：彩色标签与公司/正文区分 */
.aah-hr-job { display:inline-block; margin:2px 0 6px; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:600; color:#0e7490; background:#ecfeff; border:1px solid #a5f3fc; word-break:break-all; }
.aah-hr-job-empty { color:#9ca3af; background:#f3f4f6; border-color:#e5e7eb; }
.aah-hr-salary { display:inline-block; margin:2px 0 6px 4px; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:600; color:#047857; background:#ecfdf5; border:1px solid #a7f3d0; }
.aah-hr-content { font-size:12px; color:#6b7280; line-height:1.6; word-break:break-all; }

/* cursor:move 是「这里能拖」的唯一可见提示，缺了用户不会去试 */
.aah-header { display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#2563eb; color:#fff; cursor:move; user-select:none; }
.aah-header.dragging { cursor:grabbing; }
/* 按钮区恢复默认指针：那里点击不拖拽 */
.aah-header-btns button { cursor:pointer; }
.aah-title { font-weight:600; font-size:13px; }
.aah-header-btns { display:flex; gap:4px; }
.aah-icon-btn { background:rgba(255,255,255,.2); border:none; color:#fff; width:24px; height:24px; border-radius:6px; cursor:pointer; }
.aah-icon-btn:hover { background:rgba(255,255,255,.35); }
/* 已在设置 Tab 时高亮，避免用户反复点同一个按钮找不到反馈 */
.aah-icon-btn.active { background:#fff; color:#2563eb; }
.aah-body { padding:16px; max-height:60vh; overflow-y:auto; line-height:1.6; }
.aah-tip { color:#6b7280; font-size:12px; line-height:1.6; }
/* 字段间距统一 12px（原 10px），与 section 的 16px 形成层级 */
/* 设置 Tab 两列栅格。column-gap 略大于 row-gap，让"同一行的两个字段"
   与"上下两行"在视觉上可区分。 */
.aah-form-grid { display:grid; grid-template-columns:1fr 1fr; column-gap:14px; align-items:start; }
/* 栅格里 .aah-field 的 margin-bottom 交给 grid row-gap 统一管，避免双份间距 */
.aah-form-grid > .aah-field { margin-bottom:12px; }
/* 跨整行：复合字段、长文本字段、勾选项 */
.aah-form-grid > .aah-field-wide { grid-column:1 / -1; }
/* 非 field 的块级元素（按钮、提示、错误、已登录条）一律整行 —— 半列按钮既难点
   又会与相邻字段错位 */
.aah-form-grid > button,
.aah-form-grid > p,
.aah-form-grid > .aah-loggedin { grid-column:1 / -1; }
.aah-field { display:flex; flex-direction:column; gap:4px; margin-bottom:12px; }
.aah-field > span { font-size:12px; color:#374151; }
.aah-field input, .aah-field select { padding:6px 8px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; }
.aah-row { display:flex; align-items:center; gap:6px; }
.aah-btn-primary { width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:8px; font-weight:600; cursor:pointer; }
.aah-btn-primary:hover { background:#1d4ed8; }
.aah-btn-danger { width:100%; padding:10px; background:#dc2626; color:#fff; border:none; border-radius:8px; font-weight:600; cursor:pointer; }
.aah-btn-secondary { width:100%; padding:8px; background:#f3f4f6; color:#374151; border:1px solid #d1d5db; border-radius:6px; cursor:pointer; margin-bottom:12px; }
.aah-loggedin { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
.aah-ok-text { color:#16a34a; font-size:13px; font-weight:600; }
.aah-link-btn { background:none; border:none; color:#6b7280; font-size:12px; cursor:pointer; text-decoration:underline; }
.aah-link-btn:hover { color:#dc2626; }
.aah-stats { display:flex; justify-content:space-between; margin-bottom:12px; }
.aah-stat { display:flex; flex-direction:column; align-items:center; flex:1; }
.aah-stat b { font-size:18px; color:#111827; }
.aah-stat span { font-size:11px; color:#9ca3af; }
.aah-stat.aah-ok b { color:#16a34a; }
.aah-stat.aah-skip b { color:#9ca3af; }
.aah-stat.aah-fail b { color:#f59e0b; }
.aah-logs { margin-top:12px; max-height:180px; overflow-y:auto; background:#f9fafb; border-radius:6px; padding:8px; }
.aah-diag-head { display:flex; justify-content:space-between; align-items:center; margin-top:12px; font-size:11px; color:#6b7280; }
.aah-diag { max-height:150px; background:#111827; }
.aah-diag .aah-log-line { color:#9ca3af; font-size:10px; }
.aah-dom-view .aah-log-line { color:#a5b4fc; }  /* DOM 采集区用淡紫色与行为记录区分 */
.aah-log-line { font-size:11px; color:#4b5563; line-height:1.6; font-family:monospace; word-break:break-all; }
.aah-error { color:#dc2626; font-size:12px; margin-top:6px; }

/* 编排器样式 */
.aah-orchestrator-section { margin-bottom:16px; padding:12px; background:#f0f9ff; border-radius:8px; border:1px solid #bae6fd; }
.aah-section-title { font-size:13px; font-weight:600; margin:0 0 8px 0; color:#1e40af; }
.aah-orchestrator-status { display:flex; flex-direction:column; gap:10px; }
.aah-orchestrator-running-notice { margin-bottom:12px; padding:12px; background:#fef3c7; border-radius:8px; border:1px solid #fbbf24; }
.aah-phase-badge { display:inline-block; padding:4px 10px; border-radius:6px; font-size:11px; font-weight:600; background:#dbeafe; color:#1e40af; }
.aah-phase-badge.phase-chat { background:#d1fae5; color:#065f46; }
.aah-phase-badge.phase-apply { background:#fef3c7; color:#92400e; }
.aah-orchestrator-config { display:flex; flex-direction:column; gap:8px; }
.aah-unit { font-size:11px; color:#6b7280; margin-left:6px; white-space:nowrap; }
.aah-hint { font-size:11px; color:#9ca3af; line-height:1.6; }
.aah-filter-box { padding-top:4px; }
.aah-filter-chip { display:inline-block; margin:2px 4px 2px 0; padding:2px 8px; border-radius:999px; font-size:11px; color:#1e40af; background:#dbeafe; border:1px solid #bfdbfe; cursor:pointer; user-select:none; }
.aah-filter-chip:hover { background:#bfdbfe; }
.aah-divider { height:1px; background:#e5e7eb; margin:16px 0; }
.aah-advanced > summary { font-size:12px; color:#6b7280; cursor:pointer; user-select:none; padding:4px 0; }
.aah-advanced > summary:hover { color:#374151; }
.aah-advanced[open] > summary { margin-bottom:6px; }

/* 当前投递岗位卡片 */
/* 卡片改成 flex 容器：左侧 4px 进度条 + 右侧原内容。
   align-items:stretch（flex 默认）让竖条自动等高于卡片内容，不必写死高度。 */
.aah-current-job { display:flex; gap:10px; margin:12px 0; padding:10px 12px; background:#f0f9ff; border-radius:8px; border:1px solid #bae6fd; }
.aah-current-job-body { flex:1 1 auto; min-width:0; }
/* 进度轨：4px 宽，flex:0 0 auto 防止被内容挤扁 */
.aah-job-progress { flex:0 0 auto; width:4px; border-radius:2px; background:#dbeafe; overflow:hidden;
  /* 自下而上填充：轨道内以列反向排布，填充块贴底 */
  display:flex; flex-direction:column; justify-content:flex-end; }
.aah-job-progress-fill { width:100%; background:#2563eb; border-radius:2px; transition:height .3s ease; }
.aah-current-job-title { font-size:11px; color:#1e40af; font-weight:600; margin-bottom:6px; display:flex; justify-content:space-between; align-items:baseline; gap:6px; }
/* 分数文字用等宽数字，避免 9/10→10/10 时宽度跳动 */
.aah-job-progress-text { font-weight:500; color:#3b82f6; font-variant-numeric:tabular-nums; }
.aah-job-name { font-size:13px; font-weight:600; color:#0c4a6e; margin-bottom:4px; }
.aah-job-company { font-size:12px; color:#0369a1; margin-bottom:4px; }
.aah-job-score { font-size:11px; color:#0284c7; }

</style>
