// 网页端远程管理：心跳上报 + 命令轮询执行
//
// 设计：网页端「我的助手」是插件的远程管理台（二者共用同一套后端）。
// - 插件每 5s 向后端 POST 一次心跳（平台/版本/阶段/统计），
//   顺手取回网页端入队的远程命令并执行；
// - 网页端通过 /api/plugin/commands 入队 orchestrator.* 命令，
//   插件下次心跳时消费，实现「网页控制插件」。
import { VERSION } from './version'
import { loadConfig, saveConfig, isConfigReady, applyPluginPreferences } from './config'
import { network } from './platform-bridge'
import { flushLogs } from './logger'
import {
  getCurrentJob, getOrchestrator, getOrchestratorSnapshot, resumeOrchestrator,
} from './orchestrator'
import { detectPlatform } from './platforms/factory'

/** 当前页面平台代号（用于心跳上报） */
export function currentPlatformCode(): string {
  const url = location.href
  if (url.includes('zhipin.com')) return 'zhipin'
  if (url.includes('zhaopin.com')) return 'zhaopin'
  if (url.includes('51job.com')) return 'qiancheng'
  if (url.includes('liepin.com')) return 'liepin'
  return ''
}

interface RemoteCommand {
  id: number
  action: string
  payload: Record<string, unknown>
}

function authHeaders(cfg: ReturnType<typeof loadConfig>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.token}`,
  }
}

/** 上报一次心跳；返回的 commands 由调用方逐条执行 */
export async function reportHeartbeatAndPoll(): Promise<void> {
  const cfg = loadConfig()
  if (!isConfigReady(cfg)) return

  // 顺带批量上报缓冲日志（logger 内部按 50 条/60 秒门控,非实时）
  void flushLogs()

  const orch = getOrchestrator(cfg)
  // 优先用单例状态;页面跳转后单例尚未恢复时,回退到持久化快照,
  // 保证网页端看到的阶段/运行态始终真实(修复「网页显示投递开始后退出」)。
  const live = orch.getState()
  const snap = await getOrchestratorSnapshot()
  const phase = live?.phase ?? snap?.phase ?? 'idle'
  const running = orch.isRunning() || !!snap?.running
  const currentJob = getCurrentJob()
  const body = {
    platform: currentPlatformCode(),
    version: VERSION,
    phase,
    running,
    applied_total: live?.stats.appliedTotal ?? snap?.appliedTotal ?? 0,
    replied_total: live?.stats.hrRepliesTotal ?? snap?.hrRepliesTotal ?? 0,
    send_resume_total: live?.stats.sendResumeTotal ?? snap?.sendResumeTotal ?? 0,
    pending_hr_messages: live?.stats.pendingHrMessages ?? snap?.pendingHrMessages ?? null,
    skipped_total: live?.stats.skippedTotal ?? snap?.skippedTotal ?? 0,
    failed_total: live?.stats.failedTotal ?? snap?.failedTotal ?? 0,
    goal_target: snap?.goalTarget ?? live?.goal?.target ?? null,
    keyword: live?.keywords[live.currentKeywordIndex] ?? snap?.keyword ?? '',
    page: live?.currentPage ?? snap?.page ?? 1,
    started_at: snap?.startedAt ?? live?.startedAt ?? null,
    last_error: snap?.lastError ?? null,
    current_job: currentJob
      ? { title: currentJob.title, company: currentJob.company, score: currentJob.score }
      : null,
    run_id: live?.runId ?? snap?.runId ?? null,
  }

  try {
    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/heartbeat`,
      headers: authHeaders(cfg),
      data: JSON.stringify(body),
      timeout: 15000,
    })
    if (resp.status !== 200) return
    const result = JSON.parse(resp.responseText)
    const commands: RemoteCommand[] = result.commands || []
    for (const cmd of commands) {
      await executeCommand(cfg, cmd)
    }
    // 网页端插件偏好实时同步：网页端设置优先（任一字段变化都落盘，
    // 否则 cleanRead* 这类设置只进内存、刷新即丢）
    if (result.plugin_preferences) {
      const next = applyPluginPreferences(cfg, result.plugin_preferences)
      if (
        next.replyScope !== cfg.replyScope ||
        next.maxRepliesPerRound !== cfg.maxRepliesPerRound ||
        next.cleanReadConversations !== cfg.cleanReadConversations ||
        next.cleanReadAfterHours !== cfg.cleanReadAfterHours ||
        next.defaultSendResumeId !== cfg.defaultSendResumeId
      ) {
        saveConfig(next)
      }
    }
  } catch {
    // 心跳失败静默（网络/后端暂不可达时不影响插件主流程）
  }
}

