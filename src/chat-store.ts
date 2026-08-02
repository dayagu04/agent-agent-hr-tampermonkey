// 会话本地存储 —— 记录「这个会话我处理到哪了、发过什么」
//
// 为什么需要（2026-07-31 实测暴露）：
// 此前每轮托管都把整个会话的全部消息重传后端，插件侧完全不知道自己发过什么。
// 后果：
//   1. 后端若返回回复，同一句话会被反复发给同一个 HR（发出不可撤回）；
//   2. 无法判断「HR 有没有新消息」，每个会话每轮都要走一次 LLM，白烧 token；
//   3. 后端 404（找不到投递记录）时无从记录，下轮又完整重试一遍。
//
// 设计要点：
// - 以「会话指纹」为键，不依赖 BOSS 的内部 id（改版即失效）。
// - 只存指纹与计数，不存消息原文：聊天内容含个人信息，留在本地存储属额外泄露面。
// - 记 lastSyncFailedAt，让失败会话降频重试而不是每轮硬撞。

import { storage } from './platform-bridge'
import { diag } from './logger'

const STORE_KEY = 'aah_chat_store'
/** 单会话记录最多保留多少条已发消息哈希（防存储无限膨胀） */
const MAX_SENT_HASHES = 20
/** 存储里最多保留多少个会话（超出按 lastSeenAt 淘汰最旧的） */
const MAX_THREADS = 200
/** 同步失败后的冷却时间：失败会话在此期间内不再重试 */
const FAILED_COOLDOWN_MS = 30 * 60 * 1000

export interface ThreadRecord {
  /** 会话指纹（HR 名 + 公司 + 岗位归一化后哈希） */
  key: string
  /** 展示用，便于导出诊断时人工辨认 */
  label: string
  /** 上次见到该会话的时间 */
  lastSeenAt: number
  /** 上次成功同步后端的时间（0 = 从未成功） */
  lastSyncedAt: number
  /** 上次同步失败的时间（用于冷却降频） */
  lastSyncFailedAt: number
  /** 连续失败次数 */
  failCount: number
  /** 已发送消息内容的哈希列表（防重复发同一句） */
  sentHashes: string[]
  /** 上次同步时该会话的消息条数（用于判断是否有新消息） */
  lastMessageCount: number
  /** 上次读到的最后一条消息哈希（比条数更可靠，条数可能因滚动加载变化） */
  lastMessageHash: string
  /**
   * 后端判定的低分/无分跳过（时间戳，0 = 未判定过）。
   *
   * 存在理由（2026-08-01 实测）：一轮托管里 30+ 个垃圾会话每个都要
   * 「切换会话(约1s) → 读消息 → 问后端 → 收到"匹配分 0.0 < 阈值 50"」，
   * 下一轮又原样重来。既慢又把日志刷成 30 行同样的跳过记录，用户观感是
   * 「怎么一直在重复遍历」。判定结果按会话缓存下来，后续轮次直接跳过。
   *
   * 用时间戳而非布尔：阈值是可配的，用户调低阈值后旧判定就该失效
   * （见 lowScoreThreshold）；同时给一个过期时间，防止岗位重新评分后
   * 永久被挡在外面。
   */
  lowScoreAt: number
  /** 做出该低分判定时生效的阈值。用户把阈值调低到此值以下时判定失效。 */
  lowScoreThreshold: number
}

type Store = Record<string, ThreadRecord>

/** 轻量字符串哈希（djb2）。不用于安全用途，只求短且碰撞率够低 */
export function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/**
 * 归一化文本用于生成稳定指纹。
 *
 * 聊天页同一会话在不同时刻的文本可能有差异：被 CSS 截断成 "盘锦市兴隆台区得..."、
 * 全角加号 "C＋＋"、带营销后缀 "【12K起+独立loft】"。不归一化会导致同一会话
 * 每轮算出不同指纹，去重完全失效。
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
 * 注意只用「公司 + 岗位」而不含 HR 姓名：同一岗位可能换 HR 对接，
 * 含姓名会让换人后被当成新会话、招呼语重发一遍。
 */
