// 手动调试采集 —— 记录当前页 DOM 结构与用户操作，供开发者适配选择器
//
// 用法：用户手动打开目标弹窗（如发简历的选择框）后点「开始调试」，
// 插件立即 dump 当前可见的 dialog/modal 结构与简历相关元素，
// 并在窗口期内记录 DOM 变化（MutationObserver）与点击操作，
// 全部写入插件日志（DBG 标签，批量上传后端 plugin_logs）。
import { diag } from './logger'

const DEBUG_TAG = 'DBG'
const DEFAULT_WINDOW_MS = 30_000

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 4 && r.height > 4
}

function ownText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => (n.textContent || '').trim())
    .join(' ')
    .slice(0, 60)
}

interface NodeInfo {
  tag: string
  cls: string
  text: string
  rect: string
}

function describe(
  el: Element,
  depth: number,
  maxDepth: number,
  maxNodes: number,
  out: NodeInfo[],
): void {
  if (out.length >= maxNodes || depth > maxDepth) return
  if (!visible(el)) return
  if (String(el.className || '').startsWith('aah-')) return
  const own = ownText(el)
  if (own || el.children.length === 0) {
    const r = el.getBoundingClientRect()
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 60),
      text: own.replace(/\s+/g, ' ').slice(0, 60),
      rect: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
    })
  }
  for (const k of Array.from(el.children)) describe(k, depth + 1, maxDepth, maxNodes, out)
}

function dumpVisibleDialogs(): void {
  diag(DEBUG_TAG, `=== 调试开始 url=${location.href} ===`)

  const sel =
    '[class*="dialog"],[class*="modal"],[class*="Dialog"],[class*="Modal"],[class*="layer"],[class*="popup"]'
  const dlg = Array.from(document.querySelectorAll(sel)).filter((d) => visible(d))
  diag(DEBUG_TAG, `可见 dialog/modal/popup 候选 ${dlg.length} 个`)
  for (let i = 0; i < Math.min(dlg.length, 8); i++) {
    const d = dlg[i]
    const t = (d.textContent || '').replace(/\s+/g, ' ').slice(0, 200)
    diag(DEBUG_TAG, `--- dialog#${i} class="${String(d.className || '').slice(0, 80)}" text="${t}"`)
    const nodes: NodeInfo[] = []
    describe(d, 0, 6, 120, nodes)
    for (const n of nodes) {
      diag(DEBUG_TAG, `  <${n.tag} class="${n.cls}" rect="${n.rect}"> ${n.text}`)
    }
  }

  // 简历/确认相关可见元素（按钮与文案）
  diag(DEBUG_TAG, '--- 简历/发送相关可见元素 ---')
  const resumeEls = Array.from(document.querySelectorAll('*')).filter((el) => {
    if (!visible(el)) return false
    const t = (el.textContent || '').replace(/\s+/g, '')
    if (t.length < 1 || t.length > 80) return false
    return /发简历|发送简历|附件简历|同意|拒绝|发送|选择.*简历/.test(t)
  })
  for (const el of resumeEls.slice(0, 40)) {
    const r = el.getBoundingClientRect()
    diag(DEBUG_TAG,
      `  <${el.tagName.toLowerCase()} class="${String(el.className || '').slice(0, 60)}" ` +
      `rect="${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}"> ` +
      `${(el.textContent || '').replace(/\s+/g, ' ').slice(0, 40)}`)
  }
}

/**
 * 开始调试采集：立即 dump 当前 DOM，并在窗口期内记录 DOM 变化与点击。
 * 结束后自动停止，日志以 DBG 标签批量上传。
 */
export function startDebugCapture(windowMs = DEFAULT_WINDOW_MS): void {
  dumpVisibleDialogs()

  const added: string[] = []
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue
        const el = n as Element
        const t = (el.textContent || '').replace(/\s+/g, ' ').slice(0, 30)
        const cls = String(el.className || '').slice(0, 50)
        if (added.length < 400) added.push(`+<${el.tagName.toLowerCase()} class="${cls}"> ${t}`)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })

  const clicks: string[] = []
  const onClick = (e: Event) => {
    const el = e.target as HTMLElement
    if (!el || !el.tagName) return
    if (String(el.className || '').startsWith('aah-')) return
    const r = el.getBoundingClientRect()
    const t = (el.textContent || '').replace(/\s+/g, ' ').slice(0, 30)
    if (clicks.length < 300) {
      clicks.push(
        `click <${el.tagName.toLowerCase()} class="${String(el.className || '').slice(0, 50)}" ` +
        `rect="${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}"> ${t}`,
      )
    }
  }
  document.addEventListener('click', onClick, true)

  diag(
    DEBUG_TAG,
    `调试记录中：${Math.round(windowMs / 1000)}s 内采集 DOM 变化与点击，请手动操作「发简历」流程`,
  )

  window.setTimeout(() => {
    observer.disconnect()
    document.removeEventListener('click', onClick, true)
    diag(DEBUG_TAG, `=== 调试结束：DOM 变化 ${added.length} 条 ===`)
    for (const line of added.slice(0, 400)) diag(DEBUG_TAG, `  ${line}`)
    diag(DEBUG_TAG, `=== 点击操作 ${clicks.length} 条 ===`)
    for (const line of clicks.slice(0, 300)) diag(DEBUG_TAG, `  ${line}`)
  }, windowMs)
}
