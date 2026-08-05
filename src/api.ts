// 后端通信 — 通过 platform-bridge 的网络层跨域调用后端 API
import type {
  ApplyOutcome,
  ApplyRule,
  HRMessageSummary,
  JobCard,
  MatchResultItem,
  PluginConfig,
  PlatformCode,
} from './types'
import { diag } from './logger'
import { network } from './platform-bridge'

/** 匹配走 LLM 精排，几十个岗位可能要 1-2 分钟，默认超时放宽到 180s */
const DEFAULT_TIMEOUT = 180000

/** 分批处理，避免单次请求过大导致超时 */
const MATCH_BATCH_SIZE = 10

function authHeaders(cfg: PluginConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.token}`,
  }
}

/** POST /api/auth/login — 用邮箱密码登录，换取 JWT Token（省去手动复制） */
export async function login(
  apiBase: string,
  email: string,
  password: string,
): Promise<{ token: string; user_id: number; username: string }> {
  const resp = await network.request({
    method: 'POST',
    url: `${apiBase}/api/auth/login`,
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ email, password }),
    timeout: DEFAULT_TIMEOUT,
  })
  if (resp.status !== 200) {
    let detail = ''
    try {
      detail = JSON.parse(resp.responseText).detail || ''
    } catch {
      /* ignore */
    }
    if (resp.status === 401) throw new Error('邮箱或密码错误')
    throw new Error(`登录失败 (${resp.status})${detail ? '：' + detail : ''}`)
  }
  return JSON.parse(resp.responseText)
}

/** GET /api/plugin/config — 拉取简历列表 + 默认阈值 */
export async function fetchPluginConfig(cfg: PluginConfig): Promise<{
  resumes: Array<{ id: number; name: string; skills_count: number }>
  default_threshold: number
  supported_platforms: string[]
  // 网站侧求职偏好（个人设置页维护），插件同步后与 Web Agent 行为一致
  preferences?: {
    keyword: string
    city: string
    threshold: number | null
    apply_limit: number | null
  }
  suggested_keywords?: string[]  // 从简历提取的 top 技能，供预填
  plugin_preferences?: Record<string, unknown>  // 网页端插件偏好（回复模式等）
}> {
  const resp = await network.request({
    method: 'GET',
    url: `${cfg.apiBase}/api/plugin/config`,
    headers: authHeaders(cfg),
    timeout: DEFAULT_TIMEOUT,
  })
  if (resp.status !== 200) {
    throw new Error(`拉取配置失败 (${resp.status})：请检查后端地址和 Token`)
  }
  return JSON.parse(resp.responseText)
}

/** POST /api/plugin/match — 批量匹配岗位 */
export async function matchJobs(
  cfg: PluginConfig,
  platform: PlatformCode,
  jobs: JobCard[],
  onBatch?: (done: number, total: number) => void,
): Promise<MatchResultItem[]> {
  // 分批：一次几十个岗位走 LLM 精排极易超时，切成小批稳定得多
  if (jobs.length > MATCH_BATCH_SIZE) {
    const all: MatchResultItem[] = []
    for (let i = 0; i < jobs.length; i += MATCH_BATCH_SIZE) {
      const chunk = jobs.slice(i, i + MATCH_BATCH_SIZE)
      const part = await matchJobs(cfg, platform, chunk)
      all.push(...part)
      onBatch?.(Math.min(i + MATCH_BATCH_SIZE, jobs.length), jobs.length)
    }
    return all
  }

  const payload = {
    resume_id: cfg.resumeId,
    platform,
    threshold: cfg.threshold,
    jobs: jobs.map((j) => ({
      platform_job_id: j.platformJobId,
      title: j.title,
      company: j.company || '',
      city: j.city || '',
      salary: j.salary || '',
      description: j.description || '',
      url: j.url || '',
    })),
  }
  // 提交的载荷进日志：岗位 id/标题为空是「扫描到岗位但匹配 0」的最常见原因
  diag(
    'API',
    `match 提交 ${payload.jobs.length} 个岗位 threshold=${payload.threshold}`,
    payload.jobs.slice(0, 3).map((j) => ({ id: j.platform_job_id, t: j.title })),
  )

  const resp = await network.request({
    method: 'POST',
    url: `${cfg.apiBase}/api/plugin/match`,
    headers: authHeaders(cfg),
    data: JSON.stringify(payload),
    timeout: DEFAULT_TIMEOUT,
  })
  if (resp.status !== 200) {
    // 带上后端响应体：422 校验错误会明确指出哪个字段缺失
    diag('API', `match 失败 HTTP ${resp.status}`, (resp.responseText || '').slice(0, 300))
    let detail = ''
    try {
      const err = JSON.parse(resp.responseText)
      detail = typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail)
    } catch {
      detail = (resp.responseText || '').slice(0, 200)
    }
    throw new Error(`匹配请求失败 (${resp.status}): ${detail}`)
  }
  const data = JSON.parse(resp.responseText)
  diag('API', `match 返回 ${(data.results || []).length} 条评分`)
  return data.results || []
}

/** GET /api/plugin/rules — 拉取投递过滤规则（黑白名单/最低薪资） */
export async function fetchRules(cfg: PluginConfig): Promise<ApplyRule[]> {
  try {
    const resp = await network.request({
      method: 'GET',
      url: `${cfg.apiBase}/api/plugin/rules`,
      headers: authHeaders(cfg),
      timeout: 30000,
    })
    if (resp.status !== 200) return []
    return JSON.parse(resp.responseText).rules || []
  } catch {
    return [] // 规则拉取失败不阻断投递（与后端「降级不报错」一致）
  }
}

/** POST /api/plugin/greeting — 取打招呼语（BOSS 发首条消息用） */
export async function fetchGreeting(
  cfg: PluginConfig,
  platform: PlatformCode,
  job: JobCard,
): Promise<string> {
  try {
    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/greeting`,
      headers: authHeaders(cfg),
      data: JSON.stringify({
        resume_id: cfg.resumeId,
        platform,
        platform_job_id: job.platformJobId,
        title: job.title,
        company: job.company || '',
        description: job.description || '',
      }),
    })
    if (resp.status !== 200) return ''
    return JSON.parse(resp.responseText).greeting || ''
  } catch {
    return ''
  }
}

