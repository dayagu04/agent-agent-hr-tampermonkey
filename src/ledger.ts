// 会话本地镜像（以前端页面 DOM 为源，后端只做富化）
//
// 「会话」Tab 的列表以 BOSS 页面 DOM 为真相源，本模块把页面状态沉淀到
// 本地镜像（GM 存储），让非聊天页也能渲染出与页面一致的列表；后端只提供
// 富化数据（内容摘要/时间/匹配分）与增量同步。
// 与 chat-store.ts 的分工：chat-store 管「每个会话处理到哪一步」，本模块
// 管「会话列表长什么样」——前者是行为状态，后者是视图真相。

import { storage } from './platform-bridge'
import type { HRMessageSummary, PluginConfig } from './types'
import { fetchHRMessages } from './api'

/** 本地镜像中的单条会话（= HRMessageSummary + 增量刷新锚点） */
export interface MirrorItem extends HRMessageSummary {
  lastMessageAt: string
}

const MIRROR_KEY = 'aah_mirror_conversations'
const JOB_CACHE_KEY = 'aah_job_cache'
/** 本地镜像最多保留条数（防存储无限膨胀） */
const MAX_MIRROR = 1000
/** 岗位缓存最多保留条数（按最近投递淘汰） */
const MAX_JOB_CACHE = 2000

// ---------- 本地存取 ----------

async function loadMirror(): Promise<MirrorItem[]> {
  const m = await storage.get<MirrorItem[]>(MIRROR_KEY, [])
  return Array.isArray(m) ? m : []
}

async function saveMirror(items: MirrorItem[]): Promise<void> {
  // 超量淘汰：只保留最近 MAX_MIRROR 条（按最后消息时间）
  if (items.length > MAX_MIRROR) {
    items = items.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_MIRROR)
  }
  await storage.set(MIRROR_KEY, items)
}

/** 岗位缓存：投递扫描到的岗位，供聊天页按 boss.encryptJobId 反查标题/薪资 */
export interface CachedJob {
  platformJobId: string
  title: string
  salary: string
  company: string
  cachedAt: number
}

async function loadJobCache(): Promise<Record<string, CachedJob>> {
  const c = await storage.get<Record<string, CachedJob>>(JOB_CACHE_KEY, {})
  return c && typeof c === 'object' ? c : {}
}

/**
 * 缓存本次扫描到的岗位。
 *
 * 聊天列表行组件的 boss 对象没有岗位名字段，但有 encryptJobId ——
 * 与投递扫描的岗位 URL id 一致，按它反查缓存即可拿到标题/薪资。
 */
export async function cacheScannedJobs(jobs: Array<{
  platformJobId: string
  title: string
  salary?: string
  company: string
}>): Promise<void> {
  if (!jobs.length) return
  const cache = await loadJobCache()
  const now = Date.now()
  for (const j of jobs) {
    if (!j.platformJobId) continue
    const prev = cache[j.platformJobId]
    cache[j.platformJobId] = {
      platformJobId: j.platformJobId,
      title: j.title || prev?.title || '',
      salary: j.salary || prev?.salary || '',
      company: j.company || prev?.company || '',
      cachedAt: now,
    }
  }
  // 容量控制：保留最近 MAX_JOB_CACHE 条（按 cachedAt 淘汰最旧）
  const entries = Object.values(cache).sort((a, b) => b.cachedAt - a.cachedAt)
  const next: Record<string, CachedJob> = {}
  for (const e of entries.slice(0, MAX_JOB_CACHE)) next[e.platformJobId] = e
  await storage.set(JOB_CACHE_KEY, next)
}

/** 按岗位 id 查缓存（boss 对象的 encryptJobId 与之对应） */
export async function lookupCachedJob(jobId: string): Promise<CachedJob | null> {
  if (!jobId) return null
  const cache = await loadJobCache()
  return cache[jobId] || null
}

// ---------- 本地镜像（会话 Tab 渲染 + 增量刷新） ----------

/** 取本地镜像，作为会话 Tab 的即时渲染数据 */
export async function renderableMirror(): Promise<HRMessageSummary[]> {
  const mirror = await loadMirror()
  return mirror.map(({ lastMessageAt: _lm, ...rest }) => rest)
}

/** 镜像中最近一条消息的时间（epoch 毫秒），作为增量刷新的 since */
function mirrorMaxLastMessageAt(mirror: MirrorItem[]): number {
  let max = 0
  for (const m of mirror) {
    const ts = Date.parse(m.lastMessageAt || '')
    if (!Number.isNaN(ts) && ts > max) max = ts
  }
  return max
}

/**
 * 增量刷新本地镜像（只富化，不新增、不删除）。
 *
 * 镜像的「有哪些会话」由页面 DOM 决定，后端 /api/conversations/list 只用来
 * 给镜像里已有的会话补内容摘要/时间/分数；后端独有（BOSS 已删 / 未同步）
 * 的会话绝不进镜像，保证投递页与会话页列表一致。
 * 只拉 since 之后有变化的会话；返回 null = 请求失败（保留旧数据）。
 */
export async function refreshMirror(cfg: PluginConfig, limit = 50): Promise<MirrorItem[] | null> {
  const mirror = await loadMirror()
  const since = mirrorMaxLastMessageAt(mirror)
  const list = await fetchHRMessages(cfg, limit, since || undefined)
  if (list === null) return null
  const byId = new Map<number, MirrorItem>()
  for (const m of mirror) byId.set(m.id, m)
  for (const f of list) {
    const cur = byId.get(f.id)
    if (cur) {
      byId.set(f.id, {
        ...cur,
        ...f,
        lastMessageAt: f.lastMessageAt || cur.lastMessageAt,
      })
    }
  }
  const next = Array.from(byId.values()).sort((a, b) => b.timestamp - a.timestamp)
  await saveMirror(next)
  return next
}

