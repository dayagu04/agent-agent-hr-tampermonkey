// 会话本地存储 —— 跨页「待打开会话」交接
//
// 在非聊天页点 HR 卡片要先跳到聊天页，而 location.href 跳转会销毁当前 JS 上下文，
// 只能把意图落盘，等聊天页重新加载、面板重新挂载后读取消费。

import { storage } from './platform-bridge'
import { diag } from './logger'

const PENDING_OPEN_KEY = 'aah_pending_open_thread'
/** 交接单有效期：跳转+加载正常在 10s 内完成，超时视为用户中途改了主意 */
const PENDING_OPEN_TTL = 60_000

export interface PendingOpen {
  company: string
  jobTitle: string
  createdAt: number
}

/** 记下「跳转后要打开这个会话」 */
export async function setPendingOpen(company: string, jobTitle: string): Promise<void> {
  await storage.set<PendingOpen>(PENDING_OPEN_KEY, {
    company,
    jobTitle,
    createdAt: Date.now(),
  })
}

/** 取出并清除待打开会话（一次性消费；无论有效与否都清，避免过期交接单残留） */
export async function takePendingOpen(): Promise<PendingOpen | null> {
  const rec = await storage.get<PendingOpen | null>(PENDING_OPEN_KEY, null)
  if (!rec) return null
  await storage.remove(PENDING_OPEN_KEY)
  if (!rec.createdAt || Date.now() - rec.createdAt > PENDING_OPEN_TTL) return null
  return rec
}

/** 清空交接单（换账号或调试时用） */
export async function clearChatStore(): Promise<void> {
  await storage.remove(PENDING_OPEN_KEY)
  diag('CHAT', '待打开会话交接单已清空')
}