/** POST /api/plugin/decision — 上报决策（跳过/失败原因），落后端决策日志 */
export async function logDecision(
  cfg: PluginConfig,
  payload: {
    run_id: string
    platform: PlatformCode
    platform_job_id: string
    decision: string
    reason: string
    match_score?: number
    details?: Record<string, unknown>
  },
): Promise<void> {
  try {
    await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/decision`,
      headers: authHeaders(cfg),
      data: JSON.stringify(payload),
      timeout: 20000,
    })
  } catch {
    /* 决策日志非关键路径，静默失败 */
  }
}

/** POST /api/plugin/chat/sync — 单条会话同步+回复生成（完整版：去重/已回复判定/评分） */
export async function syncChatOne(
  cfg: PluginConfig,
  payload: {
    platform: string
    platform_job_id?: string
    company?: string
    job_title?: string
    messages: Array<{ sender: string; content: string; timestamp?: string }>
    auto_reply?: boolean
    min_reply_score?: number
    salary?: string
    city?: string
    run_id?: string
    reply_scope?: 'this_round' | 'all'
  },
): Promise<{
  conversation_id: number | null
  new_messages: number
  intent: string
  confidence: number
  reply: string
  send_resume: boolean
  action_id: number | null
  message: string
  delete_after_send?: boolean
} | null> {
  try {
    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/chat/sync`,
      headers: authHeaders(cfg),
      data: JSON.stringify(payload),
      timeout: 60000,
    })
    if (resp.status !== 200) {
      diag('API', `chat/sync 失败 HTTP ${resp.status}`, (resp.responseText || '').slice(0, 200))
      return null
    }
    return JSON.parse(resp.responseText)
  } catch (e) {
    diag('API', `chat/sync 异常: ${(e as Error).message}`)
    return null
  }
}

/**
 * GET /api/conversations/list — 拉最近会话，转成面板卡片用的 HR 消息摘要。
 *
 * 只打这一个端点：补打 /api/conversations/{id} 会对未回复消息调 LLM 生成
 * 回复草稿（每 30s 轮询 5 条 ≈ 每小时 600 次调用），正文由 /list 的
 * last_hr_message 字段直接给出，零额外查询。
 *
 * @param limit 取前几条（按 last_message_at 倒序，后端已排序）
 * @returns 摘要数组；请求失败返回 null（与「成功但空列表」区分，便于 UI 分别提示）
 */
