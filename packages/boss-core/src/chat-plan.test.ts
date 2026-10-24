import { describe, expect, it } from 'vitest'
import { chatRowKey, chatTargetKey, findPlanTarget } from './chat-plan'

describe('chatTargetKey / chatRowKey', () => {
  it('岗位 ID 优先（最稳定）', () => {
    expect(chatTargetKey({ company: 'A', job_title: 'B', encrypt_job_id: 'j1' })).toBe('job:j1')
    expect(chatRowKey({ company: 'A', jobTitle: 'B', encryptJobId: 'j1' })).toBe('job:j1')
  })

  it('没有岗位 ID 时退回 公司|岗位 文本键', () => {
    expect(chatTargetKey({ company: '测试公司', job_title: 'Python开发' })).toBe(
      'text:测试公司|Python开发',
    )
    expect(chatRowKey({ company: '测试公司', jobTitle: 'Python开发' })).toBe(
      'text:测试公司|Python开发',
    )
  })
})

describe('findPlanTarget', () => {
  const targets = [
    {
      company: '测试公司',
      job_title: 'Python开发',
      encrypt_job_id: 'j1',
      action: 'cleanup' as const,
      last_message_at: 1,
    },
    {
      company: '测试公司',
      job_title: '产品经理',
      encrypt_job_id: 'j2',
      action: 'reply' as const,
      last_message_at: 2,
    },
  ]

  it('encryptJobId 精确命中优先于公司/岗位文本', () => {
    const hit = findPlanTarget(
      targets,
      { encryptJobId: 'j2', company: '测试公司', jobTitle: '产品经理' },
      { lenient: false },
    )
    expect(hit?.encrypt_job_id).toBe('j2')
  })

  it('严格模式要求公司+岗位都命中（同公司多岗位不误配）', () => {
    const hit = findPlanTarget(
      targets,
      { company: '测试公司', jobTitle: 'Python开发' },
      { lenient: false },
    )
    expect(hit?.encrypt_job_id).toBe('j1')

    const miss = findPlanTarget(
      targets,
      { company: '测试公司', jobTitle: '别的岗位' },
      { lenient: false },
    )
    expect(miss).toBeNull()
  })

  it('宽松模式允许命中「岗位名为空」的目标（inbound 会话）', () => {
    const inboundTargets = [
      {
        company: '测试公司',
        job_title: '',
        encrypt_job_id: 'inbound:测试公司:',
        action: 'cleanup' as const,
        last_message_at: 1,
      },
    ]
    const hit = findPlanTarget(
      inboundTargets,
      { company: '测试公司', jobTitle: 'Python开发' },
      { lenient: true },
    )
    expect(hit?.action).toBe('cleanup')
  })

  it('宽松模式下公司命中但岗位对不上仍不匹配（同公司多岗位不误配）', () => {
    const hit = findPlanTarget(
      targets,
      { company: '测试公司', jobTitle: '会计' },
      { lenient: true },
    )
    expect(hit).toBeNull()
  })
})
