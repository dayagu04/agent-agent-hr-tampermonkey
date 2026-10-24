// Trusted conversation control flow. All BOSS document access is delegated to ChatDriver.
import { diag } from '../logger'
import type { PluginConfig, ContactChannel } from '../types'
import { markChatSent, reportChatOutcome, syncChatOne, reconcileThreads } from '../api'
import type { SyncChatResponse } from '../api'
import { chatTargetKey, findPlanTarget, loadChatPlan } from '../chat-plan'
import type { ChatPlanTarget } from '../chat-plan'
import { selectChatActionId, shouldReportContactOnly } from '../chat-action-report'
import { actionForCard, cardActionAllowed, normalizeChatActionPlan } from '../chat-action-plan'
import type { ChatActionPlan } from '../chat-action-plan'
import { flushConversationDeletedMarks, queueConversationDeletedMark, removeMirrorByKey } from '../ledger'
import { contactChannelFromQuestion, normalizeContactChannel } from '../contact-policy'
import { chatActionKey, isActionCardAllowed, isContactCardAllowed } from './chat-driver'
import type { ChatCardTarget, ChatDriver, ChatSourceItem, ChatThreadTarget, ContactDecision } from './chat-driver'

export interface ChatRoundOptions { mode?: 'full' | 'snapshot'; runId?: string; replyScope?: 'this_round' | 'all' }
export interface ChatRoundResult { handled: number; replied: number; resumes_sent?: number; pending?: number; synced?: number; cleaned?: number }
let chatRoundRunning = false
let chatRoundAbort = false
let activeDriver: ChatDriver
let roundProgress: ChatRoundResult = { handled: 0, replied: 0 }
class ChatRoundStopped extends Error {}
const shouldAbortChatRound = () => chatRoundAbort
const checkActive = () => { if (chatRoundAbort) throw new ChatRoundStopped() }
const delay = async (min: number, max: number) => {
  checkActive()
  await new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min)))
  checkActive()
}
// Check every subsequent page operation, including after an API response or a long snapshot.
const page: ChatDriver = new Proxy({} as ChatDriver, {
  get: (_target, property: keyof ChatDriver) => (...args: unknown[]) => {
    checkActive()
    const method = activeDriver[property] as (...values: unknown[]) => unknown
    return method.apply(activeDriver, args)
  },
})
export function requestStopChatRound(): void {
  if (!chatRoundRunning) return
  chatRoundAbort = true
  activeDriver.stop?.()
  diag('CHAT', '已收到停止请求，不再执行后续页面动作')
}
export async function runChatRoundWithDriver(
  driver: ChatDriver,
  cfg: PluginConfig,
  maxThreads = 5,
  log: (message: string) => void = () => {},
  opts: ChatRoundOptions = {},
): Promise<ChatRoundResult> {
  if (chatRoundRunning) {
    log('已有会话托管在运行，本次跳过（防止重复发消息给 HR）')
    return { handled: 0, replied: 0 }
  }
  if (!driver.onChatPage()) return { handled: 0, replied: 0 }
  chatRoundRunning = true
  chatRoundAbort = false
  activeDriver = driver
  roundProgress = { handled: 0, replied: 0, synced: 0, cleaned: 0, resumes_sent: 0 }
  try {
    return await runChatRoundInner(cfg, maxThreads, log, opts)
  } catch (error) {
    if (!(error instanceof ChatRoundStopped) && !chatRoundAbort) throw error
    log('会话托管已停止')
    return { ...roundProgress }
  } finally {
    chatRoundRunning = false
    chatRoundAbort = false
  }
}
const RECONCILE_INTERVAL_MS = 5 * 60_000
let lastReconcileAt = 0
const resumeName = (cfg: PluginConfig): string | null => cfg.defaultSendResumeId && cfg.resumeNames
  ? cfg.resumeNames[String(cfg.defaultSendResumeId)] || null : null

function logChatHistory(
  _t: ChatThreadTarget,
  messages: Array<{ sender: 'hr' | 'me' | 'system'; content: string }>,
): void {
  const counts = { hr: 0, me: 0, system: 0 }
  let totalChars = 0
  for (const message of messages) {
    counts[message.sender]++
    totalChars += (message.content || '').length
  }
  diag('HIST', '会话历史摘要', {
    messageCount: messages.length,
    senderCounts: counts,
    totalChars,
    lastSender: messages.at(-1)?.sender || 'none',
  })
}

