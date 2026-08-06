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

/**
 * 拉取本轮会话处理计划。
 * 失败时返回空计划并打日志：插件降级为「只处理未读行」，绝不回退到逐个打开全部会话
 * （那正是 2026-08-06 卡聊天页 14 分钟的根因）。
 */
export async function loadChatPlan(
  cfg: PluginConfig,
  opts: { replyScope: 'this_round' | 'all' },
): Promise<{ pending: number; byKey: Map<string, ChatPlanTarget> }> {
  const plan = await fetchChatPlan(cfg, { reply_scope: opts.replyScope })
  const byKey = new Map<string, ChatPlanTarget>()
  for (const t of plan.targets || []) {
    const key = chatTargetKey(t)
    if (key && key !== 'text:|') byKey.set(key, t)
  }
  return { pending: plan.pending || 0, byKey }
}
