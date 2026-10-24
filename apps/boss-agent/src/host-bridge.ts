import { installPlatformRuntime } from '../../../packages/boss-core/src/platform-bridge'
import type { PluginConfig } from '../../../packages/boss-core/src/types'
import { apiPermissionPattern, DEFAULT_API_BASE, normalizeApiBase } from './native-platform'

export interface NativePageContext { url: string; visibility: string; navUnread: number }
let context: NativePageContext = { url: 'https://www.zhipin.com/', visibility: 'visible', navUnread: -1 }
let configuration = ''
let account = ''
let writes: Promise<void> = Promise.resolve()
let port: chrome.runtime.Port | null = null
let initialized = false
let retired = false
let pageGeneration = 0

export function nativePageContext(): NativePageContext { return context }
export async function nativeSend<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (retired) throw new Error('session_changed')
  if (type === 'boss.panel.cancel') pageGeneration += 1
  const captured = account
  const result = await rawSend<T>(type, payload, captured)
  if (retired || captured !== account) throw new Error('session_changed')
  return result
}
async function rawSend<T>(type: string, payload: Record<string, unknown>, scope: string): Promise<T> {
  const result = await chrome.runtime.sendMessage({ type, ...payload, account: scope })
  if (result?.transportError || (result?.ok === false && type !== 'boss.panel.tool')) throw new Error(result.error || 'native_request_failed')
  return result as T
}
export async function nativePageCall<T>(operation: string, args: Record<string, unknown> = {}, stableKey?: string): Promise<T> {
  const generation = pageGeneration
  await writes
  if (generation !== pageGeneration) throw new Error('execution_cancelled')
  return nativeSend<T>('boss.panel.page', { operation, args, stableKey: stableKey || `manual:${crypto.randomUUID()}` })
}
export async function nativePageNavigate(url: string): Promise<void> {
  const generation = pageGeneration
  await writes
  if (generation !== pageGeneration) throw new Error('execution_cancelled')
  await nativeSend('boss.panel.navigate', { url })
}
async function requestPermission(apiBase: string): Promise<void> {
  const origin = normalizeApiBase(apiBase)
  if (origin !== DEFAULT_API_BASE && !await chrome.permissions.contains({ origins: [apiPermissionPattern(origin)] })) {
    if (!await chrome.permissions.request({ origins: [apiPermissionPattern(origin)] })) throw new Error('请授权扩展连接此后端地址')
  }
}
function surfaceError(error: unknown): void {
  window.dispatchEvent(new CustomEvent('aah:native-error', { detail: error instanceof Error ? error.message : '扩展连接失败' }))
}

