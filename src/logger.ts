// 页面内日志器 → 服务端批量上报
//
// 插件本地不再持久化日志、不再提供日志面板；diag() 把日志行放进内存缓冲，
// 攒够一批（≥50 条）或距上次上报超过 60 秒时，统一 POST /api/plugin/logs，
// 由后端按用户（JWT）落库。console.log 保留供开发期排查。
import { network } from './platform-bridge'
import { loadConfig, isConfigReady } from './config'

/** 攒够多少条触发一次上报 */
const FLUSH_THRESHOLD = 50
/** 距上次上报超过该时长则强制上报（毫秒） */
const FLUSH_INTERVAL_MS = 60_000
/** 内存缓冲上限（避免插件长时间运行无后端时无限膨胀；同时给批量扫描留足余量，
 *  防止「跳过已处理会话」这类高频日志把发送失败等关键诊断行挤出缓冲） */
const MAX_BUFFER = 500

interface LogEntry {
  tag: string
  message: string
}

let buffer: LogEntry[] = []
let lastFlush = 0
let flushing = false

/** 上报缓冲日志；未到阈值/间隔时跳过（非实时）。失败保留待下次重试。 */
export function flushLogs(): Promise<void> {
  if (flushing || buffer.length === 0) return Promise.resolve()
  const now = Date.now()
  if (buffer.length < FLUSH_THRESHOLD && now - lastFlush < FLUSH_INTERVAL_MS) {
    return Promise.resolve()
  }

  const cfg = loadConfig()
  if (!isConfigReady(cfg)) return Promise.resolve()

  const batch = buffer.splice(0, FLUSH_THRESHOLD)
  flushing = true
  return network.request({
    method: 'POST',
    url: `${cfg.apiBase}/api/plugin/logs`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.token}`,
    },
    data: JSON.stringify({ logs: batch }),
    timeout: 15000,
  })
    .then((resp) => {
      if (resp.status !== 200) buffer = [...batch, ...buffer].slice(-MAX_BUFFER)
      lastFlush = Date.now()
    })
    .catch(() => {
      // 网络/后端不可达：放回缓冲下次再传
      buffer = [...batch, ...buffer].slice(-MAX_BUFFER)
      lastFlush = Date.now()
    })
    .finally(() => {
      flushing = false
      if (buffer.length >= FLUSH_THRESHOLD) void flushLogs()
    })
}

/**
 * 记录一条诊断日志：进内存缓冲（攒批上报），并打 console 供开发排查。
 *
 * @param tag   模块标签，如 'BOSS' / 'ENGINE' / 'ORCH'
 * @param msg   人类可读消息
 * @param data  可选结构化数据（会被 JSON 化附在行尾）
 */
export function diag(tag: string, msg: string, data?: unknown): void {
  let line = msg
  if (data !== undefined) {
    try {
      const s = JSON.stringify(data)
      line += ` ${s.length > 600 ? s.slice(0, 600) + '…' : s}`
    } catch {
      line += ' [unserializable]'
    }
  }
  buffer.push({ tag, message: line })
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER)
  try {
    console.log(`[${tag}] ${line}`)
  } catch {
    /* ignore */
  }
  void flushLogs()
}

/** 统一时间戳格式 HH:MM:SS（24 小时制，供动作日志共用） */
export function hhmmss(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
