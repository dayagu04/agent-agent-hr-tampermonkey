/**
 * Normalize the structured response of /api/plugin/chat/sync.
 *
 * The server owns the decision and the browser owns the side effect.  Keeping
 * facts (interview time, city, availability, ...) separate from actions is
 * important: a fact may be useful for wording or a notification, but it must
 * never be interpreted as permission to click a BOSS card.
 *
 * This module is deliberately DOM free.  It is used by the BOSS executor and
 * can be tested with sanitized JSON fixtures without a browser or Playwright.
 */
import { normalizeContactChannel } from './contact-policy'
import type { ContactChannel } from './types'

export type ChatActionType =
  | 'reply_text'
  | 'send_resume'
  | 'exchange_contact'
  | 'location_confirm'
  | 'accept_interview'
  | 'negotiate_interview'
  | 'notify_user'
  | 'unknown'

export type ChatActionDecision = 'allow' | 'reject' | 'skip' | null

export interface ChatActionInput {
  type?: unknown
  action_type?: unknown
  action?: unknown
  decision?: unknown
  allowed?: unknown
  allow?: unknown
  enabled?: unknown
  execute?: unknown
  id?: unknown
  action_id?: unknown
  actionId?: unknown
  contact_action_id?: unknown
  contactActionId?: unknown
  idempotency_key?: unknown
  idempotencyKey?: unknown
  channel?: unknown
  channels?: unknown
  requested_channels?: unknown
  text?: unknown
  content?: unknown
  reply?: unknown
  payload?: unknown
  [key: string]: unknown
}

export interface ChatFactContext {
  /** Known fields are copied into a bounded object; unknown keys are omitted. */
  interview_time?: string
  interview_type?: string
  location?: string
  city?: string
  expected_cities?: string[]
  availability?: string
  salary_min?: number
  salary_max?: number
  remote_preference?: string
  overtime_attitude?: string
  [key: string]: unknown
}

export interface NormalizedChatAction {
  type: ChatActionType
  /** Original action type, retained only for diagnostics and compatibility. */
  rawType: string
  /** Missing permission fields mean the server planned this action. */
  allowed: boolean
  /** Whether the response explicitly supplied a permission/decision field. */
  explicitPermission: boolean
  decision: ChatActionDecision
  actionId: number | null
  idempotencyKey?: string
  channels?: ContactChannel[]
  text?: string
  payload: Record<string, unknown>
}

export interface ChatActionPlanResponse {
  reply?: unknown
  send_resume?: unknown
  action_id?: unknown
  contact_exchange?: unknown
  send_contact?: unknown
  contact?: unknown
  actions?: unknown
  /** New protocol marker.  Absent means legacy fallback semantics. */
  actions_authoritative?: unknown
  action_plan_version?: unknown
  facts?: unknown
  fact_context?: unknown
  personal_facts?: unknown
  context?: unknown
}

export interface ChatActionPlan {
  /** New clients may opt into strict action presence semantics. */
  authoritative: boolean
  facts: ChatFactContext
  actions: NormalizedChatAction[]
  replyText: string
  sendResume: boolean
  replyActionId: number | null
  contactAction: NormalizedChatAction | null
}

const ACTION_ALIASES: Record<string, ChatActionType> = {
  reply: 'reply_text',
  reply_text: 'reply_text',
  send_message: 'reply_text',
  text_reply: 'reply_text',
  send_resume: 'send_resume',
  resume: 'send_resume',
  resume_attachment: 'send_resume',
  upload_resume: 'send_resume',
  exchange_contact: 'exchange_contact',
  contact_exchange: 'exchange_contact',
  send_contact: 'exchange_contact',
  exchange_phone: 'exchange_contact',
  exchange_wechat: 'exchange_contact',
  exchange_email: 'exchange_contact',
  location_confirm: 'location_confirm',
  confirm_location: 'location_confirm',
  work_location: 'location_confirm',
  answer_city: 'location_confirm',
  accept_interview: 'accept_interview',
  interview_accept: 'accept_interview',
  negotiate_interview: 'negotiate_interview',
  interview_negotiate: 'negotiate_interview',
  schedule_discussion: 'negotiate_interview',
  notify_user: 'notify_user',
  notify: 'notify_user',
}

const FACT_ALIASES: Record<string, keyof ChatFactContext> = {
  interview_time: 'interview_time',
  time_text: 'interview_time',
  proposed_time: 'interview_time',
  schedule: 'interview_time',
  interview_type: 'interview_type',
  meeting_type: 'interview_type',
  location: 'location',
  interview_location: 'location',
  city: 'city',
  expected_city: 'city',
  expected_cities: 'expected_cities',
  cities: 'expected_cities',
  availability: 'availability',
  start_date: 'availability',
  salary_min: 'salary_min',
  expected_salary_min: 'salary_min',
  salary_max: 'salary_max',
  expected_salary_max: 'salary_max',
  remote_preference: 'remote_preference',
  remote: 'remote_preference',
  overtime_attitude: 'overtime_attitude',
  overtime: 'overtime_attitude',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown, max = 240): string | undefined {
  if (typeof value !== 'string') return undefined
  const result = value.trim()
  return result ? result.slice(0, max) : undefined
}

