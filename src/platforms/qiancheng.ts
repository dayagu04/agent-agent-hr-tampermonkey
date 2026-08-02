// 51前程无忧适配器
// 页面：https://we.51job.com/pc/search（搜索列表）
//
// 投递方式：51 在搜索页可勾选多个岗位批量「申请职位」，或单个「投递」。
// 参考 src/scrapers/platforms/qiancheng.py（搜索页卡片点击投递）。
import { BasePlatform } from './base'
import type { JobCard, PlatformCode } from '../types'

export class QianchengPlatform extends BasePlatform {
  readonly name = '前程无忧51job'
  readonly code: PlatformCode = 'qiancheng'

  async scanJobs(): Promise<JobCard[]> {
    // 51 搜索结果卡片
    // TODO[真实验证]: 确认卡片选择器。51 新版 we.51job.com 用 Vue 渲染。
    //   常见：.joblist .e .joblist-item / .j_joblist .e
    const cards = Array.from(
      document.querySelectorAll(
        '.joblist-item, .j_joblist .e, div[class*="joblist"] div[class*="item"]',
      ),
    ) as HTMLElement[]

    const jobs: JobCard[] = []
    for (const card of cards) {
      const link = card.querySelector('a[href*="jobs.51job.com"], a.el, a[href*="/job/"]') as HTMLAnchorElement | null
      const href = link?.href || ''
      const idMatch = href.match(/\/(\d+)\.html/) || href.match(/jobid=([^&]+)/i)
      const platformJobId = idMatch ? idMatch[1] : href

      const title = this.text(card.querySelector('.jname, .job-title, [class*="jobname"]'))
      const company = this.text(card.querySelector('.cname, .company-name, [class*="company"]'))
      const salary = this.text(card.querySelector('.sal, .job-salary, [class*="salary"]'))
      const city = this.text(card.querySelector('.d.at, [class*="area"]'))

      if (!title || !platformJobId) continue

      jobs.push({
        platformJobId,
        title,
        company,
        salary,
        city,
        url: href,
        cardElement: card,
      })
    }
    return jobs
  }

  async applyJob(card: JobCard): Promise<boolean> {
    // 51：列表页卡片通常有 checkbox + 底部「申请职位」批量按钮，
    // 或单卡片「投递」按钮。这里实现单卡片投递。
    // TODO[真实验证]: 确认 51 列表页投递交互（勾选批量 vs 单点）。
    const btn = this.findApplyButton(card.cardElement || undefined)
    if (!btn) return false

    btn.click()
    await this.delay(1500, 2500)

    // 处理投递确认弹窗（51 常有「申请」确认）
    const confirm = await this.waitFor('.el-button--primary, .confirm, button.btn-apply', document, 3000)
    if (confirm && /申请|投递|确认|确定/.test(this.text(confirm))) {
      confirm.click()
      await this.delay(1000, 2000)
    }
    return true
  }

  private findApplyButton(root?: ParentNode): HTMLElement | null {
    if (!root) return null
    const candidates = Array.from(root.querySelectorAll('button, a, .el-button'))
    return (
      (candidates.find((el) => {
        const t = this.text(el)
        return t === '投递' || t === '申请职位' || t === '立即投递' || t === '申请'
      }) as HTMLElement | undefined) || null
    )
  }
}
