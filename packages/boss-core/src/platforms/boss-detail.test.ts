import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ diag: vi.fn() }))

import { BossPlatform } from './boss'

function rect(width: number) {
  return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 20, width, height: 20, toJSON: () => ({}) }
}

describe('reading a job JD from the detail pane', () => {
  it('waits for the requested job identity and changed JD, then removes inline CSS', async () => {
    const oldJd = '上一岗位的职责。'.repeat(20)
    const expected = '岗位职责：负责日常行政事务与文件整理。'.repeat(6)
    document.body.innerHTML = `
      <div class="job-card-wrap"><a href="/job_detail/job-b.html">行政班 早九晚六</a></div>
      <div class="job-detail-box">
        <div class="job-detail-info"><span class="job-name">上一岗位</span></div>
        <p class="desc">${oldJd}</p>
        <button>立即沟通</button>
        <a class="more-job-btn" href="/job_detail/job-a.html">查看详情</a>
      </div>`
    const visible = () => {
      for (const el of Array.from(document.querySelectorAll('*'))) vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(100))
    }
    visible()
    const cardElement = document.querySelector<HTMLElement>('.job-card-wrap')!
    const target = cardElement.querySelector<HTMLAnchorElement>('a')!
    target.scrollIntoView = vi.fn()
    target.addEventListener('click', event => event.preventDefault())
    const card = { platformJobId: 'job-b', title: '行政班 早九晚六', company: '公司', cardElement }
    const platform = new BossPlatform()
    let polls = 0
    const delay = vi.spyOn(platform as unknown as { delay(min: number, max: number): Promise<void> }, 'delay').mockImplementation(async min => {
      if (min !== 220) return
      polls++
      if (polls === 1) {
        document.querySelector('.job-name')!.textContent = card.title
        document.querySelector('.more-job-btn')!.setAttribute('href', '/job_detail/job-b.html')
      }
      if (polls === 3) {
        document.querySelector('p.desc')!.innerHTML = `<style>.anNMcHFn{display:inline-block;font-size:0!important}</style>${expected}`
      }
    })
    const jd = await platform.readJobDetail(card)

    expect(polls).toBe(4) // Matching header/link alone must not accept the old body in polls 1 and 2.
    expect(jd).toBe(expected)
    expect(jd).not.toContain('display:inline-block')
    expect(jd).not.toContain('立即沟通')

    // A hidden retained pane must not win; the already confirmed target may retain the same JD.
    const hidden = document.querySelector('.job-detail-box')!.cloneNode(true) as HTMLElement
    hidden.hidden = true
    document.body.prepend(hidden)
    visible()
    delay.mockResolvedValue(undefined)
    expect(await platform.readJobDetail(card)).toBe(expected)

    // A same-title target without a matching detail ID must not inherit this JD.
    expect(await platform.readJobDetail({ ...card, platformJobId: 'job-c' })).toBe('')
    hidden.hidden = false
    expect(await platform.readJobDetail(card)).toBe('') // Two visible panes are ambiguous.
    hidden.remove()
    document.querySelector('.more-job-btn')!.removeAttribute('href')
    expect(await platform.readJobDetail(card)).toBe('')
    document.querySelector('.more-job-btn')!.setAttribute('href', '/job_detail/job-b.html')
    document.querySelector('p.desc')!.remove()
    expect(await platform.readJobDetail(card)).toBe('') // A loaded header is not a loaded JD.
  })

  it('removes zero-size watermark spans (kanzhun / BOSS直聘) mixed into the text', async () => {
    // 2026-10-21 probe_dom 实测：p.desc 里夹着随机 class 的 0 宽 span
    document.body.innerHTML = `
      <div class="job-detail-box">
        <p class="desc">电话客服<span class="jGGisttdfwC">kanzhun</span>坐班<span class="rwKxDXYPc">BOSS直聘</span>不含销售<span class="PYrtrhdnmjFr">直聘</span></p>
      </div>`
    for (const el of Array.from(document.querySelectorAll('*'))) {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(el.tagName === 'SPAN' ? 0 : 300))
    }
    const platform = new BossPlatform()
    const jd = await (platform as unknown as { readDetailJd(): string }).readDetailJd()

    expect(jd).toBe('电话客服坐班不含销售')
    // 活 DOM 上的临时标记必须清掉，不能污染页面
    expect(document.querySelector('[data-aah-hidden]')).toBeNull()
  })

  it('also removes 0.1px-wide watermark spans (rounds to 0 but is not 0)', async () => {
    // 2026-10-23 实测：反爬 CSS 用 width:0.1px，旧判断 width === 0 漏掉
    document.body.innerHTML = `
      <div class="job-detail-box">
        <p class="desc">小白<span class="pBYPaWST">kanzhun</span>首选<span class="BTiFBHrXDAe">来自BOSS直聘</span>带薪培训</p>
      </div>`
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const w = el.tagName === 'SPAN' ? 0.1 : 300
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ ...rect(w), height: el.tagName === 'SPAN' ? 0.1 : 20 })
    }
    const platform = new BossPlatform()
    const jd = await (platform as unknown as { readDetailJd(): string }).readDetailJd()

    expect(jd).toBe('小白首选带薪培训')
  })
})

describe('JD scope', () => {
  it('reads only p.desc, not the HR card, address or SEO links in the same panel', async () => {
    // 2026-10-23 probe_dom 实测：.job-detail-body 下 h3.title + p.desc + .job-boss-info + .job-address
    document.body.innerHTML = `
      <div class="job-detail-box">
        <div class="job-detail-header"><div class="job-header-info">纯客服 5-8K</div></div>
        <div class="job-detail-body">
          <h3 class="title">职位描述</h3>
          <p class="desc">小白首选，带薪培训</p>
          <div class="job-boss-info">曹女士 刚刚活跃 去App与BOSS随时沟通</div>
          <div class="job-address">工作地址 合肥蜀山区</div>
        </div>
        <div class="seo">合肥保洁招聘合肥BOSS直聘招聘</div>
      </div>`
    for (const el of Array.from(document.querySelectorAll('*'))) {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(300))
    }
    const platform = new BossPlatform()
    const jd = await (platform as unknown as { readDetailJd(): string }).readDetailJd()

    expect(jd).toBe('小白首选，带薪培训')
  })
})
