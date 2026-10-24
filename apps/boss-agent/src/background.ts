import { BossRuntime } from './runtime'
import { attachExistingBossPages, BossHeartbeatScheduler } from './background-scheduler'

const runtime = new BossRuntime({ chrome, fetch: globalThis.fetch.bind(globalThis) })
const scheduler = new BossHeartbeatScheduler({ chrome, target: () => runtime.schedulerTarget() })
void scheduler.start().catch(() => undefined)
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  void runtime.handle(message, sender).then(async result => {
    reply(result)
    const value = message as { type?: unknown; wakeGeneration?: unknown } | null
    const proof = value?.type === 'boss.tick' && sender.tab?.id !== undefined && sender.documentId
      ? { tabId: sender.tab.id, documentId: sender.documentId, ...(typeof value.wakeGeneration === 'string' ? { generation: value.wakeGeneration } : {}) }
      : undefined
    await scheduler.refresh(proof)
  }, (error: unknown) => {
    reply({ ok: false, transportError: true, error: error instanceof Error ? error.message : 'runtime_error' })
  }).catch(() => undefined)
  return true
})

chrome.runtime.onConnect.addListener(port => { void runtime.attachPanel(port) })

// A live content owner only wakes its heartbeat; reload creates one replacement panel.
void attachExistingBossPages(chrome).catch(() => undefined)
