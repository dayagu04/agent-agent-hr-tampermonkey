<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, nextTick, watch } from 'vue'
import type { PluginConfig, ApplyProgress, TabKey, TabItem, HRMessageSummary } from './types'
import { loadConfig, saveConfig, isConfigReady } from './config'
import { fetchPluginConfig, login } from './api'
import { detectPlatform } from './platforms/factory'
import { onJobListPage } from './orchestrator'
import { ApplyEngine } from './engine'
import { clearDiag, diag, envSnapshot, getDiagText, hhmmss, MAX_LINES, onDiag } from './logger'
import {
  deleteThread,
  onChatPage,
  openThread,
  requestStopChatRound,
  runDeletionReconcile,
  runChatRound,
} from './platforms/boss-chat'
import { probeChatPage } from './platforms/boss-probe'
import { clearChatStore, setPendingOpen, takePendingOpen } from './chat-store'
import {
  listDeletedRecords,
  markDeletedManually,
  refreshChatList,
  renderableMirror,
  restoreDeleted,
  type DeletedRecord,
} from './ledger'
import { pendingGreetingCount } from './pending'
import { dumpStructure, findEditable, findByText, findChatPanel } from './domprobe'
import { getOrchestrator, resumeOrchestrator } from './orchestrator'
import { storage } from './platform-bridge'
import { domMonitor } from './dom-monitor'
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
  { key: 'logs', label: '日志' },
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

// ---- 诊断日志（BOSS 不能开 DevTools，日志必须落在页面内）----
const diagLines = ref<string[]>(getDiagText() ? getDiagText().split('\n') : [])
const copyMsg = ref('')
/** 面板展示用：取最近 60 行并倒序（最新在顶，与动作日志方向一致） */
const recentDiagLines = computed(() => diagLines.value.slice(-60).reverse())

onDiag((line) => {
  diagLines.value.push(line)
  // 上限与 logger 的持久化上限共用同一常量，避免两处各写死数字后不一致
  if (diagLines.value.length > MAX_LINES)
    diagLines.value.splice(0, diagLines.value.length - MAX_LINES)
})

async function copyDiag() {
  const text = `${envSnapshot()}\n---\n${getDiagText()}`
  try {
    await navigator.clipboard.writeText(text)
    copyMsg.value = '已复制'
  } catch {
    // 剪贴板不可用时退回选中文本，用户手动 Ctrl+C
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      copyMsg.value = '已复制'
    } catch {
      copyMsg.value = '复制失败'
    }
    ta.remove()
  }
  setTimeout(() => (copyMsg.value = ''), 2000)
}

function wipeDiag() {
  clearDiag()
  diagLines.value = []
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
    copyMsg.value = '已清空，下次托管会重新处理'
    setTimeout(() => (copyMsg.value = ''), 3000)
  } catch (e) {
    copyMsg.value = `清空失败：${(e as Error).message}`
    setTimeout(() => (copyMsg.value = ''), 3000)
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
    copyMsg.value = '采集中...'
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
  copyMsg.value = '结构已记录，请点复制'
  setTimeout(() => (copyMsg.value = ''), 3000)
}

// ---- DOM 监控（用于调试删除功能）----
const monitorStatus = ref({ running: false, eventsCount: 0, mutationsCount: 0 })
const monitorMsg = ref('')
const monitorMsgError = ref(false)

function startMonitor() {
  domMonitor.start()
  updateMonitorStatus()
  monitorMsg.value = '监控已启动，现在手动执行一次删除操作'
  monitorMsgError.value = false
  diag('MONITOR', '用户启动DOM监控')
}

function stopMonitor() {
  domMonitor.stop()
  updateMonitorStatus()
  monitorMsg.value = `监控已停止（记录了 ${monitorStatus.value.eventsCount} 个事件）`
  monitorMsgError.value = false
  diag('MONITOR', '用户停止DOM监控', monitorStatus.value)
}