function numberId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value)
    if (Number.isSafeInteger(n) && n > 0) return n
  }
  return null
}

function canonicalType(value: unknown): ChatActionType {
  const key = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return ACTION_ALIASES[key] || 'unknown'
}

function explicitPermission(raw: Record<string, unknown>): {
  explicit: boolean
  allowed: boolean
  decision: ChatActionDecision
} {
  const actionValue = String(raw.action ?? '').trim().toLowerCase()
  const actionIsDecision = /^(allow|allowed|approve|approved|accept|accepted|execute|send|yes|true|reject|rejected|deny|denied|decline|declined|no|skip|ignore|blocked|block|false)$/.test(actionValue)
  const keys = ['allowed', 'allow', 'enabled', 'execute', 'decision']
  const has = keys.some((key) => raw[key] !== undefined && raw[key] !== null) || actionIsDecision
  if (!has) return { explicit: false, allowed: true, decision: null }

  for (const key of ['allowed', 'allow', 'enabled', 'execute']) {
    if (typeof raw[key] === 'boolean') {
      return {
        explicit: true,
        allowed: raw[key] as boolean,
        decision: raw[key] ? 'allow' : 'skip',
      }
    }
  }

  const value = String(raw.decision ?? (actionIsDecision ? raw.action : '')).trim().toLowerCase()
  if (/^(allow|allowed|approve|approved|accept|accepted|execute|send|yes|true)$/.test(value)) {
    return { explicit: true, allowed: true, decision: 'allow' }
  }
  if (/^(reject|rejected|deny|denied|decline|declined|no)$/.test(value)) {
    // "reject" is a planned browser action (click the negative card), while
    // "deny/skip" means the policy forbids any side effect.  Keep those
    // states distinct so a fact-driven location rejection can execute safely.
    if (/^(reject|rejected|decline|declined|no)$/.test(value)) {
      return { explicit: true, allowed: true, decision: 'reject' }
    }
    return { explicit: true, allowed: false, decision: 'skip' }
  }
  if (/^(skip|ignore|blocked|block|false)$/.test(value)) {
    return { explicit: true, allowed: false, decision: 'skip' }
  }
  // A malformed permission field fails closed.  It must not turn into a
  // browser side effect merely because the action type is known.
  return { explicit: true, allowed: false, decision: 'skip' }
}

function normalizeChannels(value: unknown): ContactChannel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const channels = value
    .map(normalizeContactChannel)
    .filter((item): item is ContactChannel => !!item)
  return Array.from(new Set(channels))
}

const SAFE_PAYLOAD_KEYS = new Set([
  'fact_slot', 'fact_missing', 'reason', 'decision', 'allowed', 'action_type',
  'idempotency_key', 'action_id', 'channels', 'intent', 'source',
])

/** Keep action metadata useful for diagnostics without retaining contact values. */
function safePayload(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_PAYLOAD_KEYS.has(key)) continue
    if (typeof item === 'string') result[key] = item.slice(0, 180)
    else if (typeof item === 'boolean' || typeof item === 'number') result[key] = item
    else if (key === 'channels' && Array.isArray(item)) {
      result[key] = normalizeChannels(item) || []
    }
  }
  return result
}

function normalizeFacts(value: unknown): ChatFactContext {
  const source = asRecord(value)
  if (!source) return {}
  const facts: ChatFactContext = {}
  for (const [rawKey, target] of Object.entries(FACT_ALIASES)) {
    const value = source[rawKey]
    if (value === undefined || value === null) continue
    if (target === 'expected_cities') {
      const list = Array.isArray(value) ? value : [value]
      const cities = list.map((item) => text(item, 60)).filter((item): item is string => !!item)
      if (cities.length) facts[target] = Array.from(new Set(cities)).slice(0, 8)
      continue
    }
    if (target === 'salary_min' || target === 'salary_max') {
      const n = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(n) && n >= 0 && n <= 1000000) facts[target] = n
      continue
    }
    const valueText = text(value)
    if (valueText) facts[target] = valueText
  }
  // A nested salary object is a common server representation.
  const salary = asRecord(source.salary)
  if (salary) {
    const min = Number(salary.min)
    const max = Number(salary.max)
    if (Number.isFinite(min) && min >= 0 && min <= 1000000) facts.salary_min = min
    if (Number.isFinite(max) && max >= 0 && max <= 1000000) facts.salary_max = max
  }
  return facts
}

