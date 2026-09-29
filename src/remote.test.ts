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
    applyBackendAction: vi.fn(async () => true),
  })),
  flushOrchestratorEvents: vi.fn(async () => undefined),
}))
vi.mock('./platforms/boss-chat', () => ({ runChatAudit: vi.fn() }))
vi.mock('./platforms/factory', () => ({ detectPlatform: vi.fn(() => ({})) }))

import { network, storage } from './platform-bridge'
import { diag } from './logger'
import { reportHeartbeatAndPoll } from './remote'
import { detectPlatform } from './platforms/factory'
import { getOrchestrator } from './orchestrator'

beforeEach(() => {
  vi.mocked(network.request).mockReset()
  vi.mocked(storage.get).mockReset()
  vi.mocked(storage.set).mockReset()
  vi.mocked(diag).mockReset()
  vi.mocked(getOrchestrator).mockReset()
  vi.mocked(getOrchestrator).mockReturnValue({
    getState: () => null,
    isRunning: () => false,
    applyBackendAction: vi.fn(async () => true),
  } as never)
  vi.mocked(storage.get).mockResolvedValue({ epoch: '', id: 0 })
  vi.mocked(detectPlatform).mockReturnValue({} as ReturnType<typeof detectPlatform>)
})

const compatible = {
  can_receive_commands: true,
  status: 'compatible',
}

describe('远程心跳命令协议', () => {
  it('执行命令后持久化 ACK，并在请求中带上已有游标', async () => {
    vi.mocked(network.request).mockResolvedValue({
      status: 200,
      responseText: JSON.stringify({
        command_epoch: 'server-a',
        plugin_compatibility: compatible,
        commands: [{ id: 7, action: 'config.reload', payload: {} }],
      }),
    })

    await reportHeartbeatAndPoll()

    const request = vi.mocked(network.request).mock.calls[0][0]
    const body = JSON.parse(String(request.data))
    expect(body.ack_command_id).toBe(0)
    expect(body.protocol_version).toBe(2)
    expect(body.capabilities).toEqual(['command_ack_v2'])
    expect(storage.set).toHaveBeenCalledWith(
      expect.any(String), { epoch: 'server-a', id: 7 },
    )
  })

  it('服务端明确拒绝命令时不执行也不推进 ACK', async () => {
    const applyBackendAction = vi.fn(async () => true)
    vi.mocked(getOrchestrator).mockReturnValue({
      getState: () => null,
      isRunning: () => false,
      applyBackendAction,
    } as never)
    vi.mocked(network.request).mockResolvedValue({
      status: 200,
      responseText: JSON.stringify({
        command_epoch: 'server-a',
        plugin_compatibility: {
          can_receive_commands: false,
          status: 'upgrade_required',
          reason: '插件版本过低',
        },
        commands: [{ id: 8, action: 'orchestrator.action', payload: { action: 'stop' } }],
      }),
    })

    await reportHeartbeatAndPoll()

    expect(applyBackendAction).not.toHaveBeenCalled()
    expect(storage.set).not.toHaveBeenCalled()
    expect(vi.mocked(diag)).toHaveBeenCalledWith(
      'REMOTE', expect.stringContaining('插件版本过低'),
    )
  })

  it('服务端漏发兼容性确认时 fail closed，不执行响应中的命令', async () => {
    const applyBackendAction = vi.fn(async () => true)
    vi.mocked(getOrchestrator).mockReturnValue({
      getState: () => null,
      isRunning: () => false,
      applyBackendAction,
    } as never)
    vi.mocked(network.request).mockResolvedValue({
      status: 200,
      responseText: JSON.stringify({
        command_epoch: 'server-a',
        commands: [{ id: 9, action: 'orchestrator.action', payload: { action: 'stop' } }],
      }),
    })

    await reportHeartbeatAndPoll()

    expect(applyBackendAction).not.toHaveBeenCalled()
    expect(storage.set).not.toHaveBeenCalled()
    expect(vi.mocked(diag)).toHaveBeenCalledWith(
      'REMOTE', expect.stringContaining('远程命令未执行'),
    )
  })

  it('重复兼容性拒绝在 30 秒内只诊断一次，恢复后再次提示', async () => {
    vi.mocked(network.request).mockResolvedValue({
      status: 200,
      responseText: JSON.stringify({
        command_epoch: 'server-dedupe',
        plugin_compatibility: {
          can_receive_commands: false,
          reason: '仅用于低噪声回归',
        },
        commands: [],
      }),
    })

    await reportHeartbeatAndPoll()
    await reportHeartbeatAndPoll()
    expect(vi.mocked(diag)).toHaveBeenCalledTimes(1)

    vi.mocked(network.request).mockResolvedValue({
      status: 200,
      responseText: JSON.stringify({
        command_epoch: 'server-dedupe',
        plugin_compatibility: compatible,
        commands: [],
      }),
    })
    await reportHeartbeatAndPoll()
    expect(vi.mocked(diag)).toHaveBeenCalledTimes(1)

    vi.mocked(network.request).mockResolvedValue({
      status: 200,
      responseText: JSON.stringify({
        command_epoch: 'server-dedupe',
        plugin_compatibility: {
          can_receive_commands: false,
          reason: '仅用于低噪声回归',
        },
        commands: [],
      }),
    })
    await reportHeartbeatAndPoll()
    expect(vi.mocked(diag)).toHaveBeenCalledTimes(2)
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
        plugin_compatibility: compatible,
        commands: [
          { id: 1, action: 'orchestrator.start', payload: {} },
          { id: 2, action: 'config.reload', payload: {} },
        ],
      }),
    })

    await reportHeartbeatAndPoll()

    expect(storage.set).not.toHaveBeenCalled()
  })

  it('编排动作未被执行器接受时不写 ACK，等待下一次心跳重试', async () => {
    const applyBackendAction = vi.fn(async () => false)
    vi.mocked(getOrchestrator).mockReturnValue({
      getState: () => null,
      isRunning: () => false,
      applyBackendAction,
    } as never)
    vi.mocked(network.request).mockResolvedValue({
      status: 200,
      responseText: JSON.stringify({
        command_epoch: 'server-a',
        plugin_compatibility: compatible,
        commands: [{
          id: 9,
          action: 'orchestrator.action',
          payload: { action: 'apply_batch', command_id: 'cmd-9' },
        }],
      }),
    })

    await reportHeartbeatAndPoll()

    expect(applyBackendAction).toHaveBeenCalledWith({
      action: 'apply_batch', command_id: 'cmd-9',
    })
    expect(storage.set).not.toHaveBeenCalled()
  })
})
