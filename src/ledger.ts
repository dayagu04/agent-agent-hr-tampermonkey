// 会话本地镜像 + 已删除台账（本地优先 + 托管前对账）
//
// 背景（2026-08-02 对齐）：插件「会话」Tab 的列表此前直接轮询后端
// /api/conversations/list（30s 一次）。用户在 BOSS 手动删除的会话后端无感知，
// 死条目永远挂在列表里——点不进去、删不掉。
//
// 本模块承担三件事：
// 1. 本地镜像：会话摘要存本地，渲染零等待；服务器只做低频增量同步（since 参数）。
// 2. 已删除台账（本地 + 服务端）：托管开始前扫 BOSS 列表与后端清单对账，
//    连续 N 轮「后端有、BOSS 无」的会话自动进台账，从列表消失并上报后端。
// 3. 误报防线：列表未加载完全不判删；对账失败不判删；重新出现的会话自动恢复。
//
// 与 chat-store.ts 的分工：chat-store 管「每个会话处理到哪一步」（去重/冷却），
// 本模块管「会话列表长什么样、哪些已删除」——前者是行为状态，后者是视图真相。

import { storage } from './platform-bridge'
import { diag } from './logger'
import type { HRMessageSummary, ManifestItem, PluginConfig } from './types'
import {
  fetchChatManifest,
  fetchHRMessages,
  reportDeletedConversations,
  reportRestoredConversation,
} from './api'

/** 本地镜像中的单条会话（= HRMessageSummary + 增量刷新锚点） */
export interface MirrorItem extends HRMessageSummary {
  lastMessageAt: string
}

/** 已删除台账（本地侧） */
export interface DeletedRecord {
  conversationId: number
  company: string
  jobTitle: string
  detectedAt: number
  /** 是否已成功上报后端（网络失败时保留 false，下轮补报） */
  reported: boolean
}

/** 消失跟踪：连续几轮不在 BOSS 列表里 */
interface MissingTrack {
  firstMissingAt: number
  missCount: number
}

const MIRROR_KEY = 'aah_mirror_conversations'
const DELETED_KEY = 'aah_deleted_ledger'
const MISSING_KEY = 'aah_missing_track'
const MANIFEST_KEY = 'aah_manifest_cache'

/** 清单缓存有效期：托管轮次通常几分钟一轮，5 分钟内不重复拉服务器 */
const MANIFEST_TTL_MS = 5 * 60 * 1000
/** 连续几轮「后端有、BOSS 无」才判定删除（防懒加载/抖动误报） */
const MISS_REQUIRED = 2
/** 本地镜像最多保留条数（防存储无限膨胀；覆盖会话 Tab「有多少显示多少」的需求） */
const MAX_MIRROR = 1000

interface ManifestCache {
  fetchedAt: number
  items: ManifestItem[]
}

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

async function loadDeleted(): Promise<Record<number, DeletedRecord>> {
  const d = await storage.get<Record<number, DeletedRecord>>(DELETED_KEY, {})
  return d && typeof d === 'object' ? d : {}
}

async function saveDeleted(deleted: Record<number, DeletedRecord>): Promise<void> {
  await storage.set(DELETED_KEY, deleted)
}

async function loadMissing(): Promise<Record<number, MissingTrack>> {
  const m = await storage.get<Record<number, MissingTrack>>(MISSING_KEY, {})
  return m && typeof m === 'object' ? m : {}
}

async function saveMissing(missing: Record<number, MissingTrack>): Promise<void> {
  await storage.set(MISSING_KEY, missing)
}

// ---------- 公司名匹配（BOSS 列表 vs 后端清单） ----------

/**
 * 公司名模糊命中。
 *
 * BOSS 列表项常把「姓名+公司+职务」拼成一串（如 "张琪梅图迅电子人事"）且可能
 * 截断，后端清单是干净的独立公司名。判据：归一化后相等/互为子串，或前 6 字
 * 双向前缀一致（任一侧被截断都能命中）。宁可多命中（漏判删除）也不误报。
 */
