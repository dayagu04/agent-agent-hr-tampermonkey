// 配置存储 — 基于油猴 GM_setValue/GM_getValue 持久化
import type { PluginConfig } from './types'

const CONFIG_KEY = 'aah_plugin_config'

const DEFAULT_CONFIG: PluginConfig = {
  apiBase: 'https://gudaya.chat',  // 生产后端；本地开发改 localhost:8010
  token: '',
  resumeId: null,
  threshold: 60,
  matchEnabled: true,
  maxApply: 20,
  chatCheckInterval: 5,
  maxPagesPerKeyword: 20,
  searchFilterQuery: '',
  applyIntervalSeconds: 30,
  autoPaginate: true,
  maxPages: 5,
  prefCity: '',
  // 默认不因城市不符而拒绝：宁可接受并标记，也不自动放弃机会
  rejectOffCityLocation: false,
  minReplyScore: 50,
}

/** 跨页任务状态（翻页会导致页面重载，任务进度必须存盘才能续跑） */
const TASK_KEY = 'aah_running_task'

export interface RunningTask {
  active: boolean
  applied: number      // 已累计投递数（跨页累加）
  skipped: number
  failed: number
  page: number         // 已处理页数
  startedAt: number
}

export function loadTask(): RunningTask | null {
  try {
    const raw = GM_getValue(TASK_KEY, '')
    if (!raw) return null
    const t = JSON.parse(raw as string) as RunningTask
    // 超过 30 分钟的残留任务视为失效，避免下次打开页面莫名自动投递
    if (Date.now() - (t.startedAt || 0) > 30 * 60 * 1000) {
      clearTask()
      return null
    }
    return t
  } catch {
    return null
  }
}

export function saveTask(t: RunningTask): void {
  GM_setValue(TASK_KEY, JSON.stringify(t))
}

export function clearTask(): void {
  GM_deleteValue(TASK_KEY)
}

export function loadConfig(): PluginConfig {
  try {
    const raw = GM_getValue(CONFIG_KEY, '')
    if (!raw) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(raw as string)
    const cfg = { ...DEFAULT_CONFIG, ...parsed }
    // 兼容旧配置：无 applyIntervalSeconds 时从旧的 delayMax / minIntervalSeconds 推导一次
    if (typeof parsed.applyIntervalSeconds !== 'number') {
      const oldSec = Math.max(
        (parsed.delayMax || 0) / 1000,
        parsed.minIntervalSeconds || 0,
      )
      cfg.applyIntervalSeconds = oldSec > 0
        ? Math.round(oldSec)
        : DEFAULT_CONFIG.applyIntervalSeconds
    }
    return cfg
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(cfg: PluginConfig): void {
  GM_setValue(CONFIG_KEY, JSON.stringify(cfg))
}

export function isConfigReady(cfg: PluginConfig): boolean {
  return !!cfg.apiBase && !!cfg.token && !!cfg.resumeId
}
