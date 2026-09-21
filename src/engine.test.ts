import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyProgress, JobCard, PlatformCode, PluginConfig } from './types'
import { ApplyEngine } from './engine'
import { BasePlatform, type ApplyResult } from './platforms/base'

vi.mock('./api', () => ({
  fetchRules: vi.fn(),
  fetchGreeting: vi.fn(),
  judgeJobs: vi.fn(),
  logDecision: vi.fn(),
  matchJobs: vi.fn(),
  recordApplication: vi.fn(),
}))

vi.mock('./ledger', () => ({
  cacheScannedJobs: vi.fn(),
}))

import { fetchRules, judgeJobs, matchJobs, recordApplication } from './api'

const job: JobCard = {
  platformJobId: 'j1',
  title: '测试岗',
  company: '测试公司',
  salary: '10-15K',
  city: '上海',
}

function makeConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    apiBase: 'http://x',
    token: 't',
    resumeId: 1,
    threshold: 50,
    matchEnabled: false,
    maxApply: 100,
    chatCheckInterval: 5,
    maxPagesPerKeyword: 20,
    searchFilterQuery: '',
    applyIntervalSeconds: 0,
    autoPaginate: false,
    maxPages: 1,
    prefCity: '',
    rejectOffCityLocation: false,
    minReplyScore: 0,
    replyScope: 'all',
    maxRepliesPerRound: 10,
    cleanReadConversations: true,
    cleanReadAfterHours: 16,
    defaultSendResumeId: null,
    resumeNames: {},
    qualityJudge: false,
    ...overrides,
  }
}

class FakePlatform extends BasePlatform {
  readonly name = '测试平台'
  readonly code: PlatformCode = 'zhipin'
  readonly chatUrl = ''
  private jobs: JobCard[] = []
  private result: boolean | ApplyResult = { outcome: 'applied' }

  setJobs(jobs: JobCard[]): void {
    this.jobs = jobs
  }

  setResult(result: boolean | ApplyResult): void {
    this.result = result
  }

  async scanJobs(): Promise<JobCard[]> {
    return this.jobs
  }

  async applyJob(): Promise<boolean | ApplyResult> {
    return this.result
  }
}

async function runEngine(platform: BasePlatform, cfg: PluginConfig): Promise<ApplyProgress> {
  const engine = new ApplyEngine(platform, cfg, () => {}, new Set(), 'run-test')
  return engine.run()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchRules).mockResolvedValue([])
  vi.mocked(judgeJobs).mockResolvedValue([])
  vi.mocked(matchJobs).mockResolvedValue([{
    platform_job_id: 'j1', score: 0, recommend: true, reason: '仅执行投递护栏',
  }])
  vi.mocked(recordApplication).mockResolvedValue({
    success: true,
    duplicate: false,
    message: 'ok',
  })
})

describe('ApplyEngine 投递结果口径', () => {
  it('已沟通过的岗位（alreadyApplied）计为跳过并向后端补记真实投递', async () => {
    const platform = new FakePlatform()
    platform.setJobs([job])
    platform.setResult({ outcome: 'unknown', message: '该岗位已沟通过', alreadyApplied: true })

    const progress = await runEngine(platform, makeConfig())

    expect(progress.applied).toBe(0)
    expect(progress.skipped).toBe(1)
    expect(progress.failed).toBe(0)
    expect(progress.unknown).toBe(0)
    expect(recordApplication).toHaveBeenCalledWith(
      expect.anything(),
      'zhipin',
      expect.objectContaining({ platformJobId: 'j1' }),
      expect.any(Number),
      'applied',
      expect.any(String),
      false,
      'run-test',
      '',
    )
  })

  it('未确认（unknown）不计入投递进度与失败计数', async () => {
    const platform = new FakePlatform()
    platform.setJobs([job])
    platform.setResult({ outcome: 'unknown', message: '未出现聊天框' })

    const progress = await runEngine(platform, makeConfig())

    expect(progress.applied).toBe(0)
    expect(progress.skipped).toBe(0)
    expect(progress.failed).toBe(0)
    expect(progress.unknown).toBe(1)
    expect(recordApplication).toHaveBeenCalledWith(
      expect.anything(), 'zhipin', expect.anything(), expect.any(Number),
      'unknown', expect.any(String), false, 'run-test',
      '',
    )
  })

  it('确认成功（applied）计入投递进度', async () => {
    const platform = new FakePlatform()
    platform.setJobs([job])
    platform.setResult({ outcome: 'applied', message: '已发起沟通' })

    const progress = await runEngine(platform, makeConfig())

    expect(progress.applied).toBe(1)
    expect(progress.unknown).toBe(0)
    expect(progress.failed).toBe(0)
  })
})

describe('ApplyEngine 规则/质量降级', () => {
  it('规则拉取失败且匹配已关闭 → 停止并提示（不绕过黑名单）', async () => {
    vi.mocked(fetchRules).mockResolvedValue(null)
    const platform = new FakePlatform()
    platform.setJobs([job])

    const progress = await runEngine(platform, makeConfig({ matchEnabled: false }))

    expect(progress.applied).toBe(0)
    expect(progress.running).toBe(false)
    expect(progress.logs.join('\n')).toContain('为避免绕过黑名单')
  })

  it('规则拉取失败但匹配开启 → 继续跑并提示本地规则未生效', async () => {
    vi.mocked(fetchRules).mockResolvedValue(null)
    vi.mocked(matchJobs).mockResolvedValue([])
    const platform = new FakePlatform()
    platform.setJobs([job])

    const progress = await runEngine(platform, makeConfig({ matchEnabled: true }))

    expect(progress.logs.join('\n')).toContain('规则拉取失败')
    // 匹配开启且后端未返回评分 → 该岗位被低分跳过，但引擎没有中止
    expect(progress.running).toBe(false)
    expect(progress.skipped).toBe(1)
  })

  it('匹配关闭仍请求后端护栏，并拦截已投岗位', async () => {
    vi.mocked(matchJobs).mockResolvedValue([{
      platform_job_id: 'j1', score: 0, recommend: false,
      reason: '', blocked_reason: 'already_applied',
    }])
    const platform = new FakePlatform()
    platform.setJobs([job])

    const progress = await runEngine(platform, makeConfig({ matchEnabled: false }))

    expect(matchJobs).toHaveBeenCalledWith(
      expect.anything(), 'zhipin', [job], expect.any(Function), false,
    )
    expect(progress.applied).toBe(0)
    expect(progress.skipped).toBe(1)
    expect(recordApplication).not.toHaveBeenCalled()
  })

  it('低质量判定接口失败 → 提示降级但仍正常投递', async () => {
    vi.mocked(judgeJobs).mockResolvedValue(null)
    const platform = new FakePlatform()
    platform.setJobs([job])
    platform.setResult({ outcome: 'applied' })

    const progress = await runEngine(platform, makeConfig({ qualityJudge: true }))

    expect(progress.logs.join('\n')).toContain('低质量岗位判定接口失败')
    expect(progress.applied).toBe(1)
  })
})