function extractContactDecision(
  res: SyncChatResponse,
  actionPlan: ChatActionPlan = normalizeChatActionPlan(res),
): ContactDecision | null {
  const planned = actionPlan.contactAction
  if (planned) {
    return {
      provided: true,
      allowed: planned.allowed,
      channel: planned.channels?.length === 1 ? planned.channels[0] : null,
      channels: planned.channels,
      actionId: planned.actionId,
      idempotencyKey: planned.idempotencyKey,
    }
  }
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' ? value as Record<string, unknown> : null
  const candidates: unknown[] = [res.contact_exchange, res.send_contact, res.contact]
  if (Array.isArray(res.actions)) {
    const action = res.actions.find((item) => {
      const type = String(item.type || item.action_type || '').toLowerCase()
      return type === 'contact_exchange' || type === 'send_contact' || type === 'exchange_contact'
    })
    if (action) candidates.push(action.payload || action)
  }
  const raw = candidates.find((value) => value !== undefined && value !== null)
  if (raw === undefined) return null
  if (typeof raw === 'boolean') {
    return { provided: true, allowed: raw, channel: null, actionId: null }
  }
  const obj = record(raw)
  if (!obj) return { provided: true, allowed: null, channel: null, actionId: null }
  const mode = String(obj.action || obj.decision || '').toLowerCase()
  const explicit = typeof obj.allowed === 'boolean'
    ? obj.allowed
    : typeof obj.allow === 'boolean'
      ? obj.allow
      : mode === 'allow'
        ? true
        : false
  const idRaw = obj.contact_action_id ?? obj.contactActionId ?? obj.action_id ?? obj.actionId
  const actionId = typeof idRaw === 'number' && Number.isFinite(idRaw) ? idRaw : null
  const channels = Array.isArray(obj.channels)
    ? Array.from(new Set(obj.channels.map(normalizeContactChannel).filter((v): v is ContactChannel => !!v)))
    : undefined
  return {
    provided: true,
    allowed: explicit,
    channel: normalizeContactChannel(obj.channel ?? obj.method ?? obj.type),
    channels,
    actionId,
    idempotencyKey: typeof (obj.idempotency_key ?? obj.idempotencyKey) === 'string'
      ? String(obj.idempotency_key ?? obj.idempotencyKey)
      : undefined,
  }
}

async function handleCard(
  card: ChatCardTarget,
  cfg: PluginConfig,
  scope: string,
  expectThread: string,
  log: (m: string) => void,
  contactDecision?: ContactDecision | null,
  actionPlan: ChatActionPlan = normalizeChatActionPlan({}),
): Promise<boolean> {
  // 点按钮前同样校验会话身份，防止中途切换点错人
  if ((await page.current()).threadId !== expectThread) {
    diag('CHAT', '已中止卡片操作：会话已切换')
    return false
  }

  // A versioned backend plan is the authority for external side effects.  A
  // fact such as an interview time or city is never enough to click a card;
  // the corresponding action must be present and allowed.  Legacy responses
  // return null and continue through the v0.6.8 local-policy fallback below.
  const cardKind = card.kind === 'unknown' ? null : card.kind
  const backendPermission = cardKind ? cardActionAllowed(actionPlan, cardKind) : null
  const backendAction = cardKind ? actionForCard(actionPlan, cardKind) : null
  const executeCard = async (accept: boolean) => page.card({
    card, accept, expectedThread: expectThread, resumeName: resumeName(cfg),
  }, await chatActionKey(scope, 'card', card.key, accept, backendAction?.idempotencyKey || contactDecision?.idempotencyKey || ''))
  if (backendPermission === false) {
    log(`  ↳ ${card.kind} 未获后端动作授权 → 跳过`)
    diag('CHAT', '跳过未获后端授权的卡片动作', { kind: card.kind })
    return false
  }

  if (card.kind === 'contact_exchange') {
    const channel = contactChannelFromQuestion(card.question)
    // 后端给了动作时，以后端显式决策为准；没有动作才回落到本地策略。
    if (contactDecision?.channel && channel && contactDecision.channel !== channel) {
      log(`  ↳ HR 索要${channel}，后端动作渠道为${contactDecision.channel} → 按策略跳过`)
      diag('CHAT', '跳过联系方式交换卡片（渠道不匹配）', {
        channel,
        backendChannel: contactDecision.channel,
      })
      return false
    }
    if (!channel) {
      log('  ↳ HR 索要未识别联系方式 → 按策略跳过')
      diag('CHAT', '跳过联系方式交换卡片（未知渠道）', {
        backendDecision: contactDecision?.allowed ?? null,
        questionLength: card.question.length,
      })
      return false
    }
    const allowed = isContactCardAllowed(contactDecision, channel, cfg.agentPolicy)
    if (!allowed || !card.canAccept) {
      log(`  ↳ HR 索要${channel || '联系方式'} → 按策略跳过`)
      diag('CHAT', '跳过联系方式交换卡片', {
        channel,
        backendDecision: contactDecision?.allowed ?? null,
        questionLength: card.question.length,
      })
      return false
    }
    log(`  ↳ HR 索要${channel} → 点「同意」`)
    return executeCard(true)
  }

  // 认不出的卡片一律不点：盲点等于把未知授权交给对方
  if (card.kind === 'unknown') {
    log('  ⚠ 未识别的交互卡片 → 不自动处理，请手动查看')
    diag('CHAT', '⚠ 跳过未识别卡片（未知类型不自动点击）', {
      questionLength: card.question.length,
    })
    return false
  }

  if (card.kind === 'resume_request') {
    if (!isActionCardAllowed(cfg.agentPolicy, card.kind)) {
      log('  ↳ HR 索要附件简历 → 按 Agent 策略跳过')
      diag('CHAT', '跳过简历卡片（策略未允许发送简历）')
      return false
    }
    if (!card.canAccept) return false
    log('  ↳ HR 索要附件简历 → 点「同意」')
    return executeCard(true)
  }

  if (card.kind === 'location_confirm') {
    if (!isActionCardAllowed(cfg.agentPolicy, card.kind)) {
      log('  ↳ 工作地点确认 → 按 Agent 策略跳过')
      return false
    }
    if (backendAction?.decision === 'reject') return card.canReject ? executeCard(false) : false
    if (backendAction?.decision === 'allow') return card.canAccept ? executeCard(true) : false
    const prefCity = (cfg.prefCity || '').trim()
    const offCity = !!prefCity && !card.question.includes(prefCity)
    if (offCity && cfg.rejectOffCityLocation) {
      log('  ↳ 地点与期望城市不符，按设置拒绝')
      return card.canReject ? executeCard(false) : false
    }
    log(offCity ? '  ↳ 已接受工作地点（与期望城市不一致）' : '  ↳ 工作地点确认 → 点「可以接受」')
    return card.canAccept ? executeCard(true) : false
  }
  return false
}

