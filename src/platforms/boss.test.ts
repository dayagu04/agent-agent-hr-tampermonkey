import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BasePlatform } from './base'
import { BossPlatform } from './boss'

/**
 * 脱敏 BOSS 列表 fixture。
 *
 * 只保留适配器依赖的 class/data 属性，不放真实岗位、公司、账号或消息内容。
 * 这个 fixture 的目标是验证「搜索页扫描 → 卡片身份归一化」，不是模拟完整页面。
 */
const SEARCH_HTML = `
  <main class="job-list-box">
    <ul>
      <li class="job-card-wrap" data-testid="job-valid">
        <a class="job-card-left" href="https://www.zhipin.com/job_detail/job_demo_01.html?source=list"></a>
        <div class="job-name">后端工程师</div>
        <div class="company-name">示例科技</div>
        <div class="salary"><em>15</em>-<em>25</em>K</div>
        <span class="job-area">上海·浦东</span>
        <ul class="tag-list"><li>五险一金</li><li>双休</li></ul>
      </li>
      <li class="job-card-wrap" data-jid="job_demo_02">
        <a class="job-card-left" href="/job_detail/job_demo_02.html#detail"></a>
        <div class="job-name">数据分析师</div>
        <div class="company-name">测试信息</div>
        <div class="salary">1.5-2万·13薪</div>
        <span class="company-location">杭州</span>
      </li>
      <li class="job-card-wrap">
        <a class="job-card-left" href="/job_detail/missing-title.html"></a>
        <div class="company-name">缺少标题的卡片</div>
      </li>
    </ul>
  </main>
`

function visibleRect(): DOMRect {
  return {
    width: 120,
    height: 32,
    top: 0,
    left: 0,
    right: 120,
    bottom: 32,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
}

beforeEach(() => {
  document.body.innerHTML = SEARCH_HTML
  // jsdom 没有真实布局/滚动；这些桩只让适配器走正常分支。
  vi.spyOn(BasePlatform.prototype as unknown as { delay: () => Promise<void> }, 'delay')
    .mockResolvedValue(undefined)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(visibleRect)
  // jsdom 29 不声明 scrollIntoView，先补一个可恢复的原型方法。
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('BOSS sanitized search/apply regression matrix', () => {
  it('scans valid cards, normalizes IDs, and drops incomplete cards', async () => {
    const platform = new BossPlatform()

    const jobs = await platform.scanJobs()

    expect(jobs).toHaveLength(2)
    expect(jobs.map((job) => job.platformJobId)).toEqual(['job_demo_01', 'job_demo_02'])
    expect(jobs[0]).toMatchObject({
      title: '后端工程师',
      company: '示例科技',
      salary: '15-25K',
      city: '上海·浦东',
      description: '五险一金 双休',
    })
    // 相对链接应由浏览器解析为绝对链接，查询串/hash 不得污染岗位 ID。
    expect(jobs[0].url).toBe('https://www.zhipin.com/job_detail/job_demo_01.html?source=list')
    expect(jobs[1]).toMatchObject({
      title: '数据分析师',
      company: '测试信息',
      salary: '1.5-2万·13薪',
      city: '杭州',
    })
  })

  it('recognizes the next-page control only when it is enabled', async () => {
    const platform = new BossPlatform()
    const next = document.createElement('button')
    next.textContent = '下一页'
    document.body.append(next)
    const clicked = vi.fn()
    next.addEventListener('click', clicked)

    expect(await platform.nextPage()).toBe(true)
    expect(clicked).toHaveBeenCalledTimes(1)

    next.className = 'disabled'
    expect(await platform.nextPage()).toBe(false)
  })

  it('treats the BOSS confirmation dialog as an applied conversation', async () => {
    const platform = new BossPlatform()
    const job = (await platform.scanJobs())[0]
    const button = document.createElement('button')
    button.textContent = '立即沟通'
    job.cardElement?.append(button)
    const dialog = document.createElement('section')
    dialog.innerHTML = '<h3>已向BOSS发送消息</h3><p>你好，我想进一步了解岗位。</p><button>留在此页</button>'
    document.body.append(dialog)
    const stay = dialog.querySelector('button') as HTMLButtonElement
    const stayed = vi.fn()
    stay.addEventListener('click', stayed)

    const result = await platform.applyJob(job)

    expect(result).toMatchObject({ outcome: 'applied', greetingSent: true })
    expect(stayed).toHaveBeenCalledTimes(1)
  })

  it('reports the existing conversation state instead of clicking again', async () => {
    const platform = new BossPlatform()
    const job = (await platform.scanJobs())[0]
    const button = document.createElement('button')
    button.textContent = '继续沟通'
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    job.cardElement?.append(button)

    const result = await platform.applyJob(job)

    expect(result).toMatchObject({ outcome: 'unknown', alreadyApplied: true })
    expect(clicked).not.toHaveBeenCalled()
  })

  it('returns a confirmed failure when no card action is available', async () => {
    const platform = new BossPlatform()
    const result = await platform.applyJob({
      platformJobId: 'job_missing_action',
      title: '脱敏岗位',
      company: '脱敏公司',
    })

    expect(result).toMatchObject({ outcome: 'failed' })
    expect(result.message).toContain('未找到')
  })
})
