import { beforeEach, describe, expect, it, vi } from 'vitest'

// 把 GM 桥接层换成内存假实现：ledger 的删除标记队列/镜像移除逻辑不碰真 GM API
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

import { network, storage } from './platform-bridge'
import {
  flushConversationDeletedMarks,
  queueConversationDeletedMark,
  removeMirrorByKey,
} from './ledger'
import type { HRMessageSummary } from './types'

const mkMirror = (id: number, company: string, jobTitle: string, encryptJobId: string) => ({
  id,
  company,
  jobTitle,
  encryptJobId,
  content: '',
  timestamp: id,
  unread: false,
  matchScore: null,
  lastMessageAt: '',
} as HRMessageSummary)

const cfg = { apiBase: 'http://x', token: 't' } as never

beforeEach(() => {
  vi.mocked(storage.get).mockReset()
  vi.mocked(storage.set).mockReset()
  vi.mocked(network.request).mockReset()
})

describe('removeMirrorByKey', () => {
  it('按 encryptJobId 精确移除，不误删同公司其它岗位', async () => {
    vi.mocked(storage.get).mockResolvedValue([
      mkMirror(1, '测试公司', 'Python开发', 'j1'),
      mkMirror(2, '测试公司', '产品经理', 'j2'),
    ])
    await removeMirrorByKey('测试公司', 'Python开发', { encryptJobId: 'j1' })

    const saved = vi.mocked(storage.set).mock.calls[0]?.[1] as HRMessageSummary[]
    expect(saved).toHaveLength(1)
    expect(saved[0].id).toBe(2)
  })

  it('按 bossId 精确移除', async () => {
    vi.mocked(storage.get).mockResolvedValue([
      { ...mkMirror(1, 'A', 'P1', ''), bossId: 'boss-1' },
      { ...mkMirror(2, 'A', 'P2', ''), bossId: 'boss-2' },
    ])
    await removeMirrorByKey('A', 'P1', { bossId: 'boss-1' })

    const saved = vi.mocked(storage.set).mock.calls[0]?.[1] as HRMessageSummary[]
    expect(saved).toHaveLength(1)
    expect(saved[0].id).toBe(2)
  })

  it('身份匹配不到时退回公司|岗位 key（保持旧行为）', async () => {
    vi.mocked(storage.get).mockResolvedValue([
      mkMirror(1, '测试公司', 'Python开发', 'j1'),
    ])
    await removeMirrorByKey('测试公司', 'Python开发', { encryptJobId: '不存在的id' })

    const saved = vi.mocked(storage.set).mock.calls[0]?.[1] as HRMessageSummary[]
    expect(saved).toHaveLength(0)
  })
})

describe('删除标记队列（outbox）', () => {
  it('入队去重：同一身份只留一条', async () => {
    vi.mocked(storage.get).mockResolvedValue([])
    await queueConversationDeletedMark({ company: 'A', job_title: 'P1', encrypt_job_id: 'j1' })
    await queueConversationDeletedMark({ company: 'A', job_title: 'P1', encrypt_job_id: 'j1', reason: 'x' })

    const saved = vi.mocked(storage.set).mock.calls.at(-1)?.[1] as unknown[]
    expect(saved).toHaveLength(1)
  })

  it('flush 成功后清空队列；请求失败保留待下次补发', async () => {
    vi.mocked(storage.get).mockResolvedValue([
      { company: 'A', job_title: 'P1', encrypt_job_id: 'j1' },
    ])
    vi.mocked(network.request).mockRejectedValueOnce(new Error('网络失败'))
    await flushConversationDeletedMarks(cfg)
    // 失败：队列不清空
    expect(vi.mocked(storage.set)).not.toHaveBeenCalled()

    vi.mocked(network.request).mockResolvedValueOnce({
      status: 200,
      responseText: '{"marked":1}',
    })
    await flushConversationDeletedMarks(cfg)
    // 成功：队列清空
    const cleared = vi.mocked(storage.set).mock.calls.at(-1)?.[1]
    expect(cleared).toEqual([])
  })

  it('flush 请求成功但 marked=0（后端无此记录）也视为完成，从队列移除', async () => {
    vi.mocked(storage.get).mockResolvedValue([
      { company: 'A', job_title: 'P1', encrypt_job_id: 'j1' },
    ])
    vi.mocked(network.request).mockResolvedValueOnce({
      status: 200,
      responseText: '{"marked":0}',
    })
    await flushConversationDeletedMarks(cfg)
    expect(vi.mocked(storage.set).mock.calls.at(-1)?.[1]).toEqual([])
  })
})
