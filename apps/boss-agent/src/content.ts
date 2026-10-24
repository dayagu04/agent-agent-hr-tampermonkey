import { detectNavUnread } from '../../../packages/boss-core/src/nav-unread'
import { BossContentHeartbeat } from './runtime-content'
import { VERSION } from '../../../packages/boss-core/src/version'

interface ContentOwner { version: string; alive(): boolean; wake(): void; dispose(): void }
const OWNER_KEY = '__aahNativeContentOwnerV1'
const owners = globalThis as unknown as Record<string, ContentOwner | undefined>

function attachContent(): void {
  if (window.top !== window || location.origin !== 'https://www.zhipin.com') return
  const previous = owners[OWNER_KEY]
  if (previous?.version === VERSION && previous.alive()) { previous.wake(); return }
  previous?.dispose()

  // This isolated script owns only the frame geometry and the existing lifecycle heartbeat.
  // Credentials and business messages use extension runtime messaging inside panel.html.
  const host = document.createElement('div')
  host.id = 'aah-native-host'
  host.dataset.extension = chrome.runtime.id
  host.style.setProperty('display', 'contents', 'important')
  const shadow = host.attachShadow({ mode: 'closed' })
  const panel = document.createElement('iframe')
  const panelOrigin = chrome.runtime.getURL('').replace(/\/$/, '')
  const geometryKey = crypto.randomUUID()
  panel.src = chrome.runtime.getURL('panel.html') + '#' + geometryKey
  panel.title = 'BOSS 智能投递助手'
  panel.id = 'aah-native-panel'
  panel.setAttribute('referrerpolicy', 'origin')
  Object.assign(panel.style, {
    position: 'fixed', top: '72px', right: '12px', width: '64px', height: '64px',
    border: '0', background: 'transparent', zIndex: '2147483647', colorScheme: 'light',
  })
  shadow.appendChild(panel)
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
    panel.contentWindow?.postMessage({ type: 'aah.panel.viewport', key: geometryKey, width: window.innerWidth, height: window.innerHeight }, '*')
  }
  function receiveGeometry(event: MessageEvent): void {
    // Privileged extension frames may expose a null MessageEvent.source. Geometry carries no authority.
    if ((event.source !== null && event.source !== panel.contentWindow) || event.origin !== panelOrigin) return
    const data = event.data as Record<string, unknown> | null
    if (!data || typeof data !== 'object' || data.key !== geometryKey) return
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
  }
  function resize(): void { placePanel(); sendViewport() }
  window.addEventListener('message', receiveGeometry)
  window.addEventListener('resize', resize)
  function mountPanel(): void { if (!host.isConnected) (document.body || document.documentElement).appendChild(host) }
  // Remove only this extension's obsolete iframe after an extension reload.
  for (const old of document.querySelectorAll<HTMLIFrameElement>('iframe#aah-native-panel')) {
    if (old.src.split('#')[0] === chrome.runtime.getURL('panel.html')) old.remove()
  }
  for (const old of document.querySelectorAll<HTMLElement>('#aah-native-host')) {
    if (old.dataset.extension === chrome.runtime.id) old.remove()
  }
  mountPanel()

  const heartbeat = new BossContentHeartbeat({ runtime: chrome.runtime, visibility: () => document.visibilityState, navUnread: () => detectNavUnread().count })
  const receiveWake: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message: unknown, sender, reply) => {
    if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'boss.wake') return false
    void heartbeat.wake(message, sender).then(reply, () => reply({ runnable: false }))
    return true
  }
  chrome.runtime.onMessage.addListener(receiveWake)
  // Native ticks restore the connection after navigation. Hidden-page cadence is provided by real background wake messages.
  const tick = () => {
    if (!chrome.runtime.id) { owner.dispose(); return }
    void heartbeat.tick()
  }
  const resume = () => { void heartbeat.resume() }
  const freeze = () => { void heartbeat.freeze() }
  const timer = setInterval(tick, 10_000)
  document.addEventListener('visibilitychange', tick)
  document.addEventListener('freeze', freeze)
  document.addEventListener('resume', resume)
  window.addEventListener('pageshow', resume)
  window.addEventListener('focus', tick)
  const owner: ContentOwner = {
    version: VERSION,
    alive: () => !!chrome.runtime.id && panel.isConnected,
    wake: tick,
    dispose() {
      clearInterval(timer)
      window.removeEventListener('message', receiveGeometry)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', tick)
      document.removeEventListener('freeze', freeze)
      document.removeEventListener('resume', resume)
      window.removeEventListener('pageshow', resume)
      window.removeEventListener('focus', tick)
      try { chrome.runtime.onMessage.removeListener(receiveWake) } catch { /* previous extension context is invalid */ }
      host.remove()
      if (owners[OWNER_KEY] === owner) delete owners[OWNER_KEY]
    },
  }
  owners[OWNER_KEY] = owner
  tick()
}

attachContent()
