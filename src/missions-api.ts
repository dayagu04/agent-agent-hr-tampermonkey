// Agent 任务（/Submit）后端通信 — 服务 /api/missions/*
import type {
  AgentMission,
  ApplyResultReport,
  PluginConfig,
} from './types'
import { network } from './platform-bridge'

const TIMEOUT = 30000

function authHeaders(cfg: PluginConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.token}`,
  }
}

function parseDetail(status: number, responseText: string, fallback: string): Error {
  let detail = ''
  try {
    const err = JSON.parse(responseText)
    detail = typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail)
  } catch {
    detail = (responseText || '').slice(0, 200)
  }
  return new Error(`${fallback} (${status})${detail ? `：${detail}` : ''}`)
}

/** POST /api/missions — 创建任务（LLM 编排，后台执行） */
export async function createMission(
  cfg: PluginConfig,
  objective: string,
): Promise<AgentMission> {
  const resp = await network.request({
    method: 'POST',
    url: `${cfg.apiBase}/api/missions`,
    headers: authHeaders(cfg),
    data: JSON.stringify({ objective }),
    timeout: TIMEOUT,
  })
  if (resp.status !== 201 && resp.status !== 200) {
    throw parseDetail(resp.status, resp.responseText, '创建任务失败')
  }
  return JSON.parse(resp.responseText)
}

/** GET /api/missions — 任务列表 */
export async function listMissions(cfg: PluginConfig): Promise<AgentMission[]> {
  const resp = await network.request({
    method: 'GET',
    url: `${cfg.apiBase}/api/missions`,
    headers: authHeaders(cfg),
    timeout: TIMEOUT,
  })
  if (resp.status !== 200) {
    throw parseDetail(resp.status, resp.responseText, '获取任务列表失败')
  }
  return JSON.parse(resp.responseText).missions || []
}

/** GET /api/missions/{id} — 任务详情 */
export async function getMission(cfg: PluginConfig, missionId: number): Promise<AgentMission> {
  const resp = await network.request({
    method: 'GET',
    url: `${cfg.apiBase}/api/missions/${missionId}`,
    headers: authHeaders(cfg),
    timeout: TIMEOUT,
  })
  if (resp.status !== 200) {
    throw parseDetail(resp.status, resp.responseText, '获取任务详情失败')
  }
  return JSON.parse(resp.responseText)
}

/** POST /api/missions/{id}/apply-result — 回报投递结果 */
export async function reportApplyResults(
  cfg: PluginConfig,
  missionId: number,
  results: ApplyResultReport[],
): Promise<AgentMission> {
  const resp = await network.request({
    method: 'POST',
    url: `${cfg.apiBase}/api/missions/${missionId}/apply-result`,
    headers: authHeaders(cfg),
    data: JSON.stringify({ results }),
    timeout: TIMEOUT,
  })
  if (resp.status !== 200) {
    throw parseDetail(resp.status, resp.responseText, '回报投递结果失败')
  }
  return JSON.parse(resp.responseText)
}

/** POST /api/missions/{id}/cancel — 取消任务 */
export async function cancelMission(cfg: PluginConfig, missionId: number): Promise<AgentMission> {
  const resp = await network.request({
    method: 'POST',
    url: `${cfg.apiBase}/api/missions/${missionId}/cancel`,
    headers: authHeaders(cfg),
    timeout: TIMEOUT,
  })
  if (resp.status !== 200) {
    throw parseDetail(resp.status, resp.responseText, '取消任务失败')
  }
  return JSON.parse(resp.responseText)
}
