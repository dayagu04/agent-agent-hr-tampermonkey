import { detectNavUnread } from '../../../packages/boss-core/src/nav-unread'
import { BossContentHeartbeat } from './runtime-content'

// This isolated script owns only the frame geometry and the existing lifecycle heartbeat.
// Credentials and business messages use extension runtime messaging inside panel.html.
const panel = document.createElement('iframe')
const panelOrigin = chrome.runtime.getURL('').replace(/\/$/, '')
panel.src = chrome.runtime.getURL('panel.html')
panel.title = 'BOSS 智能投递助手'
panel.id = 'aah-native-panel'
panel.setAttribute('referrerpolicy', 'origin')
Object.assign(panel.style, {
  position: 'fixed', top: '72px', right: '12px', width: '64px', height: '64px',
  border: '0', background: 'transparent', zIndex: '2147483647', colorScheme: 'light',
})
let frameGeometry = { top: 80, right: 20, width: 64, height: 64 }
function placePanel(): void {
  const width = Math.min(frameGeometry.width, window.innerWidth)
  const height = Math.min(frameGeometry.height, window.innerHeight)
  Object.assign(panel.style, {
    width: `${width}px`, height: `${height}px`,
    top: `${Math.max(0, Math.min(frameGeometry.top - 8, window.innerHeight - 64))}px`,
    right: `${Math.max(0, Math.min(frameGeometry.right - 8, window.innerWidth - width))}px`,
  })
}
function sendViewport(): void {
  panel.contentWindow?.postMessage({ type: 'aah.panel.viewport', width: window.innerWidth, height: window.innerHeight }, panelOrigin)
}
window.addEventListener('message', event => {
  if (event.source !== panel.contentWindow || event.origin !== panelOrigin) return
  const data = event.data as Record<string, unknown> | null
  if (!data || typeof data !== 'object') return
  if (data.type === 'aah.panel.ready') { sendViewport(); return }
  if (data.type !== 'aah.panel.geometry' || typeof data.collapsed !== 'boolean' ||
      !['top', 'right', 'width', 'height'].every(key => typeof data[key] === 'number' && Number.isFinite(data[key]))) return
  frameGeometry = {
    top: Math.max(0, Math.min(20000, data.top as number)),
    right: Math.max(0, Math.min(20000, data.right as number)),
    width: data.collapsed ? 64 : Math.max(64, Math.min(578, data.width as number)),
    height: data.collapsed ? 64 : Math.max(64, Math.min(window.innerHeight, data.height as number)),
  }
  placePanel()
})
window.addEventListener('resize', () => { placePanel(); sendViewport() })
function mountPanel(): void { if (!panel.isConnected) (document.body || document.documentElement).appendChild(panel) }
mountPanel()

const heartbeat = new BossContentHeartbeat({ runtime: chrome.runtime, visibility: () => document.visibilityState, navUnread: () => detectNavUnread().count })
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'boss.wake') return false
  void heartbeat.wake(message, sender).then(reply, () => reply({ runnable: false }))
  return true
})
// Native ticks restore the connection after navigation. Hidden-page cadence is provided by real background wake messages.
setInterval(() => { void heartbeat.tick() }, 10_000)
document.addEventListener('visibilitychange', () => { void heartbeat.tick() })
document.addEventListener('freeze', () => { void heartbeat.freeze() })
document.addEventListener('resume', () => { void heartbeat.resume() })
window.addEventListener('pageshow', () => { void heartbeat.resume() })
window.addEventListener('focus', () => { void heartbeat.tick() })
void heartbeat.tick()
