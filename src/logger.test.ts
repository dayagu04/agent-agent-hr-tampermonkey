import { describe, expect, it, vi } from 'vitest'

const { request } = vi.hoisted(() => ({ request: vi.fn().mockResolvedValue({ status: 200 }) }))
vi.mock('./platform-bridge', () => ({ network: { request } }))
vi.mock('./config', () => ({ loadConfig: () => ({ apiBase: 'https://example.test', token: 'test' }), isConfigReady: () => true }))

import { diag, setLogRunId } from './logger'

describe('plugin log grouping metadata', () => {
  it('captures the execution round and event time before uploading a batch', async () => {
    setLogRunId('run-1')
    diag('ORCH', 'started')
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    const payload = JSON.parse(request.mock.calls[0][0].data)
    expect(payload.batch_id).toMatch(/^b-[a-z0-9-]+$/)
    expect(payload.logs[0].run_id).toBe('run-1')
    expect(payload.logs[0].event_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    setLogRunId('')
  })
})