/** Installed before importing App or evaluating any shared controller. No old remote loop runs here. */
export async function initializeNativeHost(): Promise<void> {
  if (initialized) return
  const boot = await nativeSend<{ config: Partial<PluginConfig>; account: string; context: NativePageContext; interrupted: boolean }>('boss.panel.bootstrap')
  configuration = JSON.stringify(boot.config)
  account = boot.account
  context = boot.context
  installPlatformRuntime({
    configuration: {
      get: (key, fallback) => key === 'aah_plugin_config' ? configuration || fallback : fallback,
      set(key, value) {
        if (key !== 'aah_plugin_config') throw new Error('configuration_key_forbidden')
        if (retired) throw new Error('session_changed')
        const previous = JSON.parse(configuration || '{}') as Partial<PluginConfig>
        const next = JSON.parse(value) as PluginConfig
        const identityChanged = previous.token !== next.token || previous.apiBase !== next.apiBase || previous.resumeId !== next.resumeId
        const scope = account
        // Permission request begins in the Token/settings user gesture, before asynchronous persistence.
        const permission = identityChanged && next.token ? requestPermission(next.apiBase) : Promise.resolve()
        if (identityChanged) retired = true
        configuration = value
        writes = writes.catch(() => undefined).then(async () => {
          await permission
          const saved = await rawSend<{ account: string; config: PluginConfig }>('boss.panel.config', { config: next }, scope)
          account = saved.account
          configuration = JSON.stringify(saved.config)
          if (identityChanged) location.reload()
        })
        void writes.catch(error => {
          surfaceError(error)
          // Failed authentication/permission must allow another attempt with committed configuration.
          // Retire the old controller permanently; a fresh iframe reads the background's current identity.
          if (identityChanged) setTimeout(() => location.reload(), 1500)
        })
      },
    },
    storage: {
      get: async <T>(key: string, fallback: T) => { await writes; return nativeSend<T>('boss.panel.storage', { action: 'get', key, fallback }) },
      set: async (key, value) => { await writes; await nativeSend('boss.panel.storage', { action: 'set', key, value }) },
      remove: async key => { await writes; await nativeSend('boss.panel.storage', { action: 'remove', key }) },
      clear: async () => { await writes; await nativeSend('boss.panel.storage', { action: 'clear' }) },
    },
    network: { request: async options => {
      // This runs in the extension iframe: the user gesture remains local for optional permissions.
      const path = new URL(options.url)
      if (path.pathname === '/api/auth/login') await requestPermission(path.origin)
      await writes
      return nativeSend('boss.panel.network', { options })
    } },
    notification: { notify: (title, message) => { void nativeSend('boss.panel.notify', { title, message }).catch(surfaceError) } },
  })
  port = chrome.runtime.connect({ name: 'boss.panel' })
  port.onMessage.addListener((message: Record<string, unknown>) => {
    if (message.type === 'context') context = message.context as NativePageContext
    if (message.type === 'reload') { retired = true; location.reload() }
    if (message.type === 'preferences' && !retired) {
      void import('../../../packages/boss-core/src/config').then(({ loadConfig, applyPluginPreferences, saveConfig }) => {
        const before = loadConfig(); const next = applyPluginPreferences(before, message.preferences as Record<string, unknown>)
        if (JSON.stringify(next) !== JSON.stringify(before)) saveConfig(next)
      }).catch(surfaceError)
    }
    if (message.type === 'suspend') {
      pageGeneration += 1
      void import('../../../packages/boss-core/src/orchestrator').then(async module => {
        const { loadConfig } = await import('../../../packages/boss-core/src/config')
        await module.getOrchestrator(loadConfig()).pause(String(message.reason || '执行端已暂停'))
      }).catch(surfaceError)
    }
    if (message.type === 'command') {
      const command = message.command as { action?: string; payload?: { action?: string } }
      if (['orchestrator.stop', 'orchestrator.pause'].includes(command?.action || '') ||
          (command?.action === 'orchestrator.action' && ['stop', 'pause'].includes(command.payload?.action || ''))) pageGeneration += 1
      const scope = String(message.key)
      void (async () => {
        await writes
        const { executeRemoteCommand } = await import('../../../packages/boss-core/src/remote')
        const { loadConfig } = await import('../../../packages/boss-core/src/config')
        const accepted = await executeRemoteCommand(loadConfig(), message.command as import('../../../packages/boss-core/src/remote').RemoteCommand)
        await writes
        port?.postMessage({ type: 'command.result', key: scope, accepted })
      })().catch(() => port?.postMessage({ type: 'command.result', key: scope, accepted: false }))

    }
  })
  port.onDisconnect.addListener(() => {
    retired = true
    // Worker eviction must not leave the old controller producing actions under a lost lease.
    void import('../../../packages/boss-core/src/orchestrator').then(async module => {
      const { loadConfig } = await import('../../../packages/boss-core/src/config')
      await module.getOrchestrator(loadConfig()).pause('扩展后台已重启，请确认进度后恢复')
    }).catch(() => undefined)
    setTimeout(() => location.reload(), 1500)
  })
  if (boot.interrupted) {
    const snapshot = await nativeSend<Record<string, unknown> | null>('boss.panel.storage', { action: 'get', key: 'aah_orchestrator_state', fallback: null })
    if (snapshot) await nativeSend('boss.panel.storage', { action: 'set', key: 'aah_orchestrator_state', value: { ...snapshot, phase: 'paused', pendingAction: null } })
  }
  let reporting = false
  setInterval(() => {
    if (reporting || retired) return
    reporting = true
    void (async () => {
      const { getOrchestrator, getCurrentJob, flushOrchestratorEvents } = await import('../../../packages/boss-core/src/orchestrator')
      const { loadConfig } = await import('../../../packages/boss-core/src/config')
      const cfg = loadConfig()
      const orch = getOrchestrator(cfg)
      const live = orch.getState()
      port?.postMessage({ type: 'state', state: { phase: live?.phase || 'idle', running: orch.isRunning(), stats: live?.stats || {}, runId: live?.runId || null, keyword: live?.keywords[live.currentKeywordIndex] || '', page: live?.currentPage || 1, startedAt: live?.startedAt || null, goalTarget: live?.goal.target ?? null, currentJob: getCurrentJob() } })
      if (cfg.token && cfg.resumeId) await flushOrchestratorEvents(cfg)
    })().catch(surfaceError).finally(() => { reporting = false })
  }, 1000)
  initialized = true
}
