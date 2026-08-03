// 任务投递会话 — 跨页顺序执行：当前 Tab 逐个打开岗位页 → 浏览器内投递 → 回报服务端
//
// 状态存 GM 存储（同源跨页共享），页面刷新/导航后由 resumeMissionApply 恢复：
//   1. 会话存在且当前 URL 匹配目标岗位 → 执行 applyJob
//   2. 记录结果 → 前进到下一岗位（跳转）或全部完成后回报 /apply-result
import type {
  ApplyResultReport,
  MissionApplyJob,
  PluginConfig,
} from './types'
import { diag } from './logger'
import { reportApplyResults } from './missions-api'
import { detectPlatform } from './platforms/factory'

const SESSION_KEY = 'aah_mission_apply_session'

export interface MissionApplySession {
  missionId: number
  apiBase: string
  token: string
  jobs: MissionApplyJob[]
  index: number
  results: ApplyResultReport[]
  startedAt: number
}

export function loadMissionSession(): MissionApplySession | null {
  try {
    const raw = GM_getValue(SESSION_KEY, '')
    if (!raw) return null
    const s = JSON.parse(raw as string) as MissionApplySession
    if (!s.missionId || !Array.isArray(s.jobs) || !s.jobs.length) return null
    return s
  } catch {
    return null
  }
}

export function saveMissionSession(s: MissionApplySession): void {
  GM_setValue(SESSION_KEY, JSON.stringify(s))
}

export function clearMissionSession(): void {
  GM_deleteValue(SESSION_KEY)
}

/** 启动投递会话并跳转到第一个岗位页 */
export function startMissionApply(
  cfg: PluginConfig,
  missionId: number,
  jobs: MissionApplyJob[],
): void {
  if (!jobs.length) return
  const session: MissionApplySession = {
    missionId,
    apiBase: cfg.apiBase,
    token: cfg.token,
    jobs,
    index: 0,
    results: [],
    startedAt: Date.now(),
  }
  saveMissionSession(session)
  diag('任务', `开始投递 ${jobs.length} 个岗位，跳转 ${jobs[0].title}`)
  window.location.href = jobs[0].url
}

/** 页面加载后恢复会话：命中目标页则投递并推进 */
export async function resumeMissionApply(): Promise<boolean> {
  const session = loadMissionSession()
  if (!session) return false
  const job = session.jobs[session.index]
  if (!job) return false

  // URL 归一化比对（去 query/hash）：未命中说明还在跳转途中
  const current = normalizeUrl(location.href)
  const target = normalizeUrl(job.url)
  if (current !== target) return false

  const outcome = await applyOne(job)
  session.results.push(outcome)
  session.index += 1
  saveMissionSession(session)
  diag('任务', `[${session.index}/${session.jobs.length}] ${job.title}: ${outcome.success ? '成功' : '失败'}`)

  const next = session.jobs[session.index]
  if (next) {
    window.location.href = next.url
    return true
  }

  // 全部完成：回报服务端并清理会话
  try {
    const cfg = { apiBase: session.apiBase, token: session.token } as PluginConfig
    await reportApplyResults(cfg, session.missionId, session.results)
    diag('任务', `任务 ${session.missionId} 投递结果已回报（${session.results.length} 条）`)
  } catch (e) {
    diag('任务', `回报失败：${(e as Error).message}`)
  } finally {
    clearMissionSession()
  }
  return true
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url, location.href)
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '')
  } catch {
    return url.split('#')[0].split('?')[0].replace(/\/+$/, '')
  }
}

async function applyOne(job: MissionApplyJob): Promise<ApplyResultReport> {
  const platform = detectPlatform()
  if (!platform) {
    return { application_id: job.application_id, success: false, error: '当前页面无平台适配器' }
  }
  const card = {
    platformJobId: `mission-${job.application_id}`,
    title: job.title,
    company: job.company,
    city: job.city,
    salary: job.salary,
    url: job.url,
  }
  try {
    const raw = await platform.applyJob(card, { getGreeting: async () => '' })
    const outcome = typeof raw === 'boolean' ? (raw ? 'applied' : 'failed') : raw.outcome
    const message = typeof raw === 'boolean' ? '' : raw.message || ''
    return {
      application_id: job.application_id,
      success: outcome === 'applied',
      platform_application_id: outcome === 'applied' ? job.url : '',
      error: outcome === 'failed' ? message : undefined,
    }
  } catch (e) {
    return { application_id: job.application_id, success: false, error: (e as Error).message }
  }
}