function normalizeAction(raw: unknown): NormalizedChatAction | null {
  const source = asRecord(raw)
  if (!source) return null
  const payload = asRecord(source.payload) || {}
  // action_type is preferred when type is a broad category such as "interview".
  const rawType = String(source.action_type ?? source.type ?? '').trim()
  const type = canonicalType(source.action_type) !== 'unknown'
    ? canonicalType(source.action_type)
    : canonicalType(source.type)
  const permission = explicitPermission(source)
  // `requested_channels` describes what HR asked for, not what policy
  // permitted.  Never promote it to an allowed channel list.
  const channelValue = source.channels ?? payload.channels ??
    (source.channel !== undefined ? [source.channel] : payload.channel !== undefined ? [payload.channel] : undefined)
  const channels = channelValue === undefined ? undefined : normalizeChannels(channelValue)
  const idRaw = source.action_id ?? source.actionId ?? source.id ?? payload.action_id ?? payload.actionId
  const keyRaw = source.idempotency_key ?? source.idempotencyKey ?? payload.idempotency_key ?? payload.idempotencyKey
  const actionText = text(source.text ?? source.content ?? source.reply ?? payload.text ?? payload.content ?? payload.reply)
  return {
    type,
    rawType,
    allowed: permission.allowed,
    explicitPermission: permission.explicit,
    decision: permission.decision,
    actionId: numberId(idRaw),
    idempotencyKey: text(keyRaw, 180),
    channels,
    text: actionText,
    payload: safePayload(payload),
  }
}

function legacyContactAction(response: ChatActionPlanResponse): NormalizedChatAction | null {
  const raw = response.contact_exchange ?? response.send_contact ?? response.contact
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'boolean') {
    return {
      type: 'exchange_contact', rawType: 'legacy_contact', allowed: raw,
      explicitPermission: true, decision: raw ? 'allow' : 'skip', actionId: null,
      payload: {},
    }
  }
  const action = normalizeAction({ type: 'exchange_contact', ...(asRecord(raw) || {}) })
  return action
}

function responseFacts(response: ChatActionPlanResponse): ChatFactContext {
  const context = asRecord(response.context)
  return normalizeFacts(
    response.facts ?? response.fact_context ?? response.personal_facts ?? context?.facts,
  )
}

/** Normalize old top-level fields and the versioned action plan into one view. */
export function normalizeChatActionPlan(response: ChatActionPlanResponse): ChatActionPlan {
  const rawActions = Array.isArray(response.actions) ? response.actions : null
  const actions = (rawActions || []).map(normalizeAction).filter((item): item is NormalizedChatAction => !!item)
  const hasVersion = Number(response.action_plan_version) > 0
  const authoritative = response.actions_authoritative === true || hasVersion
  const replyCandidates = actions.filter((item) => item.type === 'reply_text')
  const replyAction = replyCandidates.find((item) => item.allowed)
  const structuredReply = replyAction?.text
  const replyText = authoritative && rawActions
    ? (replyAction ? (structuredReply || text(response.reply, 2000) || '') : '')
    : (structuredReply || text(response.reply, 2000) || '')

  // A structured plan is authoritative for side effects.  For unversioned
  // responses retain the v0.6.8 top-level compatibility fields.
  const resumeAction = actions.find((item) => item.type === 'send_resume')
  const sendResume = rawActions
    ? (resumeAction ? resumeAction.allowed : (authoritative ? false : response.send_resume === true))
    : response.send_resume === true
  const contactAction = actions.find((item) => item.type === 'exchange_contact') || legacyContactAction(response)
  if (authoritative && contactAction && contactAction.channels === undefined) {
    // A modern contact action must name the permitted channel(s).  A generic
    // allow flag cannot silently widen the user's configured contact policy.
    contactAction.channels = []
  }

  return {
    authoritative,
    facts: responseFacts(response),
    actions,
    replyText,
    sendResume,
    replyActionId: replyAction?.actionId ?? (authoritative ? null : numberId(response.action_id)),
    contactAction,
  }
}

/** Return the action relevant to a BOSS card, if one was planned. */
export function actionForCard(
  plan: ChatActionPlan,
  kind: 'resume_request' | 'contact_exchange' | 'location_confirm',
): NormalizedChatAction | null {
  if (kind === 'resume_request') return plan.actions.find((item) => item.type === 'send_resume') || null
  if (kind === 'contact_exchange') return plan.contactAction
  return plan.actions.find((item) =>
    item.type === 'location_confirm' || item.type === 'accept_interview' || item.type === 'negotiate_interview',
  ) || null
}

/**
 * New authoritative plans deny an unplanned card action.  Legacy responses
 * return null so the existing local policy remains the compatibility fallback.
 */
export function cardActionAllowed(
  plan: ChatActionPlan,
  kind: 'resume_request' | 'contact_exchange' | 'location_confirm',
): boolean | null {
  if (!plan.authoritative) return null
  return actionForCard(plan, kind)?.allowed === true
}
