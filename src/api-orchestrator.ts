// API 新增：编排器事件上报 + 会话并发优化
import type { PluginConfig } from './types'
import { network } from './platform-bridge'

/** 上报编排器事件到服务器（供网页端可观测性） */
export async function reportOrchestratorEvent(
  cfg: PluginConfig,
  payload: {
    event: string
    timestamp: number
    phase: string
    stats?: Record<string, unknown>
    details: Record<string, unknown>
  },
): Promise<void> {
  try {
    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/orchestrator/event`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
      },
      data: JSON.stringify(payload),
      timeout: 20000,
    })
    if (resp.status !== 200) {
      console.warn('[API] 编排器事件上报失败', resp.status)
    }
  } catch {
    // 上报失败静默，不影响主流程
  }
}

/** 批量同步会话（并发版本，替代原 syncChat） */
export async function syncChatBatch(
  cfg: PluginConfig,
  items: Array<{
    company: string
    jobTitle: string
    messages: Array<{ sender: 'hr' | 'me'; content: string }>
  }>,
): Promise<
  Array<{
    company: string
    jobTitle: string
    action: 'reply' | 'send_resume' | 'skip'
    reply?: string
    intent?: string
  }>
> {
  // 并发发起所有 LLM 请求
  const promises = items.map((item) =>
    network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/chat/sync`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
      },
      data: JSON.stringify({
        resume_id: cfg.resumeId,
        platform: 'zhipin',
        company: item.company,
        job_title: item.jobTitle,
        messages: item.messages,
      }),
      timeout: 30000,
    }),
  )

  // 等待全部返回
  const responses = await Promise.allSettled(promises)

  // 解析结果
  return responses.map((resp, idx) => {
    if (resp.status === 'fulfilled' && resp.value.status === 200) {
      try {
        const data = JSON.parse(resp.value.responseText)
        return {
          company: items[idx].company,
          jobTitle: items[idx].jobTitle,
          action: data.action || 'skip',
          reply: data.reply,
          intent: data.intent,
        }
      } catch {
        return {
          company: items[idx].company,
          jobTitle: items[idx].jobTitle,
          action: 'skip' as const,
        }
      }
    }
    // 请求失败，返回跳过
    return {
      company: items[idx].company,
      jobTitle: items[idx].jobTitle,
      action: 'skip' as const,
    }
  })
}
