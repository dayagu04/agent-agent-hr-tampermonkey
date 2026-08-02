// 页面内日志器 —— 不依赖 DevTools Console
//
// 为什么需要：BOSS 直聘有 devtools 检测，一开 F12 就会白屏/断连，插件面板也消失。
// 因此 BOSS 的诊断信息不能只打 console，必须落在页面内 + 持久化，
// 供用户事后一键复制导出。
//
// 用法：
//   import { diag } from '../logger'
//   diag('BOSS', `卡片命中 ${n} 个`)          // 普通
//   diag('BOSS', '未找到按钮', { texts })     // 带结构化数据
const BUFFER_KEY = 'aah_diag_log'
/**
 * 日志保留行数。
 *
 * 500 行：Phase 3 从 400 提到 500。持久化本就已实现（每次 diag() 都写 GM 存储、
 * 面板挂载时从 getDiagText() 恢复），故无需另建 aah_diag_history —— 那会让每行
 * 日志写两份存储、清空时还得清两个 key，多一个可能不同步的来源。
 *
 * 导出给面板复用：面板侧另有一份内存数组，若各自写死数字，改一处就会出现
 * 「存了 500 行但面板只留 400 行」的不一致。
 */
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
  // 固定 HH:MM:SS，不用 toLocaleTimeString：后者受系统区域设置影响，
  // 可能输出「下午9:30:41」这种 12 小时制，与动作日志的格式不一致，
  // 混在一起看像时间戳错乱。日志缓冲跨天保留，故补上月-日。
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

  // console 仍然打一份（智联/51 可正常开 DevTools）；
  // BOSS 场景用户不开 Console，靠上面的面板 + 导出即可。
  try {
    console.log(line)
  } catch {
    /* ignore */
  }
}

/**
 * 统一时间戳格式 HH:MM:SS（24 小时制，不受系统区域设置影响）。
 *
 * 供动作日志与诊断日志共用——两处若用不同格式（一个 24 小时制、
 * 一个「下午9:30」），对照排查时会误判成时间戳错乱。
 */
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