/** 执行一条远程命令（网页端入队） */
async function executeCommand(
  cfg: ReturnType<typeof loadConfig>,
  cmd: RemoteCommand,
): Promise<void> {
  const orch = getOrchestrator(cfg)
  try {
    switch (cmd.action) {
      case 'orchestrator.start': {
        if (!detectPlatform()) {
          console.warn('[remote] 未在招聘平台页面，无法启动编排')
          break
        }
        const p = cmd.payload || {}
        const goal = {
          type: (p.goal_type as 'apply_count' | 'hr_reply_count' | 'time_elapsed') || 'apply_count',
          target: typeof p.goal_target === 'number' ? p.goal_target : cfg.maxApply || 20,
        }
        const keywords = Array.isArray(p.keywords)
          ? (p.keywords as string[]).filter(Boolean)
          : []
        // 城市只接受 BOSS 数字编码；城市名（如"杭州"）会污染 ?city= 参数，
        // 城市继续由当前 BOSS 页 URL 继承。
        const city =
          typeof p.city === 'string' && /^\d+$/.test(p.city.trim()) ? p.city.trim() : undefined
        const plan = Array.isArray(p.plan)
          ? (p.plan as Array<{ keyword: string; city: string; cityCode: string; quota: number }>)
          : undefined
        const quotaMode =
          p.quota_mode === 'per_combination' || p.quota_mode === 'total_llm'
            ? p.quota_mode
            : undefined
        await orch.start(goal, keywords, city, plan, quotaMode)
        break
      }
      case 'orchestrator.pause':
        await orch.pause(typeof cmd.payload?.reason === 'string' ? cmd.payload.reason : '网页端远程暂停')
        break
      case 'orchestrator.resume':
        if (orch.getState()?.phase === 'paused') {
          // 暂停是用户主动暂停,用显式恢复(回到 search 续跑)
          await orch.resumeFromPause()
        } else {
          // 页面跳转/刷新后的正常续跑
          await resumeOrchestrator(cfg)
        }
        break
      case 'orchestrator.stop':
        await orch.stop(typeof cmd.payload?.reason === 'string' ? cmd.payload.reason : '网页端远程停止')
        break
      case 'orchestrator.action':
        // 后端 LangGraph 下发的执行指令（apply_batch / chat_snapshot / chat_reply / stop / pause）
        await orch.applyBackendAction((cmd.payload || {}) as Record<string, unknown>)
        break
      case 'config.reload':
        // 网页端改了核心配置(单轮投递上限/阈值等):通知面板静默重拉配置,实时生效
        window.dispatchEvent(new CustomEvent('aah:config-reload'))
        break
      default:
        console.warn('[remote] 未知命令', cmd.action)
    }
  } catch (e) {
    console.warn('[remote] 命令执行失败', cmd.action, e)
  }
}

/** 启动远程管理循环（心跳 + 命令轮询），页面挂载后调用一次 */
// 心跳间隔即"网页端指令生效延迟"上限：5s 一跳，指令最坏 5s 内执行。
// 如需更快可下调，但注意 POST 频率与后端日志量成正比。
export function startRemoteLoop(intervalMs = 5000): void {
  window.setInterval(() => {
    void reportHeartbeatAndPoll()
  }, intervalMs)
  void reportHeartbeatAndPoll()
}