function companyHit(bossCompany: string, serverCompany: string): boolean {
  const norm = (s: string) => (s || '').replace(/\s+/g, '').toLowerCase()
  const a = norm(bossCompany)
  const b = norm(serverCompany)
  if (!a || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  const k = Math.min(6, a.length, b.length)
  return k >= 3 && a.slice(0, k) === b.slice(0, k)
}

// ---------- 清单（带本地缓存） ----------

async function getManifest(cfg: PluginConfig): Promise<ManifestItem[] | null> {
  const cached = await storage.get<ManifestCache | null>(MANIFEST_KEY, null)
  if (cached && Array.isArray(cached.items) && Date.now() - cached.fetchedAt < MANIFEST_TTL_MS) {
    return cached.items
  }
  const items = await fetchChatManifest(cfg)
  if (items === null) {
    // 拉取失败：退回旧缓存（BOSS 侧仍在场校验兜底，不会因清单过期误删）
    return cached && Array.isArray(cached.items) ? cached.items : null
  }
  await storage.set(MANIFEST_KEY, { fetchedAt: Date.now(), items })
  return items
}

// ---------- 删除对账（托管开始前调用） ----------

export interface DeletionSyncResult {
  /** 本轮新进台账（且已上报后端）的会话数 */
  detected: number
  /** 本轮恢复的会话数 */
  restored: number
  /** 后端清单条数（0 = 无数据可对账） */
  manifestCount: number
}

/**
 * 对账：后端清单 vs BOSS 列表。
 *
 * @param bossThreads 当前 BOSS 会话列表（建议在列表滚动加载完全后传入）
 * @param listFullyLoaded 列表是否已确认加载完全。false 时只处理「重新出现」，
 *   不累计「消失」计数——懒加载没扫全时不判删，宁可晚一轮也不误报。
 */
export async function syncDeletions(
  cfg: PluginConfig,
  bossThreads: Array<{ company: string; jobTitle: string }>,
  listFullyLoaded: boolean,
): Promise<DeletionSyncResult> {
  const items = await getManifest(cfg)
  if (!items || !items.length) {
    return { detected: 0, restored: 0, manifestCount: items?.length || 0 }
  }

  const missing = await loadMissing()
  const deleted = await loadDeleted()
  const now = Date.now()
  const presentCompanies = bossThreads.map((t) => t.company).filter(Boolean)

  const toReport: number[] = []
  const toRestore: number[] = []

  for (const item of items) {
    const convId = item.conversation_id
    const present = presentCompanies.some((c) => companyHit(c, item.company))

    if (present) {
      // 重新出现：清掉消失计数；若已在台账则走恢复
      if (missing[convId]) delete missing[convId]
      if (deleted[convId]) toRestore.push(convId)
    } else if (listFullyLoaded) {
      // 后端有、BOSS 无：累计消失轮次，达到阈值才进台账
      const m = missing[convId] || { firstMissingAt: now, missCount: 0 }
      m.missCount++
      missing[convId] = m
      if (m.missCount >= MISS_REQUIRED && !deleted[convId]) {
        deleted[convId] = {
          conversationId: convId,
          company: item.company,
          jobTitle: item.job_title,
          detectedAt: now,
          reported: false,
        }
        toReport.push(convId)
      }
    }
  }

  // 补报：上轮网络失败未上报成功的，本轮再试
  for (const rec of Object.values(deleted)) {
    if (!rec.reported && !toReport.includes(rec.conversationId)) {
      toReport.push(rec.conversationId)
    }
  }

  let detected = 0
  if (toReport.length) {
    const res = await reportDeletedConversations(
      cfg,
      toReport.map((id) => ({
        conversation_id: id,
        detected_at: deleted[id]?.detectedAt || now,
      })),
    )
    if (res) {
      for (const id of toReport) {
        if (deleted[id]) {
          deleted[id].reported = true
          detected++
        }
      }
    } else {
      diag('LEDGER', `删除台账上报失败（${toReport.length} 条，下轮重试）`)
    }
  }

  let restored = 0
  if (toRestore.length) {
    const res = await reportRestoredConversation(cfg, toRestore)
    for (const id of toRestore) {
      if (res) {
        delete deleted[id]
        delete missing[id]
        restored++
      }
    }
  }

  await saveMissing(missing)
  await saveDeleted(deleted)

  if (detected || restored) {
    diag(
      'LEDGER',
      `对账完成：清单 ${items.length} 条，新删 ${detected}，恢复 ${restored}，列表完整=${listFullyLoaded}`,
    )
  }
  return { detected, restored, manifestCount: items.length }
}

// ---------- 手动兜底标记（点击死条目后） ----------

/** 用户点击「会话列表里没找到」的卡片时手动标记（自动对账的兜底） */
export async function markDeletedManually(cfg: PluginConfig, summary: HRMessageSummary): Promise<void> {
  const deleted = await loadDeleted()
  if (deleted[summary.id]) return
  deleted[summary.id] = {
    conversationId: summary.id,
    company: summary.company,
    jobTitle: summary.jobTitle,
    detectedAt: Date.now(),
    reported: false,
  }
  await saveDeleted(deleted)

  const res = await reportDeletedConversations(cfg, [
    {
      conversation_id: summary.id,
      detected_at: deleted[summary.id].detectedAt,
      source: 'manual_click',
    },
  ])
  if (res) {
    deleted[summary.id].reported = true
    await saveDeleted(deleted)
  }
  diag('LEDGER', `手动标记已删除: ${summary.company} / ${summary.jobTitle}（上报${res ? '成功' : '失败，稍后补报'}）`)
}

// ---------- 本地镜像（会话 Tab 渲染 + 增量刷新） ----------

/** 取「未被标记删除」的镜像，作为会话 Tab 的即时渲染数据 */
export async function renderableMirror(): Promise<HRMessageSummary[]> {
  const deleted = await loadDeleted()
  const mirror = await loadMirror()
  return mirror
    .filter((m) => !deleted[m.id])
    .map(({ lastMessageAt: _lm, ...rest }) => rest)
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

function mergeMirror(mirror: MirrorItem[], fresh: HRMessageSummary[]): MirrorItem[] {
  const byId = new Map<number, MirrorItem>()
  for (const m of mirror) byId.set(m.id, m)
  for (const f of fresh) {
    byId.set(f.id, {
      ...f,
      lastMessageAt: f.lastMessageAt || '',
    })
  }
  return Array.from(byId.values()).sort((a, b) => b.timestamp - a.timestamp)
}

/**
 * 增量刷新本地镜像。
 *
 * 只拉 `since`（本地最近消息时间）之后有变化的会话，没变化时后端返回空数组，
 * 网络/DB 开销几乎为零。返回 null = 请求失败（保留旧数据，调用方提示稍后重试）。
 */
export async function refreshMirror(cfg: PluginConfig, limit = 50): Promise<MirrorItem[] | null> {
  const mirror = await loadMirror()
  const since = mirrorMaxLastMessageAt(mirror)
  const list = await fetchHRMessages(cfg, limit, since || undefined)
  if (list === null) return null
  const next = mergeMirror(mirror, list)
  await saveMirror(next)
  return next
}

/**
 * 刷新并把渲染数据一起取出（App.vue 用，一次调用完成「拉取 + 过滤」）。
 *
 * failed=true 表示网络失败：此时返回本地镜像渲染（仍即时），由 UI 提示稍后重试。
 */
export async function refreshChatList(
  cfg: PluginConfig,
  limit = 50,
): Promise<{ list: HRMessageSummary[]; failed: boolean }> {
  const next = await refreshMirror(cfg, limit)
  if (next === null) {
    return { list: await renderableMirror(), failed: true }
  }
  const deleted = await loadDeleted()
  const list = next
    .filter((m) => !deleted[m.id])
    .map(({ lastMessageAt: _lm, ...rest }) => rest)
  return { list, failed: false }
}

/** 已删除台账（按检测时间倒序），供「已删除」分类展示 */
export async function listDeletedRecords(): Promise<DeletedRecord[]> {
  return Object.values(await loadDeleted()).sort((a, b) => b.detectedAt - a.detectedAt)
}

/**
 * 从台账恢复（误报或用户手动移出）：上报后端回滚 + 清掉本地记录。
 *
 * @returns false = 后端请求失败（保留本地记录，下轮/下次再试）
 */
export async function restoreDeleted(cfg: PluginConfig, conversationIds: number[]): Promise<boolean> {
  if (!conversationIds.length) return true
  const res = await reportRestoredConversation(cfg, conversationIds)
  if (!res) return false
  const deleted = await loadDeleted()
  const missing = await loadMissing()
  for (const id of conversationIds) {
    delete deleted[id]
    delete missing[id]
  }
  await saveDeleted(deleted)
  await saveMissing(missing)
  return true
}

/** 托管轮次中，某个会话 sync 成功后用它读到的消息更新镜像（列表即时反映已处理状态） */
export async function upsertMirrorFromSync(payload: {
  conversation_id: number
  company: string
  jobTitle: string
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