export function threadKey(company: string, jobTitle: string): string {
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

/** 记录「见到了这个会话」，返回其记录（不存在则新建） */
export async function touchThread(
  company: string,
  jobTitle: string,
  label: string,
): Promise<ThreadRecord> {
  const store = await load()
  const key = threadKey(company, jobTitle)
  const rec: ThreadRecord = store[key] || {
    key,
    label,
    lastSeenAt: 0,
    lastSyncedAt: 0,
    lastSyncFailedAt: 0,
    failCount: 0,
    sentHashes: [],
    lastMessageCount: 0,
    lastMessageHash: '',
    lowScoreAt: 0,
    lowScoreThreshold: 0,
  }
  rec.lastSeenAt = Date.now()
  rec.label = label || rec.label
  store[key] = rec
  await save(store)
  return rec
}

/**
 * 判断该会话本轮是否值得处理。
 *
 * 返回 skip 理由，null 表示应当处理。
 */
export function shouldSkipThread(
  rec: ThreadRecord,
  messages: Array<{ sender: string; content: string }>,
  hasUnread: boolean,
): string | null {
  // 未读标记优先：BOSS 明确标了未读就一定处理，不被下面的启发式挡掉
  if (hasUnread) return null

  // 失败冷却：连续失败的会话降频重试，避免每轮都撞同一个 404
  if (rec.failCount > 0 && rec.lastSyncFailedAt) {
    const since = Date.now() - rec.lastSyncFailedAt
    // 退避：失败越多等越久，上限 FAILED_COOLDOWN_MS
    const wait = Math.min(FAILED_COOLDOWN_MS, 60_000 * Math.pow(2, rec.failCount - 1))
    if (since < wait) {
      return `同步失败冷却中（${rec.failCount} 次失败，剩 ${Math.ceil((wait - since) / 60000)} 分钟）`
    }
  }

  if (!messages.length) return null

  const last = messages[messages.length - 1]

  // 最后一条是自己发的 → 球在对方，没必要再喊一次
  if (last.sender === 'me') return '最后一条是我方消息，等待 HR 回复'

  // 内容指纹未变 → 没有新消息
  const curHash = hashStr(messages.map((m) => `${m.sender}:${m.content}`).join('\n'))
  if (rec.lastMessageHash && curHash === rec.lastMessageHash) {
    return '无新消息（内容指纹未变）'
  }

  return null
}

/** 该内容是否已经发过（防重复发同一句给同一个 HR） */
export function alreadySent(rec: ThreadRecord, content: string): boolean {
  return rec.sentHashes.includes(hashStr(norm(content)))
}

/**
 * 交互卡片是否已处理过。
 *
 * 与 alreadySent 共用 sentHashes，用 `card:` 前缀区分。
 * 必要性：BOSS 的卡片答完后按钮仍留在消息流里可点，仅靠 DOM 几何判重
 * 会在「DOM 尚未刷新」的窗口期漏判 —— 实测导致同一份简历发了 3 次。
 */
export function cardHandled(rec: ThreadRecord, kind: string, question: string): boolean {
  return rec.sentHashes.includes(cardHash(kind, question))
}

/** 卡片键的哈希算法，供写入与判重共用（两处必须一致，否则判重永远失手） */
function cardHash(kind: string, question: string): string {
  return hashStr(`card:${kind}:${question}`.replace(/\s+/g, ''))
}

/** 记录一次卡片处理 */
export async function recordCardHandled(
  company: string,
  jobTitle: string,
  kind: string,
  question: string,
): Promise<void> {
  await recordSent(company, jobTitle, `card:${kind}:${question}`, true)
}

/** 记录一次成功发送 */
export async function recordSent(
  company: string,
  jobTitle: string,
  content: string,
  raw = false,
): Promise<void> {
  const store = await load()
  const key = threadKey(company, jobTitle)
  const rec = store[key]
  if (!rec) return
  // raw=true 时不再归一化：卡片键形如 `card:kind:question`，
  // norm() 会剥掉 `（）` 等结构字符，导致与 cardHandled 的算法不一致
  const h = raw ? hashStr(content.replace(/\s+/g, '')) : hashStr(norm(content))
  if (!rec.sentHashes.includes(h)) {
    rec.sentHashes.push(h)
    if (rec.sentHashes.length > MAX_SENT_HASHES) {
      rec.sentHashes = rec.sentHashes.slice(-MAX_SENT_HASHES)
    }
  }
  store[key] = rec
  await save(store)
}

/** 记录一次同步结果（成功清零失败计数，失败则累加用于退避） */
export async function recordSync(
  company: string,
  jobTitle: string,
  ok: boolean,
  messages: Array<{ sender: string; content: string }>,
): Promise<void> {
  const store = await load()
  const key = threadKey(company, jobTitle)
  const rec = store[key]
  if (!rec) return
  if (ok) {
    rec.lastSyncedAt = Date.now()
    rec.failCount = 0
    rec.lastSyncFailedAt = 0
    rec.lastMessageCount = messages.length
    rec.lastMessageHash = hashStr(messages.map((m) => `${m.sender}:${m.content}`).join('\n'))
  } else {
    rec.lastSyncFailedAt = Date.now()
    rec.failCount++
  }
  store[key] = rec
  await save(store)
}

/** 低分判定的有效期：过期后重新问一次后端（岗位可能被重新评分） */
const LOW_SCORE_TTL = 24 * 60 * 60 * 1000

/**
 * 记录「后端判定此会话低分/无分，不必回复」。
 *
 * 不存在则新建记录（与 recordSync 等函数不同）：调用方需要同时用
 * **列表项身份**和**头部身份**两个键各记一份。原因是二者文本形态不同 ——
 * 列表项是「姓名+公司+职务」拼接（如"洪女士安度星火招聘者"），头部是独立的
 * 公司名+岗位名，threadKey() 算出来是两个不同的键。而下一轮要在「切换会话之前」
 * 就跳过它，那时只有列表项身份可用（头部信息得切过去才读得到）。
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
    lastSyncedAt: 0,
    lastSyncFailedAt: 0,
    failCount: 0,
    sentHashes: [],
    lastMessageCount: 0,
    lastMessageHash: '',
    lowScoreAt: 0,
    lowScoreThreshold: 0,
  }
  rec.lowScoreAt = Date.now()
  rec.lowScoreThreshold = threshold
  store[key] = rec
  await save(store)
}

/**
 * 该会话此前是否已被判定为低分，可直接跳过（省掉切换 + 后端往返）。
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

/** 导出全部记录（供诊断面板查看） */
export async function dumpChatStore(): Promise<ThreadRecord[]> {
  const store = await load()
  return Object.values(store).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}

// ---------- 跨页「待打开会话」交接 ----------
//
// 为什么需要落盘：在搜索页点 HR 卡片要先跳到聊天页，而
// `window.location.href = ...` 之后本次 JS 上下文即销毁，跳转语句后面的
// 代码根本不会执行（所以 `await waitForChatPage()` 这种写法在同一次执行里
// 是拿不到结果的）。只能把意图存起来，等聊天页重新加载、面板重新挂载后读取。
// 这与 orchestrator 跨页续跑用 STATE_KEY 的思路一致。

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

/**
 * 取出并清除待打开会话（一次性消费）。
 * 无论有效与否都清，避免过期交接单残留、下次进聊天页又弹一次。
 */
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
