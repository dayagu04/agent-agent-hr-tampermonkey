// 会话处理计划 —— 后端决策层与插件执行层的契约。
//
// 架构原则：插件 = 执行器 + DOM 采集；「哪个会话要回复 / 要清理」由后端决定。
// 插件每轮只做三件事：拿计划 → 滚动采集行 → 只打开计划命中的目标行。
// 新策略（外包不回复、低质量删除、冷静期等）只改后端 /api/plugin/chat/plan，
// 插件零改动。

import { fetchChatPlan } from './api'
import type { ChatPlan, ChatPlanTarget } from './api'
import type { PluginConfig } from './types'

export type { ChatPlan, ChatPlanTarget }

/** 会话目标键：优先平台岗位 ID（最稳），退化为 公司|岗位。 */
export function chatTargetKey(t: {
  company?: string
  job_title?: string
  encrypt_job_id?: string
}): string {
  const jobId = (t.encrypt_job_id || '').trim()
  if (jobId) return `job:${jobId}`
  return `text:${(t.company || '').replace(/\s+/g, '')}|${(t.job_title || '').replace(/\s+/g, '')}`
}

/** 会话行键（与 chatTargetKey 同构）：行内 Vue 数据优先，退化为 DOM 文本。 */
export function chatRowKey(info: {
  encryptJobId?: string
  company?: string
  jobTitle?: string
}): string {
  const jobId = (info.encryptJobId || '').trim()
  if (jobId) return `job:${jobId}`
  return `text:${(info.company || '').replace(/\s+/g, '')}|${(info.jobTitle || '').replace(/\s+/g, '')}`
}

/** 标准化文本：去空白 + 小写（与 openThread 同容忍度）。 */
const norm = (s: string) => (s || '').replace(/\s+/g, '').toLowerCase()

/**
 * 在计划目标里匹配一个会话行。
 *
 * 优先级：encryptJobId 精确 → 公司+岗位双向子串。inbound 会话（HR 主动建档）的
 * platform_job_id 是后端虚构的 `inbound:公司:岗位`，与 BOSS 真实 jobId 永远对不上，
 * 必须靠公司/岗位模糊匹配兜底（2026-08-06 现场：45 个 reply 目标 0 个被打开）。
 *
 * @param lenient 宽松模式（reply）：允许「仅公司命中」；严格模式（cleanup）要求
 *                岗位也命中，避免同公司多岗位时删错会话。
 */
export function findPlanTarget(
  targets: ChatPlanTarget[],
  row: { encryptJobId?: string; company?: string; jobTitle?: string },
  opts: { lenient: boolean },
): ChatPlanTarget | null {
  const jobId = (row.encryptJobId || '').trim()
  if (jobId) {
    const hit = targets.find((t) => t.encrypt_job_id && t.encrypt_job_id.trim() === jobId)
    if (hit) return hit
  }
  const cc = norm(row.company || '')
  const cj = norm(row.jobTitle || '')
  if (!cc) return null
  for (const t of targets) {
    const tc = norm(t.company || '')
    if (!tc) continue
    if (!(cc.includes(tc) || tc.includes(cc))) continue
    const tj = norm(t.job_title || '')
    if (opts.lenient && !tj) return t
    if (!tj) continue
    if (cj && (cj.includes(tj) || tj.includes(cj))) return t
  }
  return null
}

/**
 * 拉取本轮会话处理计划。
 * 失败时返回空计划并打日志：插件降级为「只处理未读行」，绝不回退到逐个打开全部会话
 * （那正是 2026-08-06 卡聊天页 14 分钟的根因）。
 */
export async function loadChatPlan(
  cfg: PluginConfig,
  opts: { replyScope: 'this_round' | 'all' },
): Promise<{ pending: number; targets: ChatPlanTarget[] }> {
  const plan = await fetchChatPlan(cfg, { reply_scope: opts.replyScope })
  return { pending: plan.pending || 0, targets: plan.targets || [] }
}