export async function recordConversationDeleted(
  cfg: PluginConfig,
  company: string,
  jobTitle: string,
  reason: string,
  identity?: { encryptJobId?: string },
): Promise<void> {
  await queueConversationDeletedMark({
    company,
    job_title: jobTitle,
    reason,
    encrypt_job_id: identity?.encryptJobId || '',
  })
  await flushConversationDeletedMarks(cfg)
  await removeMirrorByKey(company, jobTitle, identity)
  // 通知面板：自动删除后镜像已变，立即重渲染，不再等 60s 轮询
  try {
    globalThis.dispatchEvent(new CustomEvent('aah:chat-mirror-changed'))
  } catch {
    /* 事件派发失败不影响删除结果 */
  }
}

function bossRowInfo(boss: ChatSourceItem['boss']): { encryptJobId: string; company: string; jobTitle: string } {
  return {
    encryptJobId: boss.encryptJobId || '',
    company: boss.brandName || '',
    jobTitle: boss.positionName || '',
  }
}

const normText = (s: string) => (s || '').replace(/\s+/g, '').toLowerCase()

/**
 * 计划目标是否存在于 BOSS 全量会话列表（virtual-list.dataSources）。
 *
 * 真实岗位按 encryptJobId 精确比对；inbound 会话（HR 主动打招呼建档）的
 * platform_job_id 是后端虚构的 `inbound:公司:岗位`，与 BOSS 真实 jobId 对不上，
 * 只能按公司名模糊判定存在性（与 chat-plan.findPlanTarget 同容忍度）。
 */
function planTargetInSources(p: ChatPlanTarget, sources: ChatSourceItem[]): boolean {
  const jobId = (p.encrypt_job_id || '').trim()
  if (jobId && !jobId.startsWith('inbound:')) {
    return sources.some((s) => String(s.boss.encryptJobId || '') === jobId)
  }
  const cc = normText(p.company || '')
  if (!cc) return false
  return sources.some((s) => {
    const bc = normText(String(s.boss.brandName || ''))
    return !!bc && (bc.includes(cc) || cc.includes(bc))
  })
}


