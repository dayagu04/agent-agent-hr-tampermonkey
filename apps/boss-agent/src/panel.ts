import './panel.css'
import { initializeNativeHost, nativePageCall, nativePageContext, nativePageNavigate, nativeSend } from './host-bridge'
import type { PanelLayout, UIHost, UIThread, UIThreadInfo, UIThreadRow } from '../../../packages/boss-core/src/ui-host'
import type { ToolResult } from '../../../packages/boss-core/src/tool-definitions'

const PAGE_ORIGIN = 'https://www.zhipin.com'
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
      type: 'aah.panel.geometry',
      collapsed: layout.collapsed,
      top: layout.position.top,
      right: layout.position.right,
      width: layout.collapsed ? 64 : Math.min(578, viewport.width),
      height: layout.collapsed ? 64 : Math.min(viewport.height, Math.ceil((size?.height || 80) + 16)),
    }, PAGE_ORIGIN)
  })
}

function receiveViewport(event: MessageEvent): void {
  if (event.source !== window.parent || event.origin !== PAGE_ORIGIN) return
  const data = event.data as { type?: unknown; width?: unknown; height?: unknown } | null
  if (data?.type !== 'aah.panel.viewport' || typeof data.width !== 'number' || typeof data.height !== 'number' ||
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
  if (window.parent === window || new URL(document.referrer).origin !== PAGE_ORIGIN) throw new Error('请在 BOSS 页面打开投递助手')
  window.addEventListener('message', receiveViewport)
  window.parent.postMessage({ type: 'aah.panel.ready' }, PAGE_ORIGIN)
  // Install credentials/configuration in this trusted extension context before evaluating core business modules.
  await initializeNativeHost()
  const [{ installNativeExecutionHost }, { installNativeChatDriver }] = await Promise.all([
    import('./native-execution'),
    import('./native-chat'),
  ])
  installNativeExecutionHost()
  installNativeChatDriver()
  const [{ installUIHost }, ledger, { loadConfig }] = await Promise.all([
    import('../../../packages/boss-core/src/ui-host'),
    import('../../../packages/boss-core/src/ledger'),
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
      const result = await nativePageCall<'ok' | 'not-found' | 'failed'>('ui.delete_thread', { company, jobTitle, identity }, `panel-delete:${crypto.randomUUID()}`)
      if (result === 'ok') {
        // MAIN reports only the observed deletion; the trusted host owns the durable backend mark.
        await ledger.queueConversationDeletedMark({ company, job_title: jobTitle, encrypt_job_id: identity.encryptJobId, reason: 'manual' })
        await ledger.removeMirrorByKey(company, jobTitle, identity)
        await ledger.flushConversationDeletedMarks(loadConfig())
      }
      return result
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

void bootstrap().catch(() => {
  const error = document.getElementById('aah-panel-error')!
  error.hidden = false
  error.textContent = '投递助手连接失败，请刷新 BOSS 页面后重试。'
  window.parent.postMessage({ type: 'aah.panel.geometry', collapsed: false, top: 80, right: 20, width: 320, height: 90 }, PAGE_ORIGIN)
})