function clearMonitor() {
  domMonitor.clear()
  updateMonitorStatus()
  monitorMsg.value = '监控数据已清空'
  monitorMsgError.value = false
}

function exportMonitor() {
  try {
    const json = domMonitor.export()
    navigator.clipboard.writeText(json).then(() => {
      monitorMsg.value = '监控日志已复制到剪贴板，请发给开发者'
      monitorMsgError.value = false
      diag('MONITOR', '用户导出监控日志', {
        size: json.length,
        events: monitorStatus.value.eventsCount,
        mutations: monitorStatus.value.mutationsCount,
      })
      setTimeout(() => (monitorMsg.value = ''), 5000)
    }).catch((e) => {
      monitorMsg.value = `复制失败：${(e as Error).message}`
      monitorMsgError.value = true
    })
  } catch (e) {
    monitorMsg.value = `导出失败：${(e as Error).message}`
    monitorMsgError.value = true
  }
}

function updateMonitorStatus() {
  monitorStatus.value = domMonitor.getStatus()
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
const pendingCount = ref(pendingGreetingCount())

/** 每秒同步一次「跟路由/存储走」的状态（SPA 换页不重新挂载，只能轮询） */
function syncRouteState(): void {
  isChatPage.value = onChatPage()
  pendingCount.value = pendingGreetingCount()
}

// ---- HR 最近消息（会话 Tab）----
// 数据来自 GET /api/conversations/list 的 last_hr_message 字段（后端 Phase 3 新增）。
// 不逐条补 GET /api/conversations/{id}：那个端点会对「已分类且未回复」的消息
// 调 LLM 生成回复草稿，30s 轮询 5 条约等于每小时 600 次 LLM 调用。
const recentHRMessages = ref<HRMessageSummary[]>([])
const hrMessagesError = ref('')
const hrMessagesLoading = ref(false)
/** 是否已拉取过一次 —— 用于区分「还没拉」与「拉过但确实是空的」 */
const hrMessagesLoaded = ref(false)
/** 卡片点击后的反馈（未找到会话时提示，不用 alert 打断） */
const openThreadMsg = ref('')
/** 点击卡片后「列表里找不到」的候选（提供手动兜底标记） */
const staleCandidate = ref<HRMessageSummary | null>(null)

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

// ---- 会话分类：进行中 / 已删除 ----
/** 当前查看的分类 */
const convView = ref<'active' | 'deleted'>('active')
/** 已删除台账（本地 + 服务端，见 ledger.ts） */
const deletedThreads = ref<DeletedRecord[]>([])

async function reloadDeleted(): Promise<void> {
  deletedThreads.value = await listDeletedRecords()
}

/**
 * 「会话列表」分类：后端列表减去已删除的。
 *
 * 渲染层再兜一层过滤（refreshChatList 已过滤一次）：对账刚把某条会话移入
 * 台账、但镜像还没刷新时，这里能立即把它挡在列表外。
 */
const activeHRMessages = computed(() => {
  const gone = new Set(deletedThreads.value.map((d) => d.conversationId))
  return recentHRMessages.value.filter((m) => !gone.has(m.id))
})

/** 从「已删除」里恢复一条：上报后端台账回滚 + 清掉本地记录（误报时用） */
async function forgetOne(id: number): Promise<void> {
  await restoreDeleted(config, [id])
  await reloadDeleted()
  recentHRMessages.value = await renderableMirror()
}

/** 与 BOSS 实际列表对账的状态（按钮转圈 + 结果提示） */
const syncingDeleted = ref(false)

/**
 * 与 BOSS 页面实际列表对账，找出「手动删除过」的会话。
 *
 * 与托管开始前的自动对账走同一条链（boss-chat.ts::runDeletionReconcile）：
 * 滚动加载到底 → 拉后端清单 → 连续 2 轮「后端有、BOSS 无」才记入台账并上报。
 * 这里保留手动按钮，方便不想等下一轮托管的用户立即触发。
 */
async function syncDeletedFromPage(): Promise<void> {
  if (!onChatPage()) {
    openThreadMsg.value = '⚠ 对账需在 BOSS 聊天页进行'
    return
  }
  if (chatRunning.value || orchestratorRunning.value) {
    openThreadMsg.value = '⚠ 会话托管运行中，请先停止再对账（对账要滚动列表）'
    return
  }
  if (syncingDeleted.value) return

  syncingDeleted.value = true
  openThreadMsg.value = '正在与 BOSS 列表对账（需滚动整个列表，请勿操作）...'
  try {
    const r = await runDeletionReconcile(config)
    await reloadDeleted()
    recentHRMessages.value = await renderableMirror()

    openThreadMsg.value = r.detected
      ? `对账完成：发现 ${r.detected} 条已手动删除，已移入「已删除」` + (r.restored ? `；恢复 ${r.restored} 条` : '')
      : r.restored
        ? `对账完成：恢复 ${r.restored} 条（重新出现在 BOSS 列表）`
        : '对账完成：未发现需要移动的会话'
    diag('CHAT', `手动删除对账完成`, {
      manifestCount: r.manifestCount,
      detected: r.detected,
      restored: r.restored,
    })
  } catch (e) {
    openThreadMsg.value = `对账失败：${(e as Error).message}`
  } finally {
    syncingDeleted.value = false
  }
}

async function clearAllDeleted(): Promise<void> {
  if (!deletedThreads.value.length) return
  if (
    !confirm(
      `确定清空「已删除」列表吗？\n\n共 ${deletedThreads.value.length} 条。\n` +
        '这会同时撤销后端台账（仅当会话重新出现在 BOSS 列表时才建议这样做，\n' +
        '否则它会在下一次对账时再次被检测为已删除）。',
    )
  ) {
    return
  }
  await restoreDeleted(config, deletedThreads.value.map((d) => d.conversationId))
  await reloadDeleted()
  recentHRMessages.value = await renderableMirror()
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
    recentHRMessages.value = list
    hrMessagesLoaded.value = true
    hrMessagesError.value = failed ? '加载失败，稍后重试' : ''
  } finally {
    hrMessagesLoading.value = false
  }
}