function sourceThread(item: ChatSourceItem): ChatThreadTarget {
  return { key: item.key, name: item.boss.name, company: item.boss.brandName, jobTitle: item.boss.positionName,
    unread: item.boss.unreadCount > 0, bossId: item.boss.uniqueId || item.boss.friendId,
    jobId: item.boss.encryptJobId, lastTS: null, sourceId: item.key }
}
async function forEachThreadScrolling(
  log: (message: string) => void,
  onThread: (thread: ChatThreadTarget, seq: number) => Promise<'ok' | 'stop'>,
): Promise<void> {
  const seen = new Set<string>()
  let seq = 0
  let emptyScreens = 0
  for (let screen = 0; screen < 300; screen++) {
    const window = await page.window(screen)
    const threads = window.threads.map((t, i) => ({ t, i }))
      .sort((a, b) => Number(b.t.unread) - Number(a.t.unread) || a.i - b.i).map(value => value.t)
    let fresh = 0
    for (const t of threads) {
      if (!t.key || t.key === '|' || seen.has(t.key)) continue
      seen.add(t.key)
      fresh++
      if (await onThread(t, ++seq) === 'stop') return
      checkActive()
    }
    emptyScreens = fresh ? 0 : emptyScreens + 1
    if (window.atEnd) emptyScreens++
    if (!window.scrollable || emptyScreens >= 3) return
    if (fresh) log(`已处理 ${seen.size} 个会话，继续下翻...`)
  }
  log(`⚠ 会话过多（已处理 ${seen.size} 个），剩余下轮继续`)
}
async function maybeCleanupThread(
  cfg: PluginConfig, t: ChatThreadTarget, log: (message: string) => void,
  dbLastMessageAt: number | null, _opened = false, planJobId = '', reason = 'aged_no_reply',
): Promise<number> {
  const current = await page.open(t)
  if (!current) return 0
  const messages = await page.messages(current.threadId)
  logChatHistory(t, messages)
  const key = await chatActionKey('cleanup', t.key, planJobId, reason, dbLastMessageAt, messages)
  if (!(await page.delete({ expectedThread: current.threadId, target: t, dbLastMessageAt,
    guardMs: (cfg.cleanupGuardSeconds ?? 3) * 1000 }, key))) return 0
  await recordConversationDeleted(cfg, t.company, t.jobTitle, reason, { encryptJobId: planJobId })
  log('  ↳ 已删除目标会话（后端策略）')
  roundProgress.cleaned = (roundProgress.cleaned || 0) + 1
  return 1
}
async function strategyDeleteCurrent(
  cfg: PluginConfig, expectedThread: string, scope: string, company: string, jobTitle: string,
  reason: string, log: (message: string) => void,
): Promise<boolean> {
  if (!(await page.delete({ expectedThread, guardMs: (cfg.cleanupGuardSeconds ?? 3) * 1000 },
    await chatActionKey(scope, 'delete', reason)))) {
    log('  ↳ 会话删除未确认（用户活跃或目标已切换）')
    return false
  }
  await recordConversationDeleted(cfg, company, jobTitle, reason)
  roundProgress.cleaned = (roundProgress.cleaned || 0) + 1
  return true
}
async function processReplyThread(
  cfg: PluginConfig,
  t: ChatThreadTarget,
  seq: number,
  log: (m: string) => void,
  opts: { runId?: string },
  replyScope: 'this_round' | 'all',
): Promise<{ synced: number; replied: number; resumesSent: number; cleaned: number }> {
  const opened = await page.open(t)
  if (!opened) {
    diag('CHAT', `跳过会话：无法打开（${opened}）`)
    return { synced: 0, replied: 0, resumesSent: 0, cleaned: 0 }
  }
  return processOpenedThread(cfg, t, seq, log, { ...opts, expectedThread: opened.threadId }, replyScope)
}

