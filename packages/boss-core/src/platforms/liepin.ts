// 猎聘适配器
// 页面：https://www.liepin.com/zhaopin/（搜索列表）
//
// 投递方式：点「投递简历」按钮。猎聘可能需登录态 + 简历选择。
// 适配器未在真实页面验证，@match 未启用，仅作扩展预留。
import { BasePlatform } from './base'
import type { JobCard, PlatformCode } from '../types'

export class LiepinPlatform extends BasePlatform {
  readonly name = '猎聘'
  readonly code: PlatformCode = 'liepin'

  async scanJobs(): Promise<JobCard[]> {
    // 猎聘搜索结果卡片使用混淆 class 名（如 _40108yn42Q），需用属性选择器兜底
    const cards = Array.from(
      document.querySelectorAll(
        '[class*="40108"][class*="yn"], .job-card-box, .job-list-item, div[class*="job-card"]',
      ),
    ) as HTMLElement[]

    const jobs: JobCard[] = []
    for (const card of cards) {
      const link = card.querySelector('a[href*="/job/"], a.job-card-job-info') as HTMLAnchorElement | null
      const href = link?.href || ''
      const idMatch = href.match(/\/job\/(\d+)/) || href.match(/\/(\w+)\.shtml/)
      const platformJobId = idMatch ? idMatch[1] : href

      const title = this.text(card.querySelector('.job-title-box, .ellipsis-1, [class*="job-title"]'))
      const company = this.text(card.querySelector('.company-name, [class*="company"]'))
      // 薪资：class 为混淆名（如 _40108E8PWS），用属性选择器 + 关键词兜底
      const salary = this.text(
        card.querySelector('[class*="40108E8P"], [class*="salary"]') ||
        Array.from(card.querySelectorAll('*')).find(el =>
          /薪资|万|千|K/.test(this.text(el)) && el.children.length === 0
        ) as HTMLElement | undefined
      )
      // 城市：在 _40108__9nJ div 内的 ellipsis-1 span
      const city = this.text(
        card.querySelector('[class*="40108__9"] .ellipsis-1, [class*="area"]') ||
        Array.from(card.querySelectorAll('span.ellipsis-1')).find(el =>
          /北京|上海|深圳|广州|杭州|成都/.test(this.text(el))
        ) as HTMLElement | undefined
      )

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
    // 猎聘列表页一般无直接投递按钮，需进详情页（可能要求选简历 + 登录态），
    // 这里实现列表页按钮 + 确认弹窗的流程框架。
    const btn = this.findApplyButton(card.cardElement || undefined)
    if (!btn) {
      // 列表无投递按钮 → 需进详情页（跨页操作复杂，暂返回 false 标记需手动）
      return false
    }
    btn.click()
    await this.delay(1500, 2500)

    // 处理简历选择/确认弹窗
    const confirm = await this.waitFor('.ant-modal button, .confirm-btn', document, 3000)
    if (confirm && /投递|确认|发送/.test(this.text(confirm))) {
      confirm.click()
      await this.delay(1000, 2000)
    }
    return true
  }

  private findApplyButton(root?: ParentNode): HTMLElement | null {
    if (!root) return null
    const candidates = Array.from(root.querySelectorAll('button, a'))
    return (
      (candidates.find((el) => {
        const t = this.text(el)
        return t === '投递简历' || t === '投递' || t === '立即投递'
      }) as HTMLElement | undefined) || null
    )
  }
}
