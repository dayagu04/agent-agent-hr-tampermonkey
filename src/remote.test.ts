import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./platform-bridge', () => ({
  network: { request: vi.fn() },
  storage: { get: vi.fn(), set: vi.fn() },
}))
vi.mock('./config', () => ({
  loadConfig: vi.fn(() => ({ apiBase: 'http://x', token: 't' })),
  saveConfig: vi.fn(),
  isConfigReady: vi.fn(() => true),
  applyPluginPreferences: vi.fn((cfg) => cfg),
}))
vi.mock('./logger', () => ({ diag: vi.fn(), flushLogs: vi.fn() }))
vi.mock('./debug', () => ({ startDebugCapture: vi.fn() }))
vi.mock('./orchestrator', () => ({
  getCurrentJob: vi.fn(() => null),
  getOrchestratorSnapshot: vi.fn(async () => null),
  resumeOrchestrator: vi.fn(),
  getOrchestrator: vi.fn(() => ({
    getState: () => null,
    isRunning: () => false,
  })),
}))
vi.mock('./platforms/boss-chat', () => ({ runChatAudit: vi.fn() }))
vi.mock('./platforms/factory', () => ({ detectPlatform: vi.fn(() => ({})) }))

import { network, storage } from './platform-bridge'
import { reportHeartbeatAndPoll } from './remote'
import { detectPlatform } from './platforms/factory'

beforeEach(() => {
  vi.mocked(network.request).mockReset()
  vi.mocked(storage.get).mockReset()
  vi.mocked(storage.set).mockReset()
  vi.mocked(storage.get).mockResolvedValue({ epoch: '', id: 0 })
  vi.mocked(detectPlatform).mockReturnValue({} as ReturnType<typeof detectPlatform>)
})

describe('远程心跳命令协议', () => {
  it('执行命令后持久化 ACK，并在请求中带上已有游标', async () => {
    vi.mocked(network.request).mockResolvedValue({
      status: 200,
      responseText: JSON.stringify({
        command_epoch: 'server-a',
        commands: [{ id: 7, action: 'config.reload', payload: {} }],
      }),
    })

    await reportHeartbeatAndPoll()

    const request = vi.mocked(network.request).mock.calls[0][0]
    expect(JSON.parse(String(request.data)).ack_command_id).toBe(0)
    expect(storage.set).toHaveBeenCalledWith(
      expect.any(String), { epoch: 'server-a', id: 7 },
    )
  })

  it('慢请求期间不启动重叠心跳', async () => {
    let resolveRequest!: (value: { status: number; responseText: string }) => void
    vi.mocked(network.request).mockImplementation(() => new Promise((resolve) => {
      resolveRequest = resolve
    }))

    const first = reportHeartbeatAndPoll()
    await Promise.resolve()
    await Promise.resolve()
    const overlapping = reportHeartbeatAndPoll()
    await overlapping
    expect(network.request).toHaveBeenCalledTimes(1)

    resolveRequest({ status: 200, responseText: '{"commands":[]}' })
    await first
    vi.mocked(network.request).mockResolvedValue({ status: 500, responseText: '' })
    await reportHeartbeatAndPoll()
    expect(network.request).toHaveBeenCalledTimes(2)
  })

  it('命令执行失败时不越过失败项写入 ACK', async () => {
    vi.mocked(detectPlatform).mockReturnValue(null)
    vi.mocked(network.request).mockResolvedValue({
      status: 200,
      responseText: JSON.stringify({
        command_epoch: 'server-a',
        commands: [
          { id: 1, action: 'orchestrator.start', payload: {} },
          { id: 2, action: 'config.reload', payload: {} },
        ],
      }),
    })

    await reportHeartbeatAndPoll()

    expect(storage.set).not.toHaveBeenCalled()
  })
})
