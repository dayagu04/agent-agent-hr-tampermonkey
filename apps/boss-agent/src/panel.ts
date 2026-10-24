import './panel.css'
import { initializeNativeHost, nativePageCall, nativePageContext, nativePageNavigate, nativeSend } from './host-bridge'
import { readUIDeleteResult } from './core-operation-contract'
import type { PanelLayout, UIHost, UIThread, UIThreadInfo, UIThreadRow } from '../../../packages/boss-core/src/ui-host'
import type { ToolResult } from '../../../packages/boss-core/src/tool-definitions'

const PAGE_ORIGIN = 'https://www.zhipin.com'
const geometryKey = location.hash.slice(1)
let viewport = { width: 1024, height: 768 }
let layout: PanelLayout = { collapsed: true, position: { top: 80, right: 20 } }
let observer: ResizeObserver | undefined
let geometryFrame = 0

function sendGeometry(): void {
  cancelAnimationFrame(geometryFrame)
  geometryFrame = requestAnimationFrame(() => {
    const root = document.querySelector<HTMLElement>('.aah-root')
    const size = root?.getBoundingClientRect()
    window.parent.postMessage({
      type: 'aah.panel.geometry', key: geometryKey,
      collapsed: layout.collapsed,
      top: layout.position.top,
      right: layout.position.right,
      width: layout.collapsed ? 64 : Math.min(578, viewport.width),
      height: layout.collapsed ? 64 : Math.min(viewport.height, Math.ceil((size?.height || 80) + 16)),
    }, PAGE_ORIGIN)
  })
}

function receiveViewport(event: MessageEvent): void {
  if ((event.source !== null && event.source !== window.parent) || event.origin !== PAGE_ORIGIN) return
  const data = event.data as { type?: unknown; key?: unknown; width?: unknown; height?: unknown } | null
  if (data?.key !== geometryKey || data.type !== 'aah.panel.viewport' || typeof data.width !== 'number' || typeof data.height !== 'number' ||
      !Number.isFinite(data.width) || !Number.isFinite(data.height) || data.width < 1 || data.height < 1) return
  const next = { width: Math.min(20000, data.width), height: Math.min(20000, data.height) }
  if (next.width === viewport.width && next.height === viewport.height) return
  viewport = next
  document.documentElement.style.setProperty('--aah-page-height', `${viewport.height}px`)
  document.documentElement.style.setProperty('--aah-flow-height', `${Math.max(48, viewport.height * 0.72)}px`)
  window.dispatchEvent(new Event('resize'))
  sendGeometry()
}

async function bootstrap(): Promise<void> {
  // Chrome can omit an extension iframe's referrer. The background validates the actual parent document.
  if (window.parent === window || window.parent !== window.top) throw new Error('panel_requires_boss_parent')
  window.addEventListener('message', receiveViewport)
  window.parent.postMessage({ type: 'aah.panel.ready', key: geometryKey }, PAGE_ORIGIN)
  // Install credentials/configuration in this trusted extension context before evaluating core business modules.
  await initializeNativeHost()
  const [{ installNativeExecutionHost }, { installNativeChatDriver }] = await Promise.all([
    import('./native-execution'),
    import('./native-chat'),
  ])
  installNativeExecutionHost()
  installNativeChatDriver()
  const [{ installUIHost }, { recordConversationDeleted }, { loadConfig }] = await Promise.all([
    import('../../../packages/boss-core/src/ui-host'),
    import('../../../packages/boss-core/src/platforms/chat-runner'),
    import('../../../packages/boss-core/src/config'),
  ])
  const host: UIHost = {
    platform: () => ({ name: 'BOSS直聘', chatUrl: `${PAGE_ORIGIN}/web/geek/chat` }),
    pageUrl: () => nativePageContext().url,
    navUnread: () => ({ count: nativePageContext().navUnread, via: 'native-page', probe: '-' }),
    viewport: () => viewport,
    layout(next) { layout = next; sendGeometry() },
    listThreads: () => nativePageCall<UIThread[]>('ui.list_threads'),
    threadRows: () => nativePageCall<UIThreadRow[]>('ui.thread_rows'),
    currentThreadInfo: () => nativePageCall<UIThreadInfo>('ui.current_thread_info'),
    openThread: (company, jobTitle) => nativePageCall('ui.open_thread', { company, jobTitle }),
    async deleteThread(company, jobTitle, identity) {
      const result = readUIDeleteResult(await nativePageCall('ui.delete_thread', { company, jobTitle, identity }, `panel-delete:${crypto.randomUUID()}`))
      if (result.status === 'ok') {
        // MAIN reports only the observed deletion; the trusted host owns the durable backend mark.
        const target = result.target
        await recordConversationDeleted(loadConfig(), target.company, target.jobTitle, 'manual', target)
      }
      return result.status
    },
    navigate: nativePageNavigate,
    async probeSearchFilters(reason) { await nativePageCall('ui.probe_search_filters', { reason }) },
    async toolSpecs() { return (await import('../../../packages/boss-core/src/tools')).toolSpecs() },
    callTool: (name, args) => nativeSend<ToolResult>('boss.panel.tool', { name, args }),
  }
  installUIHost(host)
  const [{ createApp }, { default: App }] = await Promise.all([
    import('vue'),
    import('../../../packages/boss-core/src/App.vue'),
  ])
  const app = createApp(App)
  app.mount('#aah-plugin-root')
  const root = document.querySelector('.aah-root')
  observer = new ResizeObserver(sendGeometry)
  if (root) observer.observe(root)
  sendGeometry()
  window.addEventListener('pagehide', () => { observer?.disconnect(); app.unmount() }, { once: true })
}

void bootstrap().catch(reason => {
  const error = document.getElementById('aah-panel-error')!
  error.hidden = false
  const code = reason instanceof Error && /^[a-z][a-z0-9_]{1,63}$/.test(reason.message) ? reason.message : 'panel_bootstrap_failed'
  error.textContent = `投递助手连接失败（${code}），请重新加载扩展后重试。`
  window.parent.postMessage({ type: 'aah.panel.geometry', key: geometryKey, collapsed: false, top: 80, right: 20, width: 320, height: 90 }, PAGE_ORIGIN)
})
