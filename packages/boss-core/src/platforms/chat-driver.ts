// Data-only boundary between the trusted conversation runner and the BOSS document.
import type { ChatMessage } from './boss-chat'
import type { AgentPolicy, ContactChannel } from '../types'
import { isAgentActionAllowed, isContactExchangeAllowed, normalizeContactChannel } from '../contact-policy'

export interface ChatHeader { company: string; hrName: string; jobTitle: string; salary: string; city: string }
export interface ChatCurrent { threadId: string; info: ChatHeader }
export interface ChatThreadTarget {
  key: string
  name: string
  company: string
  jobTitle: string
  unread: boolean
  bossId: string
  jobId: string
  lastTS: number | null
  sourceId?: string
}
export interface ChatSourceItem {
  index: number
  key: string
  boss: {
    uniqueId: string; friendId: string; encryptJobId: string
    brandName: string; positionName: string; name: string; unreadCount: number
  }
}
export interface ChatWindow { threads: ChatThreadTarget[]; scrollable: boolean; atEnd: boolean }
export interface ChatSnapshotRow { key: string; company: string; jobTitle: string; unread: boolean; lastTS: number | null; lastMsgPreview: string }
export type ChatCardKind = 'resume_request' | 'contact_exchange' | 'location_confirm' | 'unknown'
export interface ChatCardTarget { key: string; kind: ChatCardKind; question: string; canAccept: boolean; canReject: boolean }
export interface ChatCardAction { card: ChatCardTarget; accept: boolean; expectedThread: string; resumeName: string | null }
export interface ChatDeleteAction { expectedThread: string; guardMs: number; target?: ChatThreadTarget; dbLastMessageAt?: number | null }
export interface ChatDriver {
  onChatPage(): boolean
  stop?(): void
  cachedCurrent?(): ChatCurrent
  cachedSources?(): ChatSourceItem[] | null
  snapshot(): Promise<ChatSnapshotRow[]>
  sources(): Promise<ChatSourceItem[] | null>
  window(screen?: number): Promise<ChatWindow>
  open(target: ChatThreadTarget): Promise<ChatCurrent | null>
  current(): Promise<ChatCurrent>
  messages(expectedThread: string): Promise<ChatMessage[]>
  cards(expectedThread: string): Promise<ChatCardTarget[]>
  card(action: ChatCardAction, stableKey: string): Promise<boolean>
  send(text: string, expectedThread: string, stableKey: string): Promise<boolean>
  resume(resumeName: string | null, expectedThread: string, stableKey: string): Promise<boolean>
  delete(action: ChatDeleteAction, stableKey: string): Promise<boolean>
}

let installed: ChatDriver | null = null
export function installChatDriver(driver: ChatDriver): void { installed = driver }
export function installedChatDriver(): ChatDriver | null { return installed }

/** Only hashes, never conversation text or contact details, enter durable command keys. */
export async function chatActionKey(...parts: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))
  return `chat:${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`
}

export interface ContactDecision {
  /** 字段存在即表示后端已给出联系方式动作。 */
  provided: boolean
  allowed: boolean | null
  channel: ReturnType<typeof normalizeContactChannel>
  /** 若后端返回此字段，必须按每张卡片的渠道逐一匹配。 */
  channels?: ContactChannel[]
  actionId: number | null
  idempotencyKey?: string
}

/**
 * 计算单张联系方式卡片是否可点击。
 * 后端返回 channels 时它是权限边界，不能只看 allowed=true；没有渠道信息
 * 时才回落到旧协议的单渠道字段或插件本地策略。
 */
export function isContactCardAllowed(
  decision: ContactDecision | null | undefined,
  channel: ContactChannel | null,
  policy: AgentPolicy | null | undefined,
): boolean {
  if (!channel) return false
  if (decision?.provided) {
    if (decision.allowed !== true) return false
    if (decision.channels) return decision.channels.includes(channel)
    if (decision.channel) return decision.channel === channel
  }
  return isContactExchangeAllowed(policy, channel)
}

/** 卡片副作用使用与后端相同的动作键，防止卡片路径绕过 Agent 策略。 */
export function isActionCardAllowed(
  policy: AgentPolicy | null | undefined,
  kind: ChatCardKind,
): boolean {
  if (kind === 'resume_request') return isAgentActionAllowed(policy, 'send_resume')
  if (kind === 'location_confirm') {
    // 地点卡片既会回答城市，也可能推进面试地点协商；两项都必须允许。
    return isAgentActionAllowed(policy, 'answer_city') &&
      isAgentActionAllowed(policy, 'negotiate_interview')
  }
  return true
}