/** 刷新并把渲染数据一起取出（App.vue 用，一次调用完成「拉取 + 过滤」） */
export async function refreshChatList(
  cfg: PluginConfig,
  limit = 50,
): Promise<{ list: HRMessageSummary[]; failed: boolean }> {
  const next = await refreshMirror(cfg, limit)
  if (next === null) {
    return { list: await renderableMirror(), failed: true }
  }
  const list = next.map(({ lastMessageAt: _lm, ...rest }) => rest)
  return { list, failed: false }
}

/** 同键归一化：公司|岗位 */
function mirrorKey(company: string, jobTitle: string): string {
  return `${(company || '').trim()}|${(jobTitle || '').trim()}`
}

/**
 * 以 BOSS 页面 DOM 为源收敛本地镜像（页面为准）。
 *
 * 镜像的会话集合 = 当前页面 DOM 集合：页面没有的（BOSS 已删）从镜像移除，
 * 页面有、后端还没有的（未同步）以稳定负 id 落库，保证投递页 / 会话页
 * 看到同一份列表。
 */
export async function upsertMirrorFromDom(items: HRMessageSummary[]): Promise<void> {
  const mirror = await loadMirror()
  const byKey = new Map(mirror.map((m) => [mirrorKey(m.company, m.jobTitle), m]))
  const next: MirrorItem[] = []
  const seen = new Set<string>()
  for (const it of items) {
    const k = mirrorKey(it.company, it.jobTitle)
    if (seen.has(k)) continue
    seen.add(k)
    const existing = byKey.get(k)
    next.push({
      ...it,
      lastMessageAt: existing?.lastMessageAt || '',
    })
  }
  await saveMirror(next.sort((a, b) => b.timestamp - a.timestamp))
}

/** 从本地镜像移除指定会话（聊天页删除后调用，避免镜像残留死条目） */
export async function removeMirrorByKey(company: string, jobTitle: string): Promise<void> {
  const mirror = await loadMirror()
  const key = mirrorKey(company, jobTitle)
  const next = mirror.filter((m) => mirrorKey(m.company, m.jobTitle) !== key)
  if (next.length !== mirror.length) await saveMirror(next)
}

/**
 * 打开会话后从头部回填岗位名/薪资。
 *
 * 聊天列表项里没有岗位名元素，岗位名/薪资只在打开的会话头部
 * span.position-name / span.salary 里；打开后写回镜像对应条目。
 */
export async function updateMirrorJobTitle(
  id: number,
  jobTitle: string,
  salary?: string,
): Promise<void> {
  const mirror = await loadMirror()
  const it = mirror.find((m) => m.id === id)
  if (!it) return
  if (jobTitle && it.jobTitle !== jobTitle) it.jobTitle = jobTitle
  if (salary && it.salary !== salary) it.salary = salary
  await saveMirror(mirror)
}

/**
 * 用聊天页行组件/岗位缓存拿到的干净身份更新镜像（HR名/公司/岗位名/薪资），
 * 只填空缺。匹配按公司名模糊（DOM 公司串含角色后缀，如「合肥灵光元启科技总经理」）。
 */
export async function updateMirrorChatIdentity(
  domCompany: string,
  data: { hrName?: string; company?: string; jobTitle?: string; salary?: string },
): Promise<void> {
  if (!domCompany) return
  const mirror = await loadMirror()
  let changed = false
  for (const m of mirror) {
    const same =
      m.company === domCompany ||
      domCompany.includes(m.company) ||
      m.company.includes(domCompany)
    if (!same) continue
    if (data.hrName && !m.hrName) {
      m.hrName = data.hrName
      changed = true
    }
    if (
      data.company &&
      m.company !== data.company &&
      (m.company.includes(data.company) || data.company.includes(m.company))
    ) {
      m.company = data.company
      changed = true
    }
    if (data.jobTitle && !m.jobTitle) {
      m.jobTitle = data.jobTitle
      changed = true
    }
    if (data.salary && !m.salary) {
      m.salary = data.salary
      changed = true
    }
  }
  if (changed) await saveMirror(mirror)
}

/** 托管轮次中，某个会话 sync 成功后用它读到的消息更新镜像（列表即时反映） */
export async function upsertMirrorFromSync(payload: {
  conversation_id: number
  company: string
  jobTitle: string
  salary?: string
  messages: Array<{ sender: string; content: string }>
}): Promise<void> {
  const mirror = await loadMirror()
  const byId = new Map<number, MirrorItem>()
  for (const m of mirror) byId.set(m.id, m)

  const existing = byId.get(payload.conversation_id)
  const hrMsgs = payload.messages.filter((m) => m.sender !== 'me' && m.sender !== 'candidate')
  const lastHr = hrMsgs[hrMsgs.length - 1]
  byId.set(payload.conversation_id, {
    id: payload.conversation_id,
    company: payload.company,
    jobTitle: payload.jobTitle,
    salary: payload.salary || existing?.salary,
    content: lastHr ? lastHr.content.slice(0, 200) : existing?.content || '',
    timestamp: existing?.timestamp || Date.now(),
    // 本轮托管已处理该会话，未读降为 false
    unread: false,
    // 同步结果里没有匹配分，沿用镜像里已有的（首见时为 null = 无从判断）
    matchScore: existing?.matchScore ?? null,
    lastMessageAt: existing?.lastMessageAt || '',
  })
  await saveMirror(Array.from(byId.values()).sort((a, b) => b.timestamp - a.timestamp))
}