export async function fetchHRMessages(
  cfg: PluginConfig,
  limit = 5,
  since?: number,
): Promise<HRMessageSummary[] | null> {
  try {
    const qs = new URLSearchParams()
    qs.set('limit', String(limit))
    if (since) qs.set('since', String(since))
    const resp = await network.request({
      method: 'GET',
      url: `${cfg.apiBase}/api/conversations/list?${qs.toString()}`,
      headers: authHeaders(cfg),
      timeout: 20000, // 纯 DB 查询
    })
    if (resp.status !== 200) {
      diag('API', `conversations/list 失败 HTTP ${resp.status}`)
      return null
    }
    const body = JSON.parse(resp.responseText)
    // 后端返回 {conversations: [...]}，不是裸数组
    const list = Array.isArray(body?.conversations) ? body.conversations : []
    const out: HRMessageSummary[] = []
    for (const c of list) {
      const hr = c?.last_hr_message
      if (!hr) continue // 没有任何 HR 消息的会话不进卡片列表
      const ts = Date.parse(hr.created_at || c.last_message_at || '')
      out.push({
        id: c.id,
        company: c.company || '未知公司',
        jobTitle: c.job_title || '',
        content: hr.truncated ? `${hr.content}…` : hr.content || '',
        timestamp: Number.isNaN(ts) ? 0 : ts,
        // 未读近似：HR 消息且未分类（intent 为空）。后端无已读字段。
        unread: !hr.intent,
        // 匹配分：后端可能返回 null（无投递记录），不要用 `|| 0` 塌成 0 分
        // ——那会把「无从判断」和「判过且很差」混为一谈，提示文案就分不开了。
        matchScore: typeof c.match_score === 'number' ? c.match_score : null,
        lastMessageAt: c.last_message_at || '',
      })
      if (out.length >= limit) break
    }
    diag('API', `HR 消息拉取 ${out.length} 条（未读 ${out.filter((m) => m.unread).length}）`)
    return out
  } catch (e) {
    diag('API', `conversations/list 异常: ${(e as Error).message}`)
    return null
  }
}

/** POST /api/plugin/chat/sent — 回报回复的真实发送结果（闭环留痕） */
export async function markChatSent(
  cfg: PluginConfig,
  actionId: number,
  success: boolean,
  error = '',
): Promise<void> {
  try {
    await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/chat/sent`,
      headers: authHeaders(cfg),
      data: JSON.stringify({ action_id: actionId, success, error }),
      timeout: 20000,
    })
  } catch {
    /* 留痕失败不影响会话继续 */
  }
}

/** POST /api/plugin/record — 记录一次投递 */
export async function recordApplication(
  cfg: PluginConfig,
  platform: PlatformCode,
  job: JobCard,
  matchScore: number,
  outcome: ApplyOutcome = 'applied',
  error = '',
  greetingSent = false,
  runId = '',
): Promise<{ success: boolean; duplicate: boolean; message: string }> {
  const payload = {
    platform,
    platform_job_id: job.platformJobId,
    title: job.title,
    company: job.company || '',
    city: job.city || '',
    url: job.url || '',
    salary: job.salary || '',
    match_score: matchScore,
    resume_id: cfg.resumeId,
    // 如实上报结果：unknown/failed 不会在库里记成 real_applied
    outcome,
    error,
    greeting_sent: greetingSent,
    run_id: runId || null,
  }
  const resp = await network.request({
    method: 'POST',
    url: `${cfg.apiBase}/api/plugin/record`,
    headers: authHeaders(cfg),
    data: JSON.stringify(payload),
    timeout: DEFAULT_TIMEOUT,
  })
  if (resp.status !== 200) {
    throw new Error(`记录投递失败 (${resp.status})`)
  }
  return JSON.parse(resp.responseText)
}

/**
 * POST /api/plugin/orchestrator/event — 上报编排器事件（阶段切换、批次完成、停止）。
 * 失败静默：可观测性不该拖垮投递主流程。
 */
export async function reportOrchestratorEvent(
  cfg: PluginConfig,
  payload: {
    event: string
    timestamp: number
    phase: string
    stats?: Record<string, number>
    details?: Record<string, unknown>
    run_id?: string
  },
): Promise<void> {
  try {
    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/orchestrator/event`,
      headers: authHeaders(cfg),
      data: JSON.stringify(payload),
      timeout: 20000,
    })
    if (resp.status !== 200) {
      diag('API', `编排事件上报返回 ${resp.status}（不影响投递）`)
    }
  } catch {
    /* 上报失败不影响运行 */
  }
}

/** POST /api/plugin/chat/snapshot — 上报会话行全量快照（评估状态标签/DOM 用） */
export async function reportThreadSnapshot(
  cfg: PluginConfig,
  payload: {
    run_id: string
    url: string
    reason: string
    captured_at: string
    threads: unknown[]
  },
): Promise<void> {
  try {
    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/chat/snapshot`,
      headers: authHeaders(cfg),
      data: JSON.stringify(payload),
      timeout: 60000,
    })
    if (resp.status !== 200) {
      diag('API', `chat/snapshot 上报失败 HTTP ${resp.status}`, (resp.responseText || '').slice(0, 200))
    }
  } catch (e) {
    diag('API', `chat/snapshot 上报异常: ${(e as Error).message}`)
  }
}
