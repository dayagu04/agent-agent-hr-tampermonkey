// 画像采集（Onboarding）后端通信 — 独立于投递/会话 API，服务 /api/onboarding/*
import type {
  OnboardingChatResult,
  OnboardingStatus,
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

/** GET /api/onboarding/status — 画像完整度、当前层级与下一问题 */
export async function fetchOnboardingStatus(cfg: PluginConfig): Promise<OnboardingStatus> {
  const resp = await network.request({
    method: 'GET',
    url: `${cfg.apiBase}/api/onboarding/status`,
    headers: authHeaders(cfg),
    timeout: TIMEOUT,
  })
  if (resp.status !== 200) {
    throw parseDetail(resp.status, resp.responseText, '获取画像状态失败')
  }
  return JSON.parse(resp.responseText)
}

/** POST /api/onboarding/chat — 发送回答/命令，返回回复与下一问题 */
export async function sendOnboardingChat(
  cfg: PluginConfig,
  message: string,
): Promise<OnboardingChatResult> {
  const resp = await network.request({
    method: 'POST',
    url: `${cfg.apiBase}/api/onboarding/chat`,
    headers: authHeaders(cfg),
    data: JSON.stringify({ message }),
    timeout: TIMEOUT,
  })
  if (resp.status !== 200) {
    throw parseDetail(resp.status, resp.responseText, '发送失败')
  }
  return JSON.parse(resp.responseText)
}

/** PATCH /api/onboarding/profile — 用户手动修正画像字段 */
export async function patchOnboardingProfile(
  cfg: PluginConfig,
  updates: Record<string, unknown>,
): Promise<{ applied: Record<string, unknown> }> {
  const resp = await network.request({
    method: 'PATCH',
    url: `${cfg.apiBase}/api/onboarding/profile`,
    headers: authHeaders(cfg),
    data: JSON.stringify({ updates }),
    timeout: TIMEOUT,
  })
  if (resp.status !== 200) {
    throw parseDetail(resp.status, resp.responseText, '保存画像失败')
  }
  return JSON.parse(resp.responseText)
}

/** POST /api/onboarding/reset — 清空画像并重新开始 */
export async function resetOnboardingProfile(cfg: PluginConfig): Promise<void> {
  const resp = await network.request({
    method: 'POST',
    url: `${cfg.apiBase}/api/onboarding/reset`,
    headers: authHeaders(cfg),
    timeout: TIMEOUT,
  })
  if (resp.status !== 200) {
    throw parseDetail(resp.status, resp.responseText, '重置画像失败')
  }
}
