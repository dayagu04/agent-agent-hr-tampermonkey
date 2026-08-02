// 页面内日志器 —— 不依赖 DevTools Console
//
// BOSS 直聘有 devtools 检测（一开 F12 会白屏/断连），诊断信息不能只打 console，
// 必须落在页面内 + 持久化，供用户一键复制导出。
const BUFFER_KEY = 'aah_diag_log'
/** 日志保留行数（面板展示与持久化共用同一常量，避免两处不一致） */
export const MAX_LINES = 500

let buffer: string[] = []

function loadBuffer(): string[] {
  if (buffer.length) return buffer
  try {
    const raw = GM_getValue(BUFFER_KEY, '')
    buffer = raw ? (JSON.parse(raw as string) as string[]) : []
  } catch {
    buffer = []
  }
  return buffer
}

function persist(): void {
  try {
    GM_setValue(BUFFER_KEY, JSON.stringify(buffer.slice(-MAX_LINES)))
  } catch {
    /* 存储失败不影响主流程 */
  }
}

/** 订阅者（面板用于实时展示） */
type Listener = (line: string) => void
const listeners = new Set<Listener>()

export function onDiag(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 记录一条诊断日志：写内存缓冲 + 持久化 + 通知面板 + （安全时）打 console。
 *
 * @param tag   模块标签，如 'BOSS' / 'ZHAOPIN' / 'ENGINE'
 * @param msg   人类可读消息
 * @param data  可选结构化数据（会被 JSON 化附在行尾）
 */
export function diag(tag: string, msg: string, data?: unknown): void {
  loadBuffer()
  // 固定 24 小时制（不用 toLocaleTimeString，避免受系统区域设置影响）；
  // 日志缓冲跨天保留，故带月-日。
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const ts = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  let line = `[${ts}][${tag}] ${msg}`
  if (data !== undefined) {
    try {
      const s = JSON.stringify(data)
      line += ` ${s.length > 600 ? s.slice(0, 600) + '…' : s}`
    } catch {
      line += ' [unserializable]'
    }
  }
  buffer.push(line)
  if (buffer.length > MAX_LINES) buffer = buffer.slice(-MAX_LINES)
  persist()
  listeners.forEach((fn) => {
    try {
      fn(line)
    } catch {
      /* ignore */
    }
  })

  // console 仍打一份（智联/51 可正常开 DevTools）
  try {
    console.log(line)
  } catch {
    /* ignore */
  }
}

/** 统一时间戳格式 HH:MM:SS（24 小时制，供动作日志与诊断日志共用） */
export function hhmmss(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 取全部日志文本（供复制/导出） */
export function getDiagText(): string {
  loadBuffer()
  return buffer.join('\n')
}

/** 清空日志 */
export function clearDiag(): void {
  buffer = []
  try {
    GM_deleteValue(BUFFER_KEY)
  } catch {
    /* ignore */
  }
}

/** 环境快照：附在日志开头，便于定位平台/版本/页面状态 */
export function envSnapshot(): string {
  return [
    `url=${location.href}`,
    `ua=${navigator.userAgent}`,
    `viewport=${window.innerWidth}x${window.innerHeight}`,
    `time=${new Date().toISOString()}`,
  ].join('\n')
}
