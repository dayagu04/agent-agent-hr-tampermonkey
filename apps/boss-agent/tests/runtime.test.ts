// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { attachExistingBossPages, BossHeartbeatScheduler, RECOVERY_ALARM } from '../src/background-scheduler'
import { BossContentHeartbeat } from '../src/runtime-content'
import { BossRuntime, STORAGE_KEY } from '../src/runtime'
import { PAGE_RUNTIME_KEY, type PageExecution, type PageInvocation } from '../src/contracts'

const API = 'https://gudaya.chat'
const ACCOUNT = `${API}|1`
const TOKEN = 'old-account-auth-token-long-value'
const popup = { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' } as chrome.runtime.MessageSender
const page = { id: 'extension-id', frameId: 0, documentLifecycle: 'active', documentId: 'doc-1', url: 'https://www.zhipin.com/web/geek/chat', tab: { id: 12, url: 'https://www.zhipin.com/web/geek/chat' } } as chrome.runtime.MessageSender
const panel = { ...page, frameId: 3, documentId: 'panel-doc-1', url: 'chrome-extension://extension-id/panel.html' } as chrome.runtime.MessageSender
const command = (id = 8, name = 'send_message', args: Record<string, unknown> = { text: 'message' }) => ({ id, action: 'tool.call', payload: { name, args } })
const heartbeat = (commands: unknown[]) => ({ command_epoch: 'db-outbox-v2', plugin_compatibility: { can_receive_commands: true }, commands })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness(accounts: Record<string, unknown> = {}) {
  let disk: Record<string, unknown> = { [STORAGE_KEY]: {
    config: { apiBase: API, token: TOKEN, userId: 1, username: 'user-one', resumeId: 7, defaultResumeName: '', enabled: true, tabId: 12 }, accounts,
  } }
  let time = 1000
  let permission = true
  const accesses: unknown[] = []
  const calls: Array<{ path: string; body: Record<string, unknown>; token: string }> = []
  const pageCalls: PageInvocation[] = []
  const navigations: unknown[] = []
  const cancellations: unknown[][] = []
  let epoch = 0
  let beforeInvocation: () => Promise<void> = async () => undefined
  let onPage: (invocation: PageInvocation, method: string) => Promise<unknown> = async () => ({ result: { ok: true, data: { delivery: 'delivered' } } })
  let onRequest: (path: string, body: Record<string, unknown>) => Promise<unknown> = async path => path.endsWith('/heartbeat') ? heartbeat([]) : { stored: true }
  const chromeMock = {
    runtime: { id: 'extension-id', getURL: (path: string) => `chrome-extension://extension-id/${path}`, getManifest: () => ({ version: '0.7.0' }) },
    storage: { local: {
      setAccessLevel: async (value: unknown) => { accesses.push(value) },
      get: async () => structuredClone(disk),
      set: async (value: Record<string, unknown>) => { disk = { ...disk, ...structuredClone(value) } },
      remove: async (names: string | string[]) => { for (const name of Array.isArray(names) ? names : [names]) delete disk[name] },
    } },
    permissions: { contains: async () => permission },
    webNavigation: { getFrame: async ({ frameId }: { frameId: number }) => frameId === 0
      ? { documentId: page.documentId, url: page.url, parentFrameId: -1 }
      : { documentId: panel.documentId, url: panel.url, parentFrameId: 0 } },
    tabs: { get: async (id: number) => ({ id, url: 'https://www.zhipin.com/web/geek/chat' }), update: async (...args: unknown[]) => { navigations.push(args) }, reload: async (...args: unknown[]) => { navigations.push(args) } },
    scripting: { executeScript: async (details: { files?: string[]; args?: unknown[]; func?: (...args: unknown[]) => unknown; target: { tabId: number; documentIds: string[] } }) => {
      expect(details.target).toEqual({ tabId: 12, documentIds: ['doc-1'] })
      if (details.files) return []
      if (details.args?.length === 2) { cancellations.push(details.args); return [] }
      if ((details.args?.length ?? 0) > 2) await beforeInvocation()
      const invoke = async (invocation: PageInvocation, method: string) => {
        pageCalls.push(structuredClone(invocation))
        return onPage(invocation, method)
      }
      const globals = globalThis as unknown as Record<string, unknown>
      const previous = globals[PAGE_RUNTIME_KEY]
      globals[PAGE_RUNTIME_KEY] = { lifecycleEpoch: () => epoch, run: (invocation: PageInvocation) => invoke(invocation, 'run'), prepare: (invocation: PageInvocation) => invoke(invocation, 'prepare') }
      let result: unknown
      try { result = details.func!(...(details.args || [])) }
      finally { if (previous === undefined) delete globals[PAGE_RUNTIME_KEY]; else globals[PAGE_RUNTIME_KEY] = previous }
      return [{ result: await result }]
    } },
  } as unknown as typeof chrome
  const fetchMock = (async (url: string | URL | Request, options: RequestInit) => {
    const path = new URL(String(url)).pathname
    const body = options.body ? JSON.parse(String(options.body)) : {}
    calls.push({ path, body, token: String((options.headers as Record<string, string>).Authorization || '') })
    const data = await onRequest(path, body)
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return {
    chrome: chromeMock,
    create: () => new BossRuntime({ chrome: chromeMock, fetch: fetchMock, now: () => time }),
    disk: () => disk[STORAGE_KEY] as { config: unknown; accounts: Record<string, { ack: number; receipts: Record<string, { state: string; result?: { error?: string }; uploaded: boolean }> }> },
    accesses, calls, pageCalls, navigations, cancellations,
    port: () => {
      const messages: Record<string, unknown>[] = []
      let receive: (value: unknown) => void = () => {}
      let disconnect: () => void = () => {}
      const port = { name: 'boss.panel', sender: panel, postMessage: (value: Record<string, unknown>) => messages.push(value), disconnect: () => disconnect(),
        onMessage: { addListener: (listener: typeof receive) => { receive = listener } },
        onDisconnect: { addListener: (listener: typeof disconnect) => { disconnect = listener } } } as unknown as chrome.runtime.Port
      return { port, messages, send: (value: unknown) => receive(value), disconnect: () => disconnect() }
    },
    advance: (milliseconds = 1000) => { time += milliseconds }, denyPermission: () => { permission = false },
    changeEpoch: () => { epoch += 1 }, beforeInvocation: (handler: typeof beforeInvocation) => { beforeInvocation = handler },
    request: (handler: typeof onRequest) => { onRequest = handler }, page: (handler: typeof onPage) => { onPage = handler },
  }
}

describe('MV3 production message dispatcher persistence and trust', () => {
  it('retries a failed result upload after worker restart without repeating the page action or accounting effect', async () => {
    const h = harness()
    let failUpload = true
    h.request(async path => {
      if (path.endsWith('/heartbeat')) return heartbeat([command(8, 'apply_job', { jobId: 'job-1' })])
      if (path.endsWith('/greeting')) return { greeting: 'hello' }
      if (path.endsWith('/tools/result') && failUpload) { failUpload = false; throw new Error('offline') }
      return { stored: true, success: true }
    })
    h.page(async (_invocation, method) => method === 'prepare' ? { ok: true, data: { job: { platformJobId: 'job-1', title: 'role' } } } : ({ result: { ok: true, data: { delivery: 'delivered' } }, effects: [{ kind: 'application', payload: { platform: 'zhipin', platform_job_id: 'job-1', title: 'role', outcome: 'applied' } }] } satisfies PageExecution))
    await h.create().handle({ type: 'boss.tick', visibility: 'visible' }, page)
    expect(h.disk().accounts[ACCOUNT].ack).toBe(8)
    expect(h.disk().accounts[ACCOUNT].receipts['db-outbox-v2:8'].uploaded).toBe(false)

    const native = harness()
    const started = deferred<void>()
    const pending = deferred<unknown>()
    native.page(async () => { started.resolve(); return pending.promise })
    const nativeRuntime = native.create()
    await nativeRuntime.handle({ type: 'boss.panel.bootstrap' }, panel)
    const action = nativeRuntime.handle({ type: 'boss.panel.page', account: ACCOUNT, operation: 'platform.apply_job', args: { jobId: 'job-1', greeting: 'hello' }, stableKey: 'apply-1' }, panel)
    const rejected = expect(action).rejects.toThrow('reconciliation_required')
    await started.promise
    await nativeRuntime.handle({ type: 'boss.panel.config', account: ACCOUNT, config: { apiBase: API, token: '', resumeId: null } }, panel)
    await rejected
    expect(native.cancellations).not.toHaveLength(0)
    await expect(nativeRuntime.handle({ type: 'boss.panel.storage', action: 'set', key: 'aah_orchestrator_state', value: {}, account: ACCOUNT }, panel)).rejects.toThrow('session_changed')
    pending.resolve({ result: { ok: true, data: { outcome: 'applied' } } })
    h.advance()
    await h.create().handle({ type: 'boss.tick', visibility: 'visible' }, page)
    expect(h.pageCalls.filter(call => call.context?.greeting)).toHaveLength(1)
    expect(h.calls.filter(call => call.path.endsWith('/record'))).toHaveLength(1)
    expect(h.calls.filter(call => call.path.endsWith('/record'))[0].body.resume_id).toBe(7)
    expect(h.calls.filter(call => call.path.endsWith('/tools/result'))).toHaveLength(2)
    expect(h.disk().accounts[ACCOUNT].receipts['db-outbox-v2:8'].uploaded).toBe(true)
    expect(h.accesses).toContainEqual({ accessLevel: 'TRUSTED_CONTEXTS' })
    expect(JSON.stringify(h.pageCalls)).not.toContain(TOKEN)

    // The new full-panel page entry shares durable receipts, including across worker recovery.
    const core = harness()
    core.page(async () => ({ result: { ok: true, data: 'ok' } }))
    let host = core.create()
    await host.handle({ type: 'boss.panel.bootstrap' }, panel)
    const deletion = { type: 'boss.panel.page', account: ACCOUNT, operation: 'ui.delete_thread', args: { company: 'company' }, stableKey: 'manual-delete-1' }
    expect(await host.handle(deletion, panel)).toBe('ok')
    host = core.create()
    await host.handle({ type: 'boss.panel.bootstrap' }, panel)
    expect(await host.handle(deletion, panel)).toBe('ok')
    expect(core.pageCalls).toHaveLength(1)
    await expect(host.handle({ ...deletion, args: { company: 'other' } }, panel)).rejects.toThrow('command_key_conflict')
    expect(JSON.stringify(core.pageCalls)).not.toContain(TOKEN)

    // A long core command must not keep a later stop/pause from reaching the controller.
    const controls = harness()
    const controller = controls.create()
    await controller.handle({ type: 'boss.panel.bootstrap' }, panel)
    const channel = controls.port()
    await controller.attachPanel(channel.port)
    let releasePage!: (result: unknown) => void
    let startedPage!: () => void
    const pageStarted = new Promise<void>(resolve => { startedPage = resolve })
    controls.page(async () => { startedPage(); return new Promise(resolve => { releasePage = resolve }) })
    const pendingAction = controller.handle({ type: 'boss.panel.page', account: ACCOUNT, operation: 'platform.apply_job', args: { jobId: 'job-1', greeting: 'test' }, stableKey: 'run:job-1' }, panel).then(() => '', error => error.message)
    await pageStarted
    const work = { id: 8, action: 'orchestrator.action', payload: { action: 'apply_batch' } }
    controls.request(async path => path.endsWith('/heartbeat') ? heartbeat([work]) : { stored: true })
    await controller.handle({ type: 'boss.tick' }, page)
    expect(channel.messages.filter(message => message.type === 'command')).toHaveLength(1)
    const queuedActions = [
      { operation: 'chat.send', args: { text: 'reply', expectedThread: 'thread-1' } },
      { operation: 'chat.resume', args: { resumeName: null, expectedThread: 'thread-1' } },
      { operation: 'chat.card', args: { card: { key: 'card-1', kind: 'resume_request', question: '', canAccept: true, canReject: true }, accept: true, expectedThread: 'thread-1', resumeName: null } },
    ].map(action => controller.handle({ type: 'boss.panel.page', account: ACCOUNT, ...action, stableKey: action.operation }, panel).then(() => '', error => error.message))
    const stop = { id: 9, action: 'orchestrator.stop', payload: {} }
    controls.request(async path => path.endsWith('/heartbeat') ? heartbeat([work, stop]) : { stored: true })
    controls.advance()
    await controller.handle({ type: 'boss.tick' }, page)
    expect(channel.messages.filter(message => message.type === 'command').map(message => (message.command as { id: number }).id)).toEqual([8, 9])
    expect(controls.disk().accounts[ACCOUNT].ack).toBe(0)
    expect(await pendingAction).toBe('reconciliation_required')
    expect(await Promise.all(queuedActions)).toEqual(Array(3).fill('page_execution_cancelled'))
    expect(controls.pageCalls).toHaveLength(1)
    expect(await controller.handle({ type: 'boss.panel.network', account: ACCOUNT, options: { method: 'POST', url: `${API}/api/plugin/orchestrator/event`, data: JSON.stringify({ event: 'stopped', event_id: 'stop-9' }) } }, panel)).toMatchObject({ status: 200 })
    releasePage({ result: { ok: true } })
    channel.send({ type: 'command.result', key: 'db-outbox-v2:8', accepted: false })
    channel.send({ type: 'command.result', key: 'db-outbox-v2:9', accepted: true })
    // The cancelled batch may also finish late; it must not undo the confirmed stop.
    channel.send({ type: 'command.result', key: 'db-outbox-v2:8', accepted: false })
    controls.advance()
    await controller.handle({ type: 'boss.tick' }, page)
    expect(controls.disk().accounts[ACCOUNT].ack).toBe(9)

    // Calls already received before stop must also be fenced while validating the frame or saving a receipt.
    for (const payload of [
      { type: 'boss.panel.page', operation: 'chat.send', args: { text: 'reply', expectedThread: 'thread-1' }, stableKey: 'late-send' },
      { type: 'boss.panel.navigate', url: 'https://www.zhipin.com/web/geek/job' },
    ]) {
      const late = harness()
      const runtime = late.create()
      await runtime.handle({ type: 'boss.panel.bootstrap' }, panel)
      const checkingFrame = deferred<void>(), releaseFrame = deferred<void>()
      const getFrame = late.chrome.webNavigation.getFrame
      let holdFrame = true
      late.chrome.webNavigation.getFrame = (async (details: Parameters<typeof getFrame>[0]) => {
        if (holdFrame) { holdFrame = false; checkingFrame.resolve(); await releaseFrame.promise }
        return getFrame(details)
      }) as typeof getFrame
      const beforeQueue = runtime.handle({ ...payload, account: ACCOUNT }, panel).then(() => '', error => error.message)
      await checkingFrame.promise
      await runtime.handle({ type: 'boss.panel.cancel', account: ACCOUNT }, panel)
      releaseFrame.resolve()
      expect(await beforeQueue).toBe('page_execution_cancelled')

      const savingReceipt = deferred<void>(), releaseSave = deferred<void>()
      const set = late.chrome.storage.local.set
      let holdSave = true
      late.chrome.storage.local.set = (async (value: Record<string, unknown>) => {
        if (holdSave) { holdSave = false; savingReceipt.resolve(); await releaseSave.promise }
        return set(value)
      }) as typeof set
      const beforeLease = runtime.handle({ ...payload, account: ACCOUNT }, panel).then(() => '', error => error.message)
      await savingReceipt.promise
      await runtime.handle({ type: 'boss.panel.cancel', account: ACCOUNT }, panel)
      releaseSave.resolve()
      expect(await beforeLease).toBe(payload.type === 'boss.panel.page' ? 'reconciliation_required' : 'page_execution_cancelled')
      expect(late.pageCalls).toHaveLength(0)
      expect(late.navigations).toHaveLength(0)
    }
  })

  it('turns a persisted started command into reconciliation evidence and leaves an unknown action unacknowledged', async () => {
    const h = harness({ [ACCOUNT]: { epoch: 'db-outbox-v2', ack: 0, receipts: {
      'db-outbox-v2:8': { commandId: 8, epoch: 'db-outbox-v2', tool: 'send_message', state: 'started', irreversible: true, uploaded: false, effects: [] },
    } } })
    h.request(async path => path.endsWith('/heartbeat') ? heartbeat([command(), { id: 9, action: 'unknown.action', payload: {} }, command(10)]) : { stored: true })
    const result = await h.create().handle({ type: 'boss.tick' }, page)
    expect(result).toMatchObject({ ok: true })
    expect(h.pageCalls).toHaveLength(0)
    expect(h.disk().accounts[ACCOUNT].ack).toBe(8)
    const upload = h.calls.find(call => call.path.endsWith('/tools/result'))!
    expect(upload.body).toMatchObject({ command_id: 8, ok: false, error: 'reconciliation_required', data: { retrySafe: false, mayHaveExecuted: true } })

    const stalled = harness({ [ACCOUNT]: { epoch: 'db-outbox-v2', ack: 8, receipts: {}, navigation: { tabId: 12, fromDocumentId: 'doc-1', startedAt: 0 } } })
    stalled.advance(31_000)
    stalled.request(async path => path.endsWith('/heartbeat') ? heartbeat([command(9, 'get_page_state', {}), command(10)]) : { stored: true })
    const stalledRuntime = stalled.create()
    await stalledRuntime.handle({ type: 'boss.tick' }, page)
    expect(stalled.pageCalls.map(call => call.name)).toEqual(['get_page_state'])
    expect(stalled.navigations).toHaveLength(0)
    expect(stalled.disk().accounts[ACCOUNT].ack).toBe(10)
    expect(stalled.calls.find(call => call.path.endsWith('/tools/result') && call.body.command_id === 10)?.body).toMatchObject({ ok: false, error: 'navigation_recovery_required' })
    expect(await stalledRuntime.handle({ type: 'boss.status' }, popup)).toMatchObject({ phase: 'diagnostic_only', lastError: 'navigation_not_confirmed' })
    stalled.request(async path => path.endsWith('/heartbeat') ? heartbeat([command(11, 'open_thread', { company: 'company' }), command(12)]) : { stored: true })
    stalled.page(async invocation => ({ result: { ok: true, data: invocation.name === 'open_thread' ? 'ok' : { delivery: 'delivered' } } }))
    stalled.advance()
    await stalledRuntime.handle({ type: 'boss.tick' }, page)
    expect(stalled.pageCalls.map(call => call.name)).toEqual(['get_page_state', 'open_thread', 'send_message'])
    expect(stalled.navigations).toHaveLength(0)
    expect(await stalledRuntime.handle({ type: 'boss.status' }, popup)).toMatchObject({ phase: 'tool_ready', lastError: '' })

    stalled.request(async path => path.endsWith('/heartbeat') ? heartbeat([command(13, 'open_thread', { company: 'missing' }), command(14), command(15, 'get_page_state', {})]) : { stored: true })
    stalled.page(async invocation => invocation.name === 'open_thread' ? { result: { ok: false, error: 'thread_not_confirmed' } } : { result: { ok: true } })
    stalled.advance()
    await stalledRuntime.handle({ type: 'boss.tick' }, page)
    expect(stalled.pageCalls.slice(-2).map(call => call.name)).toEqual(['open_thread', 'get_page_state'])
    expect(stalled.calls.find(call => call.path.endsWith('/tools/result') && call.body.command_id === 14)?.body).toMatchObject({ ok: false, error: 'navigation_recovery_required' })

    // An old persisted target may not exist after navigation. Bound retries across worker restarts,
    // replace its intermediate result and keep diagnostics usable without sending to the wrong thread.
    const missing = harness({ [ACCOUNT]: { epoch: 'db-outbox-v2', ack: 8,
      pendingThread: { company: 'missing', jobTitle: '', fromDocumentId: 'previous-doc' },
      receipts: { 'db-outbox-v2:8': { commandId: 8, epoch: 'db-outbox-v2', tool: 'open_thread', state: 'done', irreversible: false, uploaded: true, effects: [] } },
    } })
    missing.page(async invocation => invocation.name === 'open_thread' ? { result: { ok: false, error: 'not-found' } } : { result: { ok: true } })
    missing.request(async path => path.endsWith('/heartbeat') ? heartbeat([command(9), command(10, 'get_page_state', {})]) : { stored: true })
    let missingRuntime = missing.create()
    for (let attempt = 0; attempt < 5; attempt++) {
      await missingRuntime.handle({ type: 'boss.tick' }, page)
      missing.advance()
      if (attempt === 1) missingRuntime = missing.create()
    }
    expect(missing.pageCalls.map(call => call.name)).toEqual([...Array(5).fill('open_thread'), 'get_page_state'])
    expect(missing.calls.filter(call => call.path.endsWith('/tools/result')).map(call => ({ id: call.body.command_id, error: call.body.error }))).toEqual([
      { id: 8, error: 'not-found' }, { id: 9, error: 'navigation_recovery_required' }, { id: 10, error: '' },
    ])
    expect(missing.disk().accounts[ACCOUNT].ack).toBe(10)
    expect(await missingRuntime.handle({ type: 'boss.status' }, popup)).toMatchObject({ phase: 'diagnostic_only', lastError: 'pending_thread_not-found' })

    const ambiguous = harness({ [ACCOUNT]: { epoch: 'db-outbox-v2', ack: 8, receipts: {}, pendingThread: { company: 'same-company', jobTitle: '', fromDocumentId: 'previous-doc' } } })
    ambiguous.page(async () => ({ result: { ok: false, error: 'ambiguous' } }))
    ambiguous.request(async path => path.endsWith('/heartbeat') ? heartbeat([]) : { stored: true })
    const ambiguousRuntime = ambiguous.create()
    await ambiguousRuntime.handle({ type: 'boss.tick' }, page)
    ambiguous.advance()
    await ambiguousRuntime.handle({ type: 'boss.tick' }, page)
    expect(ambiguous.pageCalls).toHaveLength(1)
    expect(await ambiguousRuntime.handle({ type: 'boss.status' }, popup)).toMatchObject({ phase: 'diagnostic_only', lastError: 'pending_thread_ambiguous' })
  })

  it('rejects forged page and popup senders and requires explicit host permission before accepting custom service credentials', async () => {
    const h = harness()
    const runtime = h.create()
    await expect(runtime.handle({ type: 'boss.logout' }, page)).rejects.toThrow('untrusted_sender')
    await expect(runtime.handle({ type: 'boss.tick' }, { ...page, id: 'other-extension' })).rejects.toThrow('untrusted_sender')
    await expect(runtime.handle({ type: 'boss.tick' }, { ...page, frameId: 3 })).rejects.toThrow('untrusted_sender')
    await expect(runtime.handle({ type: 'boss.tick' }, { ...page, documentLifecycle: 'cached' })).rejects.toThrow('untrusted_sender')
    await expect(runtime.handle({ type: 'boss.tick' }, { ...page, url: 'https://www.zhipin.com.attacker.test/' })).rejects.toThrow('untrusted_sender')
    expect(await runtime.handle({ type: 'boss.tick' }, { ...page, tab: { id: 13, url: page.url } } as chrome.runtime.MessageSender)).toMatchObject({ ok: false })
    for (const apiBase of ['http://[::1]:8010', 'https://[::1]', 'http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'file:///etc/passwd', 'javascript:alert(1)']) {
      await expect(runtime.handle({ type: 'boss.token', apiBase, token: TOKEN }, popup)).rejects.toThrow('invalid_api_origin')
    }
    h.denyPermission()
    await expect(runtime.handle({ type: 'boss.token', apiBase: 'http://127.0.0.1:8010', token: TOKEN }, popup)).rejects.toThrow('api_permission_required')
    expect(h.calls).toHaveLength(0)

    const isolated = harness()
    const host = isolated.create()
    await expect(host.handle({ type: 'boss.panel.bootstrap' }, page)).rejects.toThrow('untrusted_sender')
    await expect(host.handle({ type: 'boss.panel.bootstrap' }, { ...panel, documentId: 'stale-frame' })).rejects.toThrow('untrusted_panel_document')
    await host.handle({ type: 'boss.panel.bootstrap' }, panel)
    await expect(host.handle({ type: 'boss.panel.storage', action: 'set', key: 'aah_mirror_conversations', value: [], account: 'other-account' }, panel)).rejects.toThrow('session_changed')
    await expect(host.handle({ type: 'boss.panel.storage', action: 'get', key: 'boss-agent.runtime.v1', account: ACCOUNT }, panel)).rejects.toThrow('storage_key_forbidden')
    const request = { type: 'boss.panel.network', account: ACCOUNT, options: { method: 'GET', url: `${API}/api/conversations/list?limit=1000` } }
    expect(await host.handle(request, panel)).toMatchObject({ status: 200 })
    await expect(host.handle({ ...request, options: { method: 'GET', url: `${API}/api/conversations/list?limit=1000&token=bad` } }, panel)).rejects.toThrow('api_path_forbidden')
    await expect(host.handle({ ...request, options: { method: 'POST', url: `${API}/api/plugin/heartbeat` } }, panel)).rejects.toThrow('api_path_forbidden')

    // Reattach only when the previous selected tab is gone or has left BOSS, using the verified top document.
    for (const type of ['boss.panel.bootstrap', 'boss.panel.config']) {
      for (const selection of [
        { url: null, disabled: false, expectedTab: 12 },
        { url: 'https://example.com', disabled: false, expectedTab: 12 },
        { url: page.url, disabled: false, expectedTab: 13 },
        { url: undefined, disabled: false, expectedTab: 13 },
        { url: null, disabled: true, expectedTab: 13 },
      ]) {
        const reconnect = harness()
        Object.assign(reconnect.disk().config!, { tabId: 13, enabled: !selection.disabled, panelDisabled: selection.disabled })
        reconnect.chrome.tabs.get = (async (tabId: number) => {
          if (tabId === 13 && selection.url === null) throw new Error('No tab with id: 13')
          return { id: tabId, url: tabId === 13 ? selection.url : page.url }
        }) as typeof reconnect.chrome.tabs.get
        const current = reconnect.create()
        await current.handle({ type, account: ACCOUNT, config: { apiBase: API, token: TOKEN, resumeId: 7 } }, panel)
        expect(await current.schedulerTarget()).toMatchObject({
          enabled: !selection.disabled, tabId: selection.expectedTab,
          documentId: selection.expectedTab === 12 ? 'doc-1' : null,
        })
        expect(reconnect.disk().config).toMatchObject({ tabId: selection.expectedTab, panelDisabled: selection.disabled })
      }
    }

    // MAIN-world page output cannot grant a read tool write access, smuggle API fields, or navigate arbitrary BOSS paths.
    const attacks = [
      { name: 'get_page_state', args: {}, effects: [{ kind: 'application', payload: { platform: 'zhipin', platform_job_id: 'fake', title: 'fake', outcome: 'applied' } }] },
      { name: 'send_message', args: { text: 'hello' }, effects: [{ kind: 'conversation_deleted', payload: { platform: 'zhipin', company: 'fake' } }] },
      { name: 'delete_thread', args: { company: 'company' }, effects: [{ kind: 'conversation_deleted', payload: { platform: 'zhipin', company: 'company', token: 'should-never-reach-api' } }] },
      { name: 'open_search', args: { keyword: 'keyword' }, effects: [{ kind: 'navigate', url: 'https://www.zhipin.com/web/geek/settings' }] },
      { name: 'open_thread', args: { company: 'company' }, effects: [{ kind: 'navigate', url: 'https://attacker.test/', pendingThread: { company: 'company', jobTitle: '' } }] },
      { name: 'reload_page', args: {}, effects: [{ kind: 'reload' }, { kind: 'reload' }] },
      { name: 'get_page_state', args: {}, effects: { kind: 'application' } },
      { name: 'apply_job', args: { jobId: 'job-1' }, effects: [{ kind: 'application', payload: { platform: 'zhipin', platform_job_id: 'job-1', title: 'role', outcome: 'applied', resume_id: 99 } }] },
    ]
    for (const attack of attacks) {
      const malicious = harness()
      malicious.request(async path => path.endsWith('/heartbeat') ? heartbeat([command(8, attack.name, attack.args)]) : path.endsWith('/greeting') ? { greeting: 'hello' } : { stored: true })
      malicious.page(async (_invocation, method) => method === 'prepare' ? { ok: true, data: { job: { platformJobId: 'job-1', title: 'role' } } } : { result: { ok: true }, effects: attack.effects })
      await malicious.create().handle({ type: 'boss.tick' }, page)
      expect(malicious.calls.filter(call => call.path.endsWith('/record') || call.path.endsWith('/mark-deleted'))).toHaveLength(0)
      expect(malicious.navigations).toHaveLength(0)
      expect(malicious.calls.find(call => call.path.endsWith('/tools/result'))?.body).toMatchObject({ ok: false, error: 'reconciliation_required', data: { reason: 'invalid_page_effect', retrySafe: false } })
    }
    const malformed = harness()
    malformed.request(async path => path.endsWith('/heartbeat') ? heartbeat([{ ...command(8, 'get_page_state'), payload: { name: 'get_page_state', args: [] } }]) : { stored: true })
    await malformed.create().handle({ type: 'boss.tick' }, page)
    expect(malformed.pageCalls).toHaveLength(0)
    expect(malformed.calls.find(call => call.path.endsWith('/tools/result'))?.body).toMatchObject({ ok: false, error: 'invalid_arguments' })
  })

  it('invalidates an in-flight apply preparation on logout and never uploads its old-account receipt to a new account', async () => {
    const h = harness()
    const greeting = deferred<unknown>()
    const requested = deferred<void>()
    h.request(async path => {
      if (path.endsWith('/heartbeat')) return heartbeat([command(8, 'apply_job', { jobId: 'job-1' })])
      if (path.endsWith('/greeting')) { requested.resolve(); return greeting.promise }
      if (path.endsWith('/auth/token')) return { token: 'new-account-auth-token-long-value', user_id: 2, username: 'user-two' }
      if (path.endsWith('/config')) return { resumes: [] }
      return { stored: true }
    })
    h.page(async (_invocation, method) => method === 'prepare' ? { ok: true, data: { job: { platformJobId: 'job-1', title: 'role' } } } : { result: { ok: true } })
    const runtime = h.create()
    const tick = runtime.handle({ type: 'boss.tick' }, page)
    await requested.promise
    const logout = runtime.handle({ type: 'boss.logout' }, popup)
    greeting.resolve({ greeting: 'hello' })
    await Promise.all([tick, logout])
    expect(h.pageCalls.filter(call => call.context?.greeting)).toHaveLength(0)
    expect(h.disk().accounts[ACCOUNT].receipts['db-outbox-v2:8'].result?.error).toBe('reconciliation_required')
    await runtime.handle({ type: 'boss.token', apiBase: API, token: 'new-account-auth-token-long-value' }, popup)
    await runtime.handle({ type: 'boss.enable', tabId: 12 }, popup)
    h.advance()
    h.request(async path => path.endsWith('/heartbeat') ? heartbeat([]) : { stored: true })
    await runtime.handle({ type: 'boss.tick' }, page)
    expect(h.calls.filter(call => call.path.endsWith('/tools/result'))).toHaveLength(0)
    expect(h.disk().accounts[ACCOUNT].receipts['db-outbox-v2:8'].uploaded).toBe(false)
  })

  it('drives actual hidden-page heartbeats through the production scheduler, stops on freeze/timeout, and fences a late session wake', async () => {
    const query = vi.fn(async () => [
      { id: 12 }, { id: 13, discarded: true }, { id: 14, frozen: true }, {}, { id: 15 },
    ])
    const inject = vi.fn(async (details: { target: { tabId: number } }) => {
      if (details.target.tabId === 12) throw new Error('tab closed during attachment')
      return []
    })
    await attachExistingBossPages({ tabs: { query }, scripting: { executeScript: inject } } as unknown as Pick<typeof chrome, 'tabs' | 'scripting'>)
    expect(query).toHaveBeenCalledWith({ url: 'https://www.zhipin.com/*' })
    expect(inject.mock.calls.map(([details]) => details)).toEqual([12, 15].map(tabId => ({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', files: ['content.js'] })))

    vi.useFakeTimers()
    try {
      const h = harness()
      const runtime = h.create()
      const wakes: Array<{ generation: string; options: unknown }> = []
      const alarms: unknown[] = []
      let held = false
      const pendingWake = deferred<unknown>()
      let content!: BossContentHeartbeat
      const scheduler = new BossHeartbeatScheduler({
        target: () => runtime.schedulerTarget(),
        chrome: {
          tabs: { ...h.chrome.tabs, sendMessage: async (_tab: number, request: { generation: string }, options: unknown) => {
            wakes.push({ generation: request.generation, options })
            return held ? pendingWake.promise : content.wake(request, { id: 'extension-id' })
          } },
          alarms: { get: async () => undefined, create: async (...args: unknown[]) => { alarms.push(args) }, clear: async () => true, onAlarm: { addListener: () => undefined } },
        } as unknown as Pick<typeof chrome, 'tabs' | 'alarms'>,
      })
      content = new BossContentHeartbeat({
        visibility: () => 'hidden',
        runtime: { id: 'extension-id', sendMessage: async (message: { type: string; wakeGeneration?: string }) => {
          const response = await runtime.handle(message, page)
          await scheduler.refresh(message.type === 'boss.tick' ? { tabId: 12, documentId: 'doc-1', ...(message.wakeGeneration === undefined ? {} : { generation: message.wakeGeneration }) } : undefined)
          return response
        } } as unknown as Pick<typeof chrome.runtime, 'id' | 'sendMessage'>,
      })
      await scheduler.start()
      await content.resume() // Native active-document proof; no test-side synthetic scheduler heartbeat.
      const heartbeats = () => h.calls.filter(call => call.path.endsWith('/heartbeat'))
      expect(heartbeats()).toHaveLength(1)
      expect(alarms).toContainEqual([RECOVERY_ALARM, { delayInMinutes: 1, periodInMinutes: 1 }])
      h.advance(2000)
      await vi.advanceTimersByTimeAsync(2000)
      expect(heartbeats()).toHaveLength(2)
      expect(heartbeats()[1].body.visibility).toBe('hidden')
      expect(wakes[0].options).toEqual({ documentId: 'doc-1' })

      await content.freeze()
      h.advance(60_000)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(heartbeats()).toHaveLength(2)
      await scheduler.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(heartbeats()).toHaveLength(2)
      expect(wakes.at(-1)?.options).toEqual({ frameId: 0 })
      expect((await runtime.schedulerTarget()).documentId).toBeNull()

      await content.resume()
      expect(heartbeats()).toHaveLength(3)
      held = true
      h.advance(2000)
      await vi.advanceTimersByTimeAsync(2000)
      const oldGeneration = wakes.at(-1)!.generation
      const wakeCount = wakes.length
      await vi.advanceTimersByTimeAsync(5000)
      await scheduler.recover()
      await scheduler.recover()
      expect(wakes).toHaveLength(wakeCount) // A frozen sendMessage cannot accumulate one pending message per alarm.
      expect(heartbeats()).toHaveLength(3)

      await runtime.handle({ type: 'boss.disable' }, popup)
      await scheduler.refresh()
      pendingWake.resolve({ runnable: true, generation: oldGeneration })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(wakes).toHaveLength(wakeCount)
      await runtime.handle({ type: 'boss.enable', tabId: 12 }, popup)
      await scheduler.refresh()
      await content.wake({ type: 'boss.wake', generation: oldGeneration }, { id: 'extension-id' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(heartbeats()).toHaveLength(3)
      expect(wakes).toHaveLength(wakeCount)

      held = false
      await content.resume()
      h.advance(2000)
      await vi.advanceTimersByTimeAsync(2000)
      expect(heartbeats()).toHaveLength(5)
      expect(wakes.at(-1)?.generation).not.toBe(oldGeneration)

      // MAIN may remain suspended after freeze. Its old Promise must not hold logout in the command queue.
      const frozen = harness()
      const mainStarted = deferred<void>()
      const mainResult = deferred<unknown>()
      frozen.request(async path => path.endsWith('/heartbeat') ? heartbeat([command()]) : { stored: true })
      frozen.page(async () => { mainStarted.resolve(); return mainResult.promise })
      const frozenRuntime = frozen.create()
      const frozenContent = new BossContentHeartbeat({ visibility: () => 'hidden', runtime: {
        id: 'extension-id', sendMessage: (message: unknown) => frozenRuntime.handle(message, page),
      } as unknown as Pick<typeof chrome.runtime, 'id' | 'sendMessage'> })
      const running = frozenContent.resume()
      await mainStarted.promise
      const beforeFreeze = await frozenRuntime.schedulerTarget()
      await frozenContent.freeze()
      await running // Resolves through the production interrupt race while mainResult is still pending.
      expect((await frozenRuntime.schedulerTarget()).generation).not.toBe(beforeFreeze.generation)
      expect(await frozenRuntime.handle({ type: 'boss.tick', lifecycleVersion: 0 }, page)).toMatchObject({ phase: 'page_frozen' })
      await frozenRuntime.handle({ type: 'boss.logout' }, popup)
      expect(frozen.disk().config).toBeNull()
      expect(frozen.cancellations[0]?.[1]).toMatch(/^boss:[0-9a-f]{64}$/)
      expect(frozen.disk().accounts[ACCOUNT].receipts['db-outbox-v2:8'].result?.error).toBe('reconciliation_required')
      mainResult.resolve({ result: { ok: true, data: { delivery: 'delivered' } } })
      await vi.advanceTimersByTimeAsync(0)
      expect(frozen.calls.filter(call => call.path.endsWith('/tools/result'))).toHaveLength(0)

      // The invocation deadline also fences a preparation that returns late, before any MAIN run existed to cancel.
      const late = harness()
      const lookupStarted = deferred<void>()
      const tabLookup = deferred<chrome.tabs.Tab>()
      late.chrome.tabs.get = (() => { lookupStarted.resolve(); return tabLookup.promise }) as typeof chrome.tabs.get
      late.request(async path => path.endsWith('/heartbeat') ? heartbeat([command()]) : { stored: true })
      const lateTick = late.create().handle({ type: 'boss.tick' }, page)
      await lookupStarted.promise
      await vi.advanceTimersByTimeAsync(180_000)
      await lateTick
      expect(late.calls.find(call => call.path.endsWith('/tools/result'))?.body).toMatchObject({ error: 'reconciliation_required' })
      tabLookup.resolve({ id: 12, url: page.url } as chrome.tabs.Tab)
      await vi.advanceTimersByTimeAsync(0)
      expect(late.pageCalls).toHaveLength(0)

      // Execute the actual serialized MAIN gate after Chrome queues it: epoch changes and expiry must reject late starts.
      for (const interruption of ['freeze-and-logout', 'deadline']) {
        const queued = harness()
        const invocationQueued = deferred<void>()
        const dispatch = deferred<void>()
        queued.beforeInvocation(async () => { invocationQueued.resolve(); await dispatch.promise })
        queued.request(async path => path.endsWith('/heartbeat') ? heartbeat([command()]) : { stored: true })
        const queuedRuntime = queued.create()
        const queuedTick = queuedRuntime.handle({ type: 'boss.tick', lifecycleVersion: 0 }, page)
        await invocationQueued.promise // Preflight already read the epoch; the real run function has not started.
        if (interruption === 'freeze-and-logout') {
          queued.changeEpoch() // MAIN's native freeze listener increments its epoch before cancelling leases.
          await queuedRuntime.handle({ type: 'boss.lifecycle', state: 'frozen', lifecycleVersion: 1 }, page)
          await queuedTick
          await queuedRuntime.handle({ type: 'boss.logout' }, popup)
        } else {
          await vi.advanceTimersByTimeAsync(180_000)
          await queuedTick
        }
        dispatch.resolve()
        await vi.advanceTimersByTimeAsync(0)
        expect(queued.pageCalls).toHaveLength(0)
      }

      // A late alarm create is serialized before disable.clear, and a failed create is retryable in the same state.
      const alarmTarget = { enabled: true, tabId: 12, documentId: 'doc-1', generation: 'alarm-enable' }
      const createStarted = deferred<void>()
      const createFinished = deferred<void>()
      const alarmOrder: string[] = []
      const serialized = new BossHeartbeatScheduler({ target: async () => alarmTarget, chrome: {
        tabs: { sendMessage: async () => ({ runnable: false }) },
        alarms: {
          get: async () => undefined,
          create: async () => { alarmOrder.push('create'); createStarted.resolve(); await createFinished.promise; alarmOrder.push('created') },
          clear: async () => { alarmOrder.push('clear'); return true }, onAlarm: { addListener: () => undefined },
        },
      } as unknown as Pick<typeof chrome, 'tabs' | 'alarms'> })
      const starting = serialized.start()
      await createStarted.promise
      alarmTarget.enabled = false
      alarmTarget.generation = 'alarm-disable'
      const disabling = serialized.refresh()
      createFinished.resolve()
      await Promise.all([starting, disabling])
      expect(alarmOrder).toEqual(['create', 'created', 'clear'])
      let creates = 0
      const retrying = new BossHeartbeatScheduler({ target: async () => ({ ...alarmTarget, enabled: true }), chrome: {
        tabs: { sendMessage: async () => ({ runnable: false }) },
        alarms: { get: async () => undefined, create: async () => { creates += 1; if (creates === 1) throw new Error('alarm-unavailable') }, clear: async () => true, onAlarm: { addListener: () => undefined } },
      } as unknown as Pick<typeof chrome, 'tabs' | 'alarms'> })
      await expect(retrying.refresh()).rejects.toThrow('alarm-unavailable')
      await retrying.refresh()
      expect(creates).toBe(2)
    } finally { vi.useRealTimers() }
  })

})
