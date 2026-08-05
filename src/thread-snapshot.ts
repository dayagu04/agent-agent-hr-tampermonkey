// 会话行全量采集（评估用）——把 BOSS 聊天页会话列表的 DOM 结构与状态标签
// （送达/已读/未读/其他）原样记录并上报，供评估这些数据能否用于回复策略
// （如「我方消息已读但 HR 长时间未回 → 判定流程结束」）。
//
// 与 boss-chat.ts 的分工：这里只做「读 + 上报」，不做任何点击/删除动作。

import type { PluginConfig } from './types'
import { diag } from './logger'
import { reportThreadSnapshot } from './api'

const THREAD_SELECTORS = [
  '.geek-item',
  '.user-list li',
  '[class*="chat-user-item"]',
  'li[role="listitem"]',
]

interface LeafTextNode {
  text: string
  tag: string
  cls: string
  title?: string
  ariaLabel?: string
}

export interface ThreadRowSnapshot {
  key: string
  name: string
  company: string
  jobTitle: string
  unread: boolean
  timeText: string
  lastMsgPreview: string
  /** 行内所有短文本叶子节点（含 class/attr），用于盘点「送达/已读」等标签的载体 */
  leafTexts: LeafTextNode[]
  rowText: string
  dom: {
    tag: string
    cls: string[]
    attrs: Record<string, string>
    children: Array<{ tag: string; cls: string[]; text: string }>
  }
}

function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 4 && r.height > 4
}

function leafTextsOf(row: HTMLElement): LeafTextNode[] {
  const out: LeafTextNode[] = []
  for (const el of Array.from(row.querySelectorAll<HTMLElement>('*'))) {
    if (el.querySelector('*')) continue // 只收叶子
    const t = (el.textContent || '').trim()
    if (!t || t.length > 12) continue
    const cls = String(el.className || '').trim()
    out.push({
      text: t,
      tag: el.tagName.toLowerCase(),
      cls,
      title: el.getAttribute('title') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
    })
  }
  return out.slice(0, 40)
}

function domDigest(row: HTMLElement): ThreadRowSnapshot['dom'] {
  const keyAttrs = ['data-id', 'data-uid', 'data-conversation-id', 'data-geek-id', 'data-boss-id',
    'data-user-id', 'role', 'aria-label', 'title']
  const attrs: Record<string, string> = {}
  for (const k of keyAttrs) {
    const v = row.getAttribute(k)
    if (v) attrs[k] = v.slice(0, 80)
  }
  const children = Array.from(row.children).slice(0, 12).map((c) => {
    const el = c as HTMLElement
    return {
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 6),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    }
  })
  return {
    tag: row.tagName.toLowerCase(),
    cls: String(row.className || '').split(/\s+/).filter(Boolean),
    attrs,
    children,
  }
}

function readRow(row: HTMLElement): ThreadRowSnapshot | null {
  const name = (row.querySelector('.name-text')?.textContent || '').trim()
  let company = (row.querySelector('.name-box')?.textContent || '').trim()
  if (name && company.startsWith(name)) company = company.slice(name.length).trim()
  const jobTitle = (row.querySelector('[class*="job"], .source-job')?.textContent || '').trim()
  const unread = !!row.querySelector('.badge-count, [class*="badge"], [class*="unread"]')
  const timeText = (row.querySelector('span.time, .time')?.textContent || '').trim()
  const lastMsgPreview = (row.querySelector('.last-msg, .gray.last-msg, .friend-content, .text')?.textContent || '')
    .replace(/\s+/g, ' ').trim().slice(0, 60)
  const key = `${name}|${company}|${jobTitle}`
  if (!name && !company && !jobTitle) return null

  const rowText = (row.textContent || '').replace(/\s+/g, ' ').trim()
  const leaves = leafTextsOf(row)
  return {
    key,
    name,
    company: company || name,
    jobTitle,
    unread,
    timeText,
    lastMsgPreview,
    leafTexts: leaves,
    rowText: rowText.slice(0, 200),
    dom: domDigest(row),
  }
}

/** 找到会话列表的可滚动容器（与 boss-chat 同策略：实际可滚动的祖先）。 */
function findScrollContainer(): HTMLElement | null {
  const first = document.querySelector<HTMLElement>(THREAD_SELECTORS.join(','))
  if (!first) return null
  let cur: HTMLElement | null = first.parentElement
  let fallback: HTMLElement | null = null
  for (let i = 0; i < 10 && cur; i++) {
    const st = getComputedStyle(cur)
    if (cur.scrollHeight > cur.clientHeight + 4 && /auto|scroll|overlay/.test(st.overflowY)) return cur
    if (cur.scrollHeight > cur.clientHeight + 4 && !fallback) fallback = cur
    cur = cur.parentElement
  }
  return fallback
}

/**
 * 采集当前聊天页的会话行全量快照（滚动遍历，最多 MAX_ROWS 行）。
 * 返回行数；调用方负责上报。
 */
export async function collectThreadSnapshot(): Promise<ThreadRowSnapshot[]> {
  const out: ThreadRowSnapshot[] = []
  const seen = new Set<string>()
  const MAX_ROWS = 200
  const MAX_SCREENS = 80

  const container = findScrollContainer()
  if (container) {
    container.scrollTo({ top: 0 })
    await new Promise((r) => setTimeout(r, 500))
  }

  for (let screen = 0; screen < MAX_SCREENS && out.length < MAX_ROWS; screen++) {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(THREAD_SELECTORS.join(',')))
      .filter((el) => visible(el))
    for (const row of rows) {
      const item = readRow(row)
      if (!item || seen.has(item.key)) continue
      seen.add(item.key)
      out.push(item)
    }
    if (!container) break
    const maxScroll = container.scrollHeight - container.clientHeight
    if (container.scrollTop >= maxScroll) break
    container.scrollTop = Math.min(maxScroll, container.scrollTop + Math.max(400, container.clientHeight * 0.8))
    await new Promise((r) => setTimeout(r, 500))
  }
  diag('SNAP', `会话快照采集完成：${out.length} 行`)
  return out
}

/** 采集并上报全量会话快照（幂等节流：同一 run + url 60s 内只报一次）。 */
const _lastReport: Record<string, number> = {}

export async function reportThreadSnapshotOnce(
  cfg: PluginConfig,
  opts: { runId?: string; reason: string },
): Promise<number> {
  if (!/\/web\/geek\/chat/.test(location.pathname)) return 0
  const throttleKey = `${opts.runId || 'manual'}|${location.href}`
  const now = Date.now()
  if (now - (_lastReport[throttleKey] || 0) < 60_000) return 0
  _lastReport[throttleKey] = now

  const rows = await collectThreadSnapshot()
  if (!rows.length) return 0
  try {
    await reportThreadSnapshot(cfg, {
      run_id: opts.runId || '',
      url: location.href,
      reason: opts.reason,
      captured_at: new Date().toISOString(),
      threads: rows,
    })
    diag('SNAP', `会话快照已上报 ${rows.length} 行（${opts.reason}）`)
  } catch (e) {
    diag('SNAP', `会话快照上报失败: ${(e as Error).message}`)
  }
  return rows.length
}