/**
 * 该会话是否会被自动回复跳过，以及原因。
 *
 * 存在理由（用户反馈 2026-08-01）：低分会话此前只在日志里留一行
 * 「匹配分 0.0 < 阈值 50.0，跳过回复」，会话卡片上毫无表示，用户的原话是
 * 「这个跳过我都不知道是为什么」。跳过是一个**决策**，决策必须在界面上可见。
 *
 * 与后端 plugin.py 的判定保持一致：
 *   - matchScore 为 null → no_score_skip（无投递记录，HR 主动打招呼）
 *   - matchScore < minReplyScore → low_score_skip
 *
 * @returns null 表示不会被跳过
 */
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
    staleCandidate.value = null
    openThreadMsg.value = `已打开「${msg.company}」的会话`
  } else if (r === 'not-found') {
    // 常见原因：该会话已在 BOSS 被删除（后端没收到通知）或列表靠后还没加载。
    // 自动对账会在托管开始时处理，这里提供手动兜底标记入口
    staleCandidate.value = msg
    openThreadMsg.value = `会话列表里没找到「${msg.company}」：若 BOSS 里已删除，点下方按钮标记`
  } else {
    staleCandidate.value = null
    openThreadMsg.value = `打开「${msg.company}」失败，详见日志`
  }
}