/** 会话已打开后的完整回复流程（滚动方案与零滚动方案共用，避免重复 open）。 */
async function processOpenedThread(
  cfg: PluginConfig,
  t: ChatThreadTarget,
  seq: number,
  log: (m: string) => void,
  opts: { runId?: string; expectedThread: string },
  replyScope: 'this_round' | 'all',
): Promise<{ synced: number; replied: number; resumesSent: number; cleaned: number }> {
  // 目标会话指纹：必须在切换完成后捕获，作为发送前「仍是同一会话」的校验基准。
  // 历史 bug：在 openThread 之前捕获，expectThread 恒为上一会话，切到目标后
  // 必然失配 → 所有回复「未发送（会话已切换或发送失败）」（2026-08-05 现场）。
  const current = await page.current()
  if (!opts.expectedThread || current.threadId !== opts.expectedThread) return { synced: 0, replied: 0, resumesSent: 0, cleaned: 0 }
  const threadId = opts.expectedThread

  // 读取消息：不只依赖未读标记 —— 已读未回（最后一条是 HR）同样需要回复。
  // 只以「最后一条消息是否为 HR」判定，避免漏掉用户手动读过的消息。
  const messages = await page.messages(threadId)
  const scope = await chatActionKey(opts.runId || 'manual', t.key, threadId, messages)
  // 普通日志只记录统计摘要，禁止写入会话正文。
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
    return { synced: 0, replied: 0, resumesSent: 0, cleaned: 0 }
  }

  // 读取会话信息
  const info = current.info
  const { company, jobTitle, salary, city } = info
  diag('CHAT', '会话归属信息已读取', {
    companyPresent: !!company,
    jobTitlePresent: !!jobTitle,
    salaryPresent: !!salary,
    cityPresent: !!city,
  })

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
  checkActive()
  if (!res) {
    log('  后端处理失败，跳过当前会话')
    return { synced: 0, replied: 0, resumesSent: 0, cleaned: 0 }
  }

  const actionPlan = normalizeChatActionPlan(res)
  diag('CHAT', '后端返回会话处理计划', {
    intent: res.intent,
    newMessages: res.new_messages,
    hasReply: !!actionPlan.replyText,
    contactAction: !!actionPlan.contactAction,
    actionTypes: actionPlan.actions.map((item) => item.type),
    factKeys: Object.keys(actionPlan.facts),
    messagePresent: !!res.message,
  })

  // 结果回填（Phase 1）：意图明确时把 HR 侧动作回传后端（面试邀约 / 被拒），
  // 供行为学习与推荐融合使用；失败静默，不影响主流程。
  if (res.intent === 'interview_invite' || res.intent === 'rejection') {
    await reportChatOutcome(cfg, {
      run_id: opts.runId || '',
      items: [{
        encrypt_job_id: '',
        company: company || t.company,
        job_title: jobTitle || t.jobTitle,
        outcome: res.intent === 'interview_invite' ? 'interview_invite' : 'rejected',
        detail: res.intent,
      }],
    })
  }

  let replied = 0
  let resumesSent = 0
  let cleaned = 0

  // 联系方式卡片不依赖文本回复：后端给出 contact action 时按其决策执行，
  // 没有该字段则按本地 agentPolicy 的已配置渠道执行。先于「无回复」分支处理，
  // 否则 HR 只索要联系方式时会被提前 return 遗漏。
  const contactDecision = extractContactDecision(res, actionPlan)
  let contactSucceeded = false
  for (const card of (await page.cards(threadId)).filter((c) => c.kind === 'contact_exchange')) {
    const contactOk = await handleCard(card, cfg, scope, threadId, log, contactDecision, actionPlan)
    if (contactOk) contactSucceeded = true
  }

  const actionId = selectChatActionId(actionPlan.replyActionId, contactDecision?.actionId)

  if (!actionPlan.replyText) {
    log('  当前会话无需回复')
    // 策略删除：低质量公司不回复删除 / 拒绝原因已采集删除（delete_after_send 且无回复）
    if (res.delete_after_send && !shouldAbortChatRound()) {
      log('  ↳ 策略删除当前会话')
      if (await strategyDeleteCurrent(cfg, threadId, scope, company || t.company, jobTitle, 'low_quality', log)) cleaned++
    }
    if (shouldReportContactOnly(false, contactSucceeded) && actionId !== null) {
      await markChatSent(cfg, actionId, true, '')
    }
    return { synced: 1, replied: 0, resumesSent: 0, cleaned }
  }

  // 简历卡优先处理（2026-08-11 实测修复）：
  // BOSS 索要简历用「同意/拒绝」卡片。若先发文字，卡片下方出现我方消息，
  // isCardAnswered 会把卡片误判为「已答过」而跳过 → 简历永远发不出去。
  // 因此先点卡片发简历，再发文字回复。
  let resumeCardHandled = false
  const resumePolicyAllowed = isActionCardAllowed(cfg.agentPolicy, 'resume_request') &&
    cardActionAllowed(actionPlan, 'resume_request') !== false
  if (actionPlan.sendResume && resumePolicyAllowed) {
    const resumeCard = (await page.cards(threadId)).find((c) => c.kind === 'resume_request')
    if (resumeCard) {
      resumeCardHandled = await handleCard(resumeCard, cfg, scope, threadId, log, null, actionPlan)
    }
  } else if (actionPlan.sendResume && !resumePolicyAllowed) {
    log('  ↳ 后端建议发送简历，但当前 Agent 策略未允许，跳过简历副作用')
  }

  // 发送回复（当前会话已打开，直接发，无需重开）
  log(`  准备发送回复（长度 ${actionPlan.replyText.length}）`)
  const ok = await page.send(actionPlan.replyText, threadId, await chatActionKey(scope, 'reply', actionId, actionPlan.replyText))
  if (ok) {
    replied++
    roundProgress.replied++
    if (actionPlan.sendResume) {
      // 卡片路径已发简历则跳过；否则退回输入区「发简历」按钮路径
      let resumeOk = resumePolicyAllowed && resumeCardHandled
      if (resumePolicyAllowed && !resumeOk && !shouldAbortChatRound()) resumeOk = await page.resume(resumeName(cfg), threadId, await chatActionKey(scope, 'resume', actionId))
      if (!resumeOk) log('  ↳ 简历未发出，需手动处理')
      else { resumesSent++; roundProgress.resumes_sent = (roundProgress.resumes_sent || 0) + 1 }
      // 简历未发出时不得标记 sent：否则后端统计会把「文本已发、简历没发」
      // 的动作也计成已发简历（历史计数虚高根因之一）。
      if (actionId !== null) {
        await markChatSent(cfg, actionId, resumeOk, resumeOk ? '' : '简历未发出')
      }
    } else if (actionId !== null) {
      await markChatSent(cfg, actionId, true, '')
    }
    // 明确被拒：后端已换成「拿信息」话术；会话保留等原因（不再发完即删），
    // 原因到达后由 rejection_reason 分支采集并删除；HR 一直不回由超时清理兜底。
    if (res.delete_after_send && !shouldAbortChatRound()) {
      log('  策略删除当前会话')
      if (await strategyDeleteCurrent(cfg, threadId, scope, company || t.company, jobTitle, 'rejection', log)) cleaned++
    }
  } else {
    log('  当前会话未发送（会话已切换或发送失败）')
    if (actionId !== null) {
      await markChatSent(cfg, actionId, false, '页面发送未确认')
    }
  }

  checkActive()

  // 处理当前会话的交互卡片（重新检测，避免跨轮引用失效）。
  // 简历卡已在上方优先处理，这里只处理其余卡片；联系方式卡片由后端动作/策略分支处理。
  for (const card of (await page.cards(threadId))) {
    if (card.kind === 'resume_request' || card.kind === 'contact_exchange') continue
    await handleCard(card, cfg, scope, threadId, log, null, actionPlan)
  }

  await delay(800, 1600) // 会话间间隔
  return { synced: 1, replied, resumesSent, cleaned }
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
  let skipped = 0
  const mode = opts.mode || 'full'

  // 回复范围：只有编排器运行时才有「本轮」概念（runId 存在）；手动开启会话托管
  // 没有本轮，一律按 all 处理，否则后端 this_round 缺 run_id 会全部拒回。
  const replyScope: 'this_round' | 'all' = opts.runId
    ? (opts.replyScope || cfg.replyScope || 'this_round')
    : 'all'

  log(
    mode === 'snapshot'
      ? `开始消息快照（后端决策待回复数，不发送）。运行中请勿手动点击会话列表。`
      : `开始处理会话（后端计划 + 未读行兜底）。运行中请勿手动点击会话列表。`,
  )
  diag('CHAT', `本轮开始 ${mode}，replyScope=${replyScope} 预算 ${maxThreads}`)

  // 0) 对账：采集当前实际列表，上报后端对账并拿到该删除的 key。
  //    采集会滚动整份列表（慢），按 RECONCILE_INTERVAL_MS 节流，避免每轮全量滚动。
  let keysToDelete: string[] = []
  const now = Date.now()
  if (now - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
    try {
      const snapshot = await page.snapshot()
      if (snapshot.length > 0) {
        const reconcilePayload = snapshot.map((s) => ({
          key: s.key,
          company: s.company,
          job_title: s.jobTitle,
          unread: s.unread,
          last_ts: s.lastTS,
          last_msg_preview: s.lastMsgPreview,
        }))
        const reconcileResult = await reconcileThreads(cfg, { threads: reconcilePayload })
        keysToDelete = reconcileResult.to_delete
        diag('CHAT', `对账完成：to_delete=${keysToDelete.length} created=${reconcileResult.created} marked_deleted=${reconcileResult.marked_deleted}`)
      }
    } catch (e) {
      diag('CHAT', '对账失败，继续执行', { errorType: (e as Error).name || 'Error' })
    }
    checkActive()
    lastReconcileAt = Date.now()
  }

  checkActive()

  // 1) 拿后端计划：哪些会话要回复 / 要清理。失败时降级为只处理未读行，
  //    绝不回退到「逐个打开全部会话」（2026-08-06 卡聊天页 14 分钟的根因）。
  const { pending: planPending, targets: planTargets } = await loadChatPlan(cfg, { replyScope })
  // 补发上次网络失败遗留的「BOSS 端已删除」标记（自愈，避免死会话跨轮残留）
  await flushConversationDeletedMarks(cfg)
  let planReply = 0
  let planCleanup = 0
  for (const t of planTargets) {
    if (t.action === 'reply') planReply++
    else if (t.action === 'cleanup') planCleanup++
  }
  diag('CHAT', `后端计划 pending=${planPending} reply=${planReply} cleanup=${planCleanup}`)

  if (mode === 'snapshot') {
    // 快照不再滚动整个列表数未读：待回复数以后端 DB 决策为准（DOM 未读兜底
    // 由 chat_snapshot_done 事件取 max 时补上）。需要 DOM 结构时用「开始调试」按钮。
    log(`消息快照完成：待回复 ${planPending} 个（后端决策）`)
    diag('CHAT', `消息快照完成 pending=${planPending}`)
    return { handled: 0, replied: 0, pending: planPending }
  }

  log(`开始单遍处理会话（后端计划 reply=${planReply} cleanup=${planCleanup}，回复预算 ${maxThreads}）...`)
  let synced = 0
  let storeMode = false

  // 2a) 零滚动快路径（方案 C）：virtual-list.dataSources 一次拿到全部会话。
  //     全量打开核对：以「前端实际读到的最后一条消息 + 意图」为准决定回不回，
  //     不复用 DB 计划做打开过滤——DB 滞后会漏掉真实待回复（HR 在我方上次同步后
  //     又发消息）；全量打开同时把「我方已发的回复」回写 DB，让数据库自我校准。
  //     回复预算 maxThreads 只限制实际发送条数，不限制扫描。
  const sources = await page.sources()
  if (sources && sources.length > 0) {
    storeMode = true
    diag('CHAT', `零滚动数据源命中：${sources.length} 条（全量打开核对，前端实测为准）`)

    // 全量列表在手：后端计划里有、BOSS 全量列表里完全没有的目标 → BOSS 端已删，
    // 直接补标记（防止死会话残留 + 每轮重复寻找）。inbound 虚拟 jobId 用公司兜底。
    const current0 = await page.sources()
    if (current0) {
      for (const p of planTargets) {
        if (planTargetInSources(p, current0)) continue
        diag('CHAT', '计划目标在 BOSS 全量列表中不存在，按已删除补标记', {
          action: p.action,
          hasNativeJobId: !!p.encrypt_job_id && !p.encrypt_job_id.startsWith('inbound:'),
        })
        await recordConversationDeleted(cfg, p.company, p.job_title, 'boss_side_deleted', {
          encryptJobId: p.encrypt_job_id,
        })
        cleaned++
      }
    }

    for (const item of sources) {
      if (replied >= maxThreads) break   // 回复预算：限制实际发送条数
      if (shouldAbortChatRound()) break
      handled++; roundProgress.handled = handled
      // 每次处理前按会话身份（friendId/uniqueId/encryptJobId）在最新列表里重新定位：
      // 清理删除会让虚拟列表下标前移，缓存下标会点错会话（把回复发给错误的 HR）。
      const current = await page.sources()
      if (!current) break
      const live = current.find(s => s.key === item.key)
      if (!live) continue // 已被删除/未加载
      const boss = live.boss
      const unread = Number(boss.unreadCount || 0) > 0
      let target = findPlanTarget(planTargets, bossRowInfo(boss), { lenient: false })
      if (!target) {
        const loose = findPlanTarget(planTargets, bossRowInfo(boss), { lenient: true })
        if (loose?.action === 'reply') target = loose
      }
      // 计划未命中且行无未读 → 跳过，且**不打开**会话。
      //
      // 修复（2026-08-14）：此前这个判断写在 openThreadByIndex 之后，
      // 于是每轮把全部会话逐个打开、再跳过绝大多数（实测 handled=100
      // / skipped=79，一轮几分钟且常中途结束）。判断只依赖列表数据源里的
      // unreadCount 与后端计划，无需打开会话即可完成 —— 移到打开之前。
      // HR 新消息会置未读、计划也覆盖已回复目标，跳过不会漏真实待回复。
      if (!target && !unread) {
        skipped++
        continue
      }
      const t = sourceThread(live)
      const opened = await page.open(t)
      if (!opened) {
        diag('CHAT', `索引跳转失败 idx=${live.index}`)
        continue
      }
      // 对账删除：优先级最高（reconcile 返回的是精确时间戳判定后的结果）
      const key = chatTargetKey({ company: t.company, job_title: t.jobTitle, encrypt_job_id: boss.encryptJobId || '' })
      if (keysToDelete.includes(key)) {
        if (!cfg.cleanReadConversations) {
          skipped++
          continue
        }
        cleaned += await maybeCleanupThread(
          cfg, t, log, target?.last_message_at ?? null, true, boss.encryptJobId || '',
          'reconcile_timeout',
        )
        continue
      }
      // 后端计划清理（保留原有逻辑，reconcile 未覆盖的场景）
      if (target?.action === 'cleanup' && !unread) {
        if (!cfg.cleanReadConversations) {
          skipped++
          continue
        }
        cleaned += await maybeCleanupThread(
          cfg, t, log, target.last_message_at, true, target.encrypt_job_id,
          target.reason || 'aged_no_reply',
        )
        continue
      }
      const r = await processOpenedThread(cfg, t, handled, log, { runId: opts.runId, expectedThread: opened.threadId }, replyScope)
      synced += r.synced; roundProgress.synced = synced
      replied += r.replied
      resumesSent += r.resumesSent
      cleaned += r.cleaned; roundProgress.cleaned = cleaned
    }
  }

  // 2b) 滚动兜底：零滚动数据源不可用（组件改名/字段变动）时，单遍滚动照旧，
  //     行 → 键 → 查计划，只打开目标行。
  if (!storeMode) await forEachThreadScrolling(log, async (t, seq) => {
    if (synced >= maxThreads) return 'stop'   // 预算用完，提前结束
    if (shouldAbortChatRound()) return 'stop'
    handled++; roundProgress.handled = handled

    // 行 → 键：优先平台岗位 ID（行内 Vue 数据，无需打开），退化为 公司|岗位 文本
    const row = { jobId: t.jobId, brandName: t.company, title: t.jobTitle }
    // 先严格匹配（jobId 精确 / 公司+岗位都命中），再宽松匹配（仅公司，只对 reply 生效）
    let target = findPlanTarget(planTargets, {
      encryptJobId: row.jobId,
      company: row.brandName || t.company,
      jobTitle: row.title || t.jobTitle,
    }, { lenient: false })
    if (!target) {
      const loose = findPlanTarget(planTargets, {
        encryptJobId: row.jobId,
        company: row.brandName || t.company,
        jobTitle: row.title || t.jobTitle,
      }, { lenient: true })
      if (loose?.action === 'reply') target = loose
    }

    // 计划未命中且行无未读 → 跳过（既不打开也不等待）
    if (!target && !t.unread) {
      skipped++
      return 'ok'
    }

    // 对账删除：优先级最高（reconcile 返回的是精确时间戳判定后的结果）
    const key = chatTargetKey({
      company: row.brandName || t.company,
      job_title: row.title || t.jobTitle,
      encrypt_job_id: row.jobId || '',
    })
    if (keysToDelete.includes(key)) {
      if (!cfg.cleanReadConversations) {
        skipped++
        return 'ok'
      }
      cleaned += await maybeCleanupThread(
        cfg, t, log, target?.last_message_at ?? null, false, row.jobId || '',
        'reconcile_timeout',
      )
      return 'ok'
    }

    // 计划命中清理：行时间校验 + 打开确认最后一条是我方 → 删除（保留原有逻辑）
    if (target?.action === 'cleanup' && !t.unread) {
      if (!cfg.cleanReadConversations) {
        skipped++
        return 'ok'
      }
      cleaned += await maybeCleanupThread(
        cfg, t, log, target.last_message_at, false, target.encrypt_job_id,
        target.reason || 'aged_no_reply',
      )
      return 'ok'
    }
    // 计划命中 reply 或未读兜底 → 打开并走完整回复流程
    const r = await processReplyThread(cfg, t, seq, log, { runId: opts.runId }, replyScope)
    synced += r.synced; roundProgress.synced = synced
    replied += r.replied
    resumesSent += r.resumesSent
    cleaned += r.cleaned; roundProgress.cleaned = cleaned
    return 'ok'
  })

  log(`单遍处理完成${storeMode ? '（零滚动）' : ''}：扫描 ${handled} 个会话（跳过 ${skipped}），同步 ${synced}，发送 ${replied} 条回复，简历 ${resumesSent} 次，清理 ${cleaned}`)
  diag('CHAT', `单遍处理完成 mode=${storeMode ? 'store' : 'scroll'} handled=${handled} skipped=${skipped} synced=${synced} replied=${replied} resumes_sent=${resumesSent} cleaned=${cleaned}`)

  return { handled, replied, resumes_sent: resumesSent, synced, cleaned }
}

