// 已删除会话台账（本地持久化）
//
// 为什么需要本地台账：后端 /api/conversations 没有删除端点，删除只发生在
// BOSS 页面上。原实现删完只从 `recentHRMessages` 数组里 splice 掉，而面板每
// 30s 重新拉一次 /api/conversations/list —— 那条会话又回来了，用户会以为
// 「删除时好时坏」。所以必须在本地记住「哪些已经删过」，渲染时据此分流。
//
// 台账同时是「已删除」分类的数据源：用户要能看到删过什么、单条清除、一键清空。
import { storage } from './platform-bridge'

const KEY = 'aah_deleted_threads'

export interface DeletedThread {
  /** 会话在后端的 id（与 HRMessageSummary.id 对应，用于渲染层过滤） */
  id: number
  company: string
  jobTitle: string
  /** 删除时间戳（毫秒），用于「N 天前」展示和排序 */
  deletedAt: number
}

/** 读取全部台账（按删除时间倒序，最近删的在前） */
export async function listDeleted(): Promise<DeletedThread[]> {
  const raw = await storage.get<DeletedThread[]>(KEY, [])
  const arr = Array.isArray(raw) ? raw : []
  return arr.slice().sort((a, b) => b.deletedAt - a.deletedAt)
}

/** 已删除的 id 集合（渲染时用它把卡片从「会话列表」里过滤掉） */
export async function deletedIdSet(): Promise<Set<number>> {
  return new Set((await listDeleted()).map((d) => d.id))
}

/**
 * 记一条删除。
 *
 * 按 id 去重：同一条会话重复删（比如上次删失败、这次成功）不该在台账里出现两次。
 */
export async function recordDeleted(t: {
  id: number
  company: string
  jobTitle: string
}): Promise<void> {
  const cur = await listDeleted()
  const next = cur.filter((d) => d.id !== t.id)
  next.push({
    id: t.id,
    company: t.company,
    jobTitle: t.jobTitle,
    deletedAt: Date.now(),
  })
  await storage.set(KEY, next)
}

/**
 * 从台账里移除一条（「已删除」分类里的 🗑️）。
 *
 * 语义是「不再记着它」，不是「恢复会话」—— BOSS 那边已经真删了，无法恢复。
 * 移除后若该会话仍在后端列表里，它会重新出现在「会话列表」分类中。
 */
export async function forgetDeleted(id: number): Promise<void> {
  const cur = await listDeleted()
  await storage.set(
    KEY,
    cur.filter((d) => d.id !== id),
  )
}

/** 一键清空台账 */
export async function clearDeleted(): Promise<void> {
  await storage.set(KEY, [])
}
