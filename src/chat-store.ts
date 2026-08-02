// 会话本地存储 —— 记录低分判定的缓存
//
// 以「会话指纹」为键（公司 + 岗位归一化后哈希，不依赖 BOSS 内部 id），
// 把「后端判定此会话低分/无分」的结果按阈值缓存下来，让后续轮次在
// 切换会话之前就能跳过，省掉切换 + 后端往返。

import { storage } from './platform-bridge'
import { diag } from './logger'

const STORE_KEY = 'aah_chat_store'
/** 存储里最多保留多少个会话（超出按 lastSeenAt 淘汰最旧的） */
const MAX_THREADS = 200
/** 低分判定的有效期：过期后重新问一次后端（岗位可能被重新评分） */
const LOW_SCORE_TTL = 24 * 60 * 60 * 1000

export interface ThreadRecord {
  /** 会话指纹（公司 + 岗位归一化后哈希） */
  key: string
  /** 展示用，便于导出诊断时人工辨认 */
  label: string
  /** 上次见到该会话的时间 */
  lastSeenAt: number
  /** 后端判定的低分/无分跳过（时间戳，0 = 未判定过） */
  lowScoreAt: number
  /** 做出该低分判定时生效的阈值。用户把阈值调低到此值以下时判定失效 */
  lowScoreThreshold: number
}

type Store = Record<string, ThreadRecord>

/** 轻量字符串哈希（djb2）。不用于安全用途，只求短且碰撞率够低 */
function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/**
 * 归一化文本用于生成稳定指纹。
 *
 * 聊天页同一会话在不同时刻的文本可能有差异：被 CSS 截断、全角加号、
 * 带营销后缀。不归一化会导致同一会话每轮算出不同指纹。
 */
function norm(s: string): string {
  let t = (s || '').trim()
  for (const [a, b] of [['＋', '+'], ['／', '/'], ['（', '('], ['）', ')']]) {
    t = t.split(a).join(b)
  }
  t = t.replace(/[【\[(].*?[】\])]/g, '')       // 去营销文案
  t = t.replace(/[\s\-·、,，]+/g, '')            // 去分隔符
  t = t.replace(/[.．…]{2,}$/, '')               // 去截断省略号
  return t.toLowerCase()
}

/**
 * 生成会话指纹。
 *
 * 只用「公司 + 岗位」而不含 HR 姓名：同一岗位可能换 HR 对接，
 * 含姓名会让换人后被当成新会话。
 */
function threadKey(company: string, jobTitle: string): string {
  return hashStr(`${norm(company)}|${norm(jobTitle)}`)
}

async function load(): Promise<Store> {
  return (await storage.get<Store>(STORE_KEY, {})) || {}
}

async function save(store: Store): Promise<void> {
  // 超量淘汰：按 lastSeenAt 保留最近的 MAX_THREADS 个
  const keys = Object.keys(store)
  if (keys.length > MAX_THREADS) {
    const sorted = keys.sort((a, b) => (store[b].lastSeenAt || 0) - (store[a].lastSeenAt || 0))
    const next: Store = {}
    for (const k of sorted.slice(0, MAX_THREADS)) next[k] = store[k]
    store = next
  }
  await storage.set(STORE_KEY, store)
}

/** 取会话记录，不存在返回 null */
export async function getThread(company: string, jobTitle: string): Promise<ThreadRecord | null> {
  const store = await load()
  return store[threadKey(company, jobTitle)] || null
}

/**
 * 记录「后端判定此会话低分/无分，不必回复」。
 *
 * 不存在则新建记录：调用方同时用「列表项身份」和「头部身份」两个键各记一份，
 * 二者文本形态不同（列表项是「姓名+公司+职务」拼接），threadKey 算出来是两个键。
 */
export async function recordLowScore(
  company: string,
  jobTitle: string,
  threshold: number,
): Promise<void> {
  const store = await load()
  const key = threadKey(company, jobTitle)
  const rec: ThreadRecord = store[key] || {
    key,
    label: `${company} / ${jobTitle || '未知岗位'}`,
    lastSeenAt: Date.now(),
    lowScoreAt: 0,
    lowScoreThreshold: 0,
  }
  rec.lastSeenAt = Date.now()
  rec.lowScoreAt = Date.now()
  rec.lowScoreThreshold = threshold
  store[key] = rec
  await save(store)
}

/**
 * 该会话此前是否已被判定为低分，可直接跳过。
 *
 * 三个失效条件，任一命中就重新判定：
 *   1. 从未判定过；
 *   2. 判定已过期（岗位可能被重新评分）；
 *   3. 用户把阈值调低到当时判定值以下 —— 那时的「低于阈值」现在可能不低了。
 */
export function isKnownLowScore(rec: ThreadRecord, currentThreshold: number): boolean {
  if (!rec.lowScoreAt) return false
  if (Date.now() - rec.lowScoreAt > LOW_SCORE_TTL) return false
  if (currentThreshold < rec.lowScoreThreshold) return false
  return true
}

// ---------- 跨页「待打开会话」交接 ----------
//
// 在非聊天页点 HR 卡片要先跳到聊天页，而 location.href 跳转会销毁当前 JS 上下文，
// 只能把意图落盘，等聊天页重新加载、面板重新挂载后读取消费。

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

/** 清空（换账号或调试时用） */
export async function clearChatStore(): Promise<void> {
  await storage.set(STORE_KEY, {})
  diag('CHAT', '会话本地记录已清空')
}