/** 手动兜底：把点击后找不到的死条目标记为已删除（本地 + 上报后端台账） */
async function markStaleDeleted(): Promise<void> {
  if (!staleCandidate.value) return
  const msg = staleCandidate.value
  staleCandidate.value = null
  openThreadMsg.value = ''
  await markDeletedManually(config, msg)
  await reloadDeleted()
  recentHRMessages.value = await renderableMirror()
  openThreadMsg.value = `已标记「${msg.company}」为已删除并从列表移除`
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
      openThreadMsg.value = `已删除「${msg.company}」的会话，可在「已删除」分类查看`
      // 仅在确认删除成功后才记账。失败还记会造成「界面没了、BOSS 里还在」的
      // 假象。台账走 ledger（本地 + 上报后端落库，source=manual_click），
      // 这样后端 /list 与网页端也会同步过滤这条死会话。
      await markDeletedManually(config, msg)
      await reloadDeleted()
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
      `会话托管完成：处理 ${r.handled} 个会话，发送 ${r.replied} 条` +
        (r.deletedDetected ? `，自动记删 ${r.deletedDetected} 个` : '') +
        (r.deletedRestored ? `，恢复 ${r.deletedRestored} 个` : ''),
    )
    // 托管轮内可能更新了删除台账/镜像，立即重渲染会话列表
    recentHRMessages.value = await renderableMirror()
  } catch (e) {
    log(`会话托管出错: ${(e as Error).message}`)
  } finally {
    chatRunning.value = false
    chatStopping.value = false
    pendingCount.value = pendingGreetingCount()
  }
}

