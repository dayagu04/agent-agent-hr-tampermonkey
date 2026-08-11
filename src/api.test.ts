import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginConfig } from './types'

// 把 GM 桥接层换成假实现，专门测 API 失败时不再静默返回空数组
vi.mock('./platform-bridge', () => ({
  storage: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
  },
  network: { request: vi.fn() },
  notification: { notify: vi.fn() },
}))

import { network } from './platform-bridge'
import { fetchRules, judgeJobs } from './api'

const cfg = { apiBase: 'http://x', token: 't' } as unknown as PluginConfig

beforeEach(() => {
  vi.mocked(network.request).mockReset()
})

describe('fetchRules', () => {
  it('网络失败返回 null（不再是空数组，防止静默绕过黑名单）', async () => {
    vi.mocked(network.request).mockRejectedValue(new Error('网络不可达'))
    expect(await fetchRules(cfg)).toBeNull()
  })

  it('非 200 返回 null', async () => {
    vi.mocked(network.request).mockResolvedValue({ status: 500, responseText: 'boom' })
    expect(await fetchRules(cfg)).toBeNull()
  })

  it('200 返回规则数组（空列表也是合法结果）', async () => {
    vi.mocked(network.request).mockResolvedValue({
      status: 200,
      responseText: JSON.stringify({
        rules: [{ id: 1, rule_type: 'block_company', value: '外包' }],
      }),
    })
    const rules = await fetchRules(cfg)
    expect(rules).toHaveLength(1)
    expect(rules![0].rule_type).toBe('block_company')
  })
})

describe('judgeJobs', () => {
  it('网络失败返回 null（不再是空数组，让调用方给出降级提示）', async () => {
    vi.mocked(network.request).mockRejectedValue(new Error('网络不可达'))
    expect(await judgeJobs(cfg, [])).toBeNull()
  })

  it('非 200 返回 null', async () => {
    vi.mocked(network.request).mockResolvedValue({ status: 502, responseText: 'bad gateway' })
    expect(await judgeJobs(cfg, [])).toBeNull()
  })

  it('200 返回判定数组', async () => {
    vi.mocked(network.request).mockResolvedValue({
      status: 200,
      responseText: JSON.stringify({
        results: [{ company: '外包公司', verdict: 'low_quality', reason: '外包', cached: false }],
      }),
    })
    const verdicts = await judgeJobs(cfg, [])
    expect(verdicts).toHaveLength(1)
    expect(verdicts![0].verdict).toBe('low_quality')
  })
})