const progress = reactive<ApplyProgress>({
  scanned: 0, matched: 0, applied: 0, skipped: 0, failed: 0, running: false, logs: [], currentJob: null,
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

async function loadRemoteConfig() {
  if (!config.apiBase || !config.token) {
    configError.value = '请先登录'
    return
  }
  loadingConfig.value = true
  configError.value = ''
  try {
    const data = await fetchPluginConfig(config)
    resumes.value = data.resumes
    if (!config.resumeId && data.resumes.length > 0) {
      config.resumeId = data.resumes[0].id
    }
    if (config.threshold === 60) config.threshold = data.default_threshold
    // 同步网站侧的求职偏好（唯一真相源），避免插件与网站各配一套
    if (data.preferences) {
      const p = data.preferences
      if (typeof p.threshold === 'number') config.threshold = p.threshold
      if (typeof p.apply_limit === 'number') config.maxApply = p.apply_limit
      // 期望城市：用于会话里判断 HR 发来的工作地点卡片能否接受
      if (p.city) config.prefCity = p.city
      prefsSynced.value = true
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

// 定期更新编排器状态（从编排器实例读取最新统计）
function updateOrchestratorStats() {
  const orch = getOrchestrator(config)
  if (orch['state']) {
    Object.assign(orchestratorStats, orch['state'].stats)
    orchestratorStats.phase = orch['state'].phase
    orchestratorStats.goalType = orch['state'].goal?.type || ''
    orchestratorStats.goalTarget = orch['state'].goal?.target || 0
    orchestratorRunning.value = orch['running']
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
    // 收起时不拉（2026-08-02 效率优化）：/api/conversations/list 每次都
    // joinedload 全部 messages 再算 unread_count —— 62 个会话就是 62 组消息
    // 全捞出来。面板收起时没人看这些卡片，请求纯属白打。
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

  // 已删除台账：面板一挂载就读，否则首屏会把删过的会话混在「会话列表」里
  void reloadDeleted()

  // 跨页交接：若用户在别的页面点了 HR 卡片，这里接手打开对应会话
  consumePendingOpen()
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

      <!-- 不支持的页面：平台已识别（有适配器）但当前页不适用 -->
      <div v-if="!pageSupported" class="aah-body">
        <p class="aah-tip">
          本页面不适用。请在「职位搜索列表」或「聊天页」使用投递和会话功能。
        </p>
        <button
          v-if="platform"
          class="aah-btn-primary"
          @click="gotoJobListPage"
        >
          前往职位搜索页
        </button>
      </div>

      <!-- 平台未识别（factory 返回 null）—— 理论上不会出现（@match 已限定域名） -->
      <div v-else-if="!platform" class="aah-body">
        <p class="aah-tip">当前页面不支持。请在 BOSS/智联/猎聘/51 的职位搜索列表页使用。</p>
      </div>

      <!-- Tab 容器：左侧导航 80px + 右侧内容区（独立滚动） -->
      <div v-else class="aah-tabs-container">
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
            <!-- URL 值长，单列会被截断 → 整行 -->
            <label class="aah-field aah-field-wide">
              <span>后端地址</span>
              <input v-model="config.apiBase" placeholder="http://localhost:8010" @change="persist" />
            </label>

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
              <button class="aah-btn-secondary" :disabled="loadingConfig" @click="loadRemoteConfig">
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

            <!-- 滑块：轨道越短越难精调（0~100 步进 5），给整行 -->
            <label class="aah-field aah-field-wide">
              <span>匹配阈值：{{ config.threshold }} 分</span>
              <input type="range" min="0" max="100" step="5" v-model.number="config.threshold" @change="persist" />
            </label>

            <!-- 最低回复匹配分：会话托管的跳过阈值。
                 此前这个值只存在于 config 里、设置页没有入口，用户只能在日志里
                 看到「匹配分 0.0 < 阈值 50.0」却无处可调（原话：这个是需要在设置中
                 可以配置的）。与上面的「匹配阈值」是两件事：那个管投不投，这个管回不回。 -->
            <label class="aah-field aah-field-wide">
              <span>最低回复匹配分：{{ config.minReplyScore }} 分</span>
              <input type="range" min="0" max="100" step="5" v-model.number="config.minReplyScore" @change="persist" />
            </label>
            <p class="aah-tip">
              会话托管只回复匹配分 ≥ {{ config.minReplyScore }} 分的岗位，低于此分的会话在
              上方列表里标为「⊘ 低分」并跳过。设为 0 则全部回复（含垃圾岗）。
            </p>

            <!-- 两个纯数字短字段并排。「最多翻页数」受 autoPaginate 控制会消失，
                 那时「单次最多投递」独占半列、右边空着 —— 比整行更难看。
                 故它的 wide 与 autoPaginate 相反：有伴才并排，没伴就铺满。 -->
            <label class="aah-field" :class="{ 'aah-field-wide': !config.autoPaginate }">
              <span>单次最多投递</span>
              <input type="number" min="1" max="100" v-model.number="config.maxApply" @change="persist" />
            </label>
            <label class="aah-field" v-if="config.autoPaginate">
              <span>最多翻页数</span>
              <input type="number" min="1" max="20" v-model.number="config.maxPages" @change="persist" />
            </label>

            <!-- 复合字段（两个输入 + 波浪号）→ 跨整行，挤进半列会换行错位 -->
            <label class="aah-field aah-field-wide">
              <span>投递间隔（秒）</span>
              <div class="aah-row">
                <input type="number" min="1" :value="config.delayMin / 1000" style="width:60px"
                  @input="(e:any)=>{config.delayMin = Number(e.target.value)*1000; persist()}" />
                <span>~</span>
                <input type="number" min="1" :value="config.delayMax / 1000" style="width:60px"
                  @input="(e:any)=>{config.delayMax = Number(e.target.value)*1000; persist()}" />
              </div>
            </label>

            <!-- 间隔地板（BOSS 风控红线）：低于 60s 显示警告 + 需确认勾选才生效 -->
            <label class="aah-field aah-field-wide">
              <span>间隔地板（秒）</span>
              <input type="number" min="0" max="600" v-model.number="config.minIntervalSeconds" @change="persist" />
            </label>
            <p v-if="config.minIntervalSeconds < 60" class="aah-error">
              ⚠ 间隔地板 &lt; 60 秒存在 BOSS 风控高风险（封号不可逆）。
              低于 60 秒时必须勾选下方确认才生效，否则强制回落到 180 秒。
            </p>
            <label v-if="config.minIntervalSeconds < 60" class="aah-field aah-field-wide">
              <div class="aah-row">
                <input type="checkbox" v-model="config.acknowledgeRiskyInterval" @change="persist" />
                <span style="color:#dc2626;font-weight:600">我知道低间隔有封号风险，仍要使用</span>
              </div>
            </label>

            <!-- 勾选项：文案长，且并排时勾框与文字的关系会变模糊 → 整行 -->
            <label class="aah-field aah-field-wide">
              <div class="aah-row">
                <input type="checkbox" v-model="config.autoPaginate" @change="persist" />
                <span>自动翻页（投完当前页继续下一页）</span>
              </div>
            </label>
            <label class="aah-field aah-field-wide">
              <div class="aah-row">
                <input type="checkbox" v-model="config.rejectOffCityLocation" @change="persist" />
                <span>工作地点非期望城市时拒绝</span>
              </div>
            </label>
            <p class="aah-tip">
              默认关闭：地点不符也接受，仅在日志标记供你复核（期望城市
              {{ config.prefCity || '未设置' }}）。
            </p>

            <!-- DOM 监控（用于调试删除功能）-->
            <div class="aah-divider"></div>
            <details class="aah-advanced">
              <summary>🔍 DOM 监控（调试删除功能用）</summary>
              <p class="aah-tip">
                用于调试「删除会话」功能。启动监控后，手动在BOSS页面执行一次删除操作
                （鼠标悬停出「···」→ 点击 → 选删除 → 确认），然后点「导出监控日志」
                将完整事件序列复制给开发者分析。
              </p>
              <div class="aah-row" style="gap:8px;margin-top:8px">
                <button
                  v-if="!monitorStatus.running"
                  class="aah-btn-secondary"
                  @click="startMonitor"
                >
                  启动监控
                </button>
                <button
                  v-else
                  class="aah-btn-danger"
                  @click="stopMonitor"
                >
                  停止监控
                </button>
                <button
                  class="aah-btn-secondary"
                  @click="exportMonitor"
                  :disabled="monitorStatus.eventsCount === 0"
                >
                  导出监控日志
                </button>
                <button
                  class="aah-link-btn"
                  @click="clearMonitor"
                  :disabled="!monitorStatus.running"
                >
                  清空
                </button>
              </div>
              <p v-if="monitorStatus.running" class="aah-tip" style="margin-top:8px;color:#059669">
                ✓ 监控中：已记录 {{ monitorStatus.eventsCount }} 个事件，
                {{ monitorStatus.mutationsCount }} 个DOM变化
              </p>
              <p v-if="monitorMsg" :class="monitorMsgError ? 'aah-error' : 'aah-tip'" style="margin-top:8px">
                {{ monitorMsg }}
              </p>
            </details>

            <p v-if="configError" class="aah-error">{{ configError }}</p>
          </div>

          <!-- ===== Tab: 投递 ===== -->
          <div v-else-if="activeTab === 'apply'" key="apply" class="aah-tab-pane">
            <div v-if="!ready" class="aah-config-notice">
              ⚠ 请先在「设置」Tab 配置：填后端地址 → 登录 → 选简历
            </div>
            <template v-else>
              <div class="aah-stats">
                <div class="aah-stat"><b>{{ progress.scanned }}</b><span>扫描</span></div>
                <div class="aah-stat"><b>{{ progress.matched }}</b><span>匹配</span></div>
                <div class="aah-stat aah-ok"><b>{{ progress.applied }}</b><span>已投</span></div>
                <div class="aah-stat aah-skip"><b>{{ progress.skipped }}</b><span>跳过</span></div>
                <div class="aah-stat aah-fail"><b>{{ progress.failed }}</b><span>失败</span></div>
              </div>

              <!-- 当前投递岗位卡片（实时显示）。左侧 4px 竖条 = 整轮真实进度，
                   自下而上填充。不用无限转圈：BOSS 保号间隔 200s，转 3 分钟不动
                   会被当成卡死。 -->
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
          <!-- aah-pane-fill：让本 Tab 纵向铺满，会话列表吃掉剩余高度。
               不加的话列表被 max-height 卡在 320px，下方留一大块空白（用户反馈）。 -->
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
                <div v-if="pendingCount" class="aah-pending-greetings">
                  有 {{ pendingCount }} 条招呼语待补发（投递时会话已建立但未发出）
                </div>

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
                  <!-- 分类切换：进行中 / 已删除。
                       删过的会话不该和进行中的混在一起（用户反馈）——
                       后端没有删除端点，不分流的话它们每 30s 轮询就回来一次。 -->
                  <span class="aah-seg" role="tablist">
                    <button
                      class="aah-seg-btn"
                      :class="{ on: convView === 'active' }"
                      role="tab"
                      :aria-selected="convView === 'active'"
                      @click="convView = 'active'"
                    >
                      会话列表（{{ activeHRMessages.length }}）
                    </button>
                    <button
                      class="aah-seg-btn"
                      :class="{ on: convView === 'deleted' }"
                      role="tab"
                      :aria-selected="convView === 'deleted'"
                      @click="convView = 'deleted'"
                    >
                      已删除（{{ deletedThreads.length }}）
                    </button>
                  </span>
                  <span class="aah-head-right">
                    <span v-if="hrMessagesLoading">加载中...</span>
                    <!-- 对账：找出「在 BOSS 里手动删过、但后端记录还在」的会话。
                         与托管开始前的自动对账同一条链；此处提供手动入口，
                         不想等下一轮托管的用户可立即触发（需滚完整个列表）。 -->
                    <button
                      v-if="convView === 'active' && isChatPage"
                      class="aah-link-btn"
                      :disabled="syncingDeleted || chatRunning || orchestratorRunning"
                      :title="chatRunning || orchestratorRunning
                        ? '会话托管运行中，无法对账'
                        : '扫描 BOSS 实际列表并与后端清单对账，连续 2 轮消失的会话自动进「已删除」（需滚动列表约十几秒）'"
                      @click="syncDeletedFromPage"
                    >
                      {{ syncingDeleted ? '对账中...' : '对账' }}
                    </button>
                    <!-- 一键清空只在「已删除」分类出现：在进行中分类摆一个
                         「清空」按钮太容易被误读成「清空所有会话」 -->
                    <button
                      v-if="convView === 'deleted' && deletedThreads.length"
                      class="aah-link-btn"
                      @click="clearAllDeleted"
                    >
                      一键清空
                    </button>
                  </span>
                </div>

                <p v-if="hrMessagesError" class="aah-error">{{ hrMessagesError }}</p>

                <!-- 点击卡片 → 打开对应会话（跨页时先落盘再跳转） -->
                <div
                  v-for="msg in (convView === 'active' ? activeHRMessages : [])"
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
                    <span class="aah-hr-company">{{ msg.company }}</span>
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
                  <div class="aah-hr-job">{{ msg.jobTitle }}</div>
                  <div class="aah-hr-content">{{ msg.content }}</div>
                </div>

                <!-- 已删除分类：置灰、不可点开（会话在 BOSS 那边已经不存在了，
                     点开只会 not-found）。每条留一个 🗑️ 从台账清除。 -->
                <div
                  v-for="d in (convView === 'deleted' ? deletedThreads : [])"
                  :key="'d' + d.conversationId"
                  class="aah-hr-message deleted"
                >
                  <div class="aah-hr-header">
                    <span class="aah-hr-company">{{ d.company }}</span>
                    <div class="aah-hr-actions">
                      <span class="aah-hr-time">{{ relativeTime(d.detectedAt) }}删除</span>
                      <button
                        class="aah-delete-btn"
                        title="恢复这条记录（同步撤销后端台账；仅当会话重新出现在 BOSS 列表时使用）"
                        @click="forgetOne(d.conversationId)"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                  <div class="aah-hr-job">{{ d.jobTitle }}</div>
                </div>

                <p v-if="openThreadMsg" class="aah-hint">{{ openThreadMsg }}</p>

                <!-- 死条目兜底：点击后找不到，可一键标记删除（本地 + 上报台账） -->
                <p v-if="staleCandidate" class="aah-hint">
                  <button class="aah-link-btn" @click="markStaleDeleted">标记为已删除</button>
                </p>

                <!-- 空态：区分「加载中」与「确实没有」 -->
                <p
                  v-if="convView === 'active' && !activeHRMessages.length && hrMessagesLoaded && !hrMessagesError"
                  class="aah-hint"
                >
                  暂无 HR 回复
                </p>
                <p v-if="convView === 'deleted' && !deletedThreads.length" class="aah-hint">
                  还没有删除过会话
                </p>
              </div>
            </template>
          </div>

          <!-- ===== Tab: 日志 ===== -->
          <div v-else-if="activeTab === 'logs'" key="logs" class="aah-tab-pane">
            <!-- 诊断日志（BOSS 有 devtools 检测，不能开 F12，故日志落在页面内） -->
            <div class="aah-diag-head">
              <span>诊断日志（{{ diagLines.length }} 行）</span>
              <span>
                <button class="aah-link-btn" @click="dumpDom">导出结构</button>
                <button class="aah-link-btn" @click="copyDiag">{{ copyMsg || '复制' }}</button>
                <button class="aah-link-btn" @click="wipeDiag">清空</button>
              </span>
            </div>
            <!-- 倒序：与动作日志保持一致的「最新在顶」，
                 否则两个日志区方向相反，读起来像时间戳错乱 -->
            <div class="aah-logs aah-diag">
              <div v-if="!recentDiagLines.length" class="aah-log-line">暂无日志</div>
              <div v-for="(line, i) in recentDiagLines" :key="'d' + i" class="aah-log-line">{{ line }}</div>
            </div>

            <div class="aah-divider"></div>

            <!-- 调试入口（2026-07-31 从投递 Tab 移来）：
                 只投当前页、不跳转、不进会话托管。编排器已包含投递，这里保留
                 是为了编排出问题时能只投一页，验证平台适配器（卡片扫描/沟通按钮）
                 本身是否正常。与技术日志同属开发者视角，故并到本 Tab。 -->
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
/* 分类切换（进行中 / 已删除） */
.aah-seg { display:inline-flex; gap:4px; }
.aah-seg-btn {
  border:1px solid #e5e7eb; background:#fff; color:#6b7280; cursor:pointer;
  padding:3px 10px; border-radius:6px; font-size:12px; line-height:1.5;
}
.aah-seg-btn:hover { background:#f9fafb; }
.aah-seg-btn.on { background:#eff6ff; border-color:#93c5fd; color:#1d4ed8; font-weight:600; }
.aah-head-right { display:inline-flex; align-items:center; gap:8px; }
/* 已删除卡片：置灰 + 默认光标（不可点开，BOSS 那边已经没有这个会话了） */
.aah-hr-message.deleted { opacity:.6; cursor:default; background:#fafafa; }
.aah-hr-message.deleted:hover { background:#fafafa; }

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
.aah-pending-greetings { padding:12px; margin-bottom:12px; background:#fffbeb; border:1px solid #fcd34d; border-radius:8px; color:#92400e; font-size:12px; line-height:1.6; }
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
.aah-hr-time { font-size:11px; color:#9ca3af; white-space:nowrap; flex:0 0 auto; }
.aah-hr-job { font-size:12px; color:#0369a1; margin-bottom:6px; }
.aah-hr-content { font-size:12px; color:#4b5563; line-height:1.6; word-break:break-all; }

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
