// 智联招聘适配器
// 页面：https://sou.zhaopin.com/（搜索结果列表）
//
// 投递方式：点「立即投递」按钮，智联实测无二次确认（参考 zhaopin.py:412）。
// 部分岗位列表页直接有投递按钮，部分需进详情页。
import { BasePlatform, type ApplyResult } from './base'
import type { JobCard, PlatformCode } from '../types'
import { diag } from '../logger'

export class ZhaopinPlatform extends BasePlatform {
  readonly name = '智联招聘'
  readonly code: PlatformCode = 'zhaopin'

  async scanJobs(): Promise<JobCard[]> {
    // 智联改版频繁：多套卡片选择器依次尝试，取命中最多的那套。
    // 选择器按「精确 → 宽松」排序，取【第一个能拿到有效岗位】的，而不是命中最多的。
    // 教训：`div[class*=joblist-box__item]` 会连嵌套子元素一起匹配（实测 205 个里
    // 165 个是空壳），命中多 ≠ 更好。
    const cardSelectors = [
      '.joblist-box__item.clearfix',
      '.joblist-box__item',
      '.job-list-box .joblist-box__item',
      '.positionlist .join-box',
      '.job-list-item',
      'div[class*="jobItem"]',
      'div[class*="joblist-box__item"]',
    ]

    const hasJobContent = (el: HTMLElement) =>
      !!el.querySelector('a[href*="/jobdetail/"], a.jobinfo__name')

    let cards: HTMLElement[] = []
    let usedSelector = ''
    for (const sel of cardSelectors) {
      const found = (Array.from(document.querySelectorAll(sel)) as HTMLElement[]).filter(hasJobContent)
      if (found.length) {
        cards = found
        usedSelector = sel
        break
      }
    }
    diag('ZHAOPIN', `卡片选择器命中 "${usedSelector}" → ${cards.length} 个有效卡片`)

    const jobs: JobCard[] = []
    const dropped: string[] = []

    for (const card of cards) {
      // 详情链接：新版可能是 /jobdetail/xxx.htm，也可能是 jobs.zhaopin.com/xxx.htm
      const link = card.querySelector(
        'a.jobinfo__name, a[href*="/jobdetail/"], a[href*="zhaopin.com"][href*=".htm"]',
      ) as HTMLAnchorElement | null
      const href = link?.href || ''

      // 提取纯 ID：先剥掉 query/hash，避免整段 URL 当 id 导致后端校验异常
      const cleanHref = href.split('?')[0].split('#')[0]
      const idMatch =
        cleanHref.match(/jobdetail\/([A-Za-z0-9_-]+)\.htm/) ||
        cleanHref.match(/\/([A-Za-z0-9_-]+)\.htm/)
      let platformJobId = idMatch ? idMatch[1] : ''

      // 兜底：卡片自带的 data 属性（新版常挂 data-jobid / data-key）
      if (!platformJobId) {
        platformJobId =
          card.getAttribute('data-jobid') ||
          card.getAttribute('data-key') ||
          card.getAttribute('data-id') ||
          ''
      }

      // 标题：链接文本优先，退回常见标题类名
      const title =
        this.text(link) ||
        this.text(card.querySelector('[class*="jobinfo__name"], [class*="jobName"], .iteminfo__line1__jobname'))

      const company = this.text(
        card.querySelector('.companyinfo__name, [class*="companyName"], .iteminfo__line1__compname'),
      )
      const salary = this.text(card.querySelector('.jobinfo__salary, [class*="salary"]'))
      const city = this.text(card.querySelector('.jobinfo__other-info-item span, [class*="other-info"] span'))

      // 缺 id 或标题就跳过，并记录原因（否则静默丢弃很难排查）
      if (!title || !platformJobId) {
        dropped.push(`title="${title}" id="${platformJobId}" href="${href.slice(0, 60)}"`)
        continue
      }

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

    if (dropped.length) {
      diag('ZHAOPIN', `${dropped.length} 张卡片缺 id/标题被跳过`, dropped.slice(0, 5))
    }
    diag('ZHAOPIN', `有效岗位 ${jobs.length} 个`, jobs[0] ? { id: jobs[0].platformJobId, title: jobs[0].title, company: jobs[0].company } : null)
    return jobs
  }

  async applyJob(card: JobCard): Promise<ApplyResult> {
    const btn = this.findApplyButton(card.cardElement || undefined)

    if (!btn) {
      // 不再自动 window.open：批量投递时会刷出大量标签页，且新标签页
      // 无法在本上下文继续操作，等于白开。直接判为「需手动」交回引擎。
      diag('ZHAOPIN', `"${card.title}" 卡片内无投递按钮`)
      return { outcome: 'failed', message: '卡片内未找到投递按钮' }
    }

    // 滚动到按钮位置（智联部分按钮需在视口内才可点）
    try {
      btn.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
      await this.delay(300, 600)
    } catch {
      /* ignore */
    }

    diag('ZHAOPIN', `点击投递按钮: ${card.title}`)
    btn.click()
    await this.delay(1500, 2500)

    // 处理可能的简历确认弹窗
    const confirmBtn = await this.waitFor(
      'button.a-button--primary, .confirm-btn, [class*="dialog"] [class*="primary"]',
      document,
      3000,
    )
    if (confirmBtn && /投递|确认|申请/.test(this.text(confirmBtn))) {
      diag('ZHAOPIN', '检测到确认弹窗，点击确认')
      confirmBtn.click()
      await this.delay(1000, 2000)
    }

    // 校验是否真的投出去了：按钮文本通常变为「已投递」
    await this.delay(500, 1000)
    const afterText = this.text(btn).replace(/\s/g, '')
    const confirmed = /已投递|已申请/.test(afterText) || !document.contains(btn)
    diag('ZHAOPIN', `投递后按钮文本="${afterText}" 判定=${confirmed ? '已确认' : '未确认'}`)

    if (confirmed) {
      return { outcome: 'applied', message: '按钮已变为已投递' }
    }
    // 智联部分岗位投递后按钮不变，一律判失败会漏报；如实返回 unknown，
    // 由后端记为「未确认」而非真实投递，避免虚高统计。
    diag('ZHAOPIN', `"${card.title}" 结果未确认，请在平台核对`)
    return { outcome: 'unknown', message: '已点击但平台未反馈，请在平台核对' }
  }

  /** 翻到下一页。智联分页是「下一页」按钮，点击后 URL 变化 + 列表重载。 */
  async nextPage(): Promise<boolean> {
    const candidates = Array.from(
      document.querySelectorAll('button, a, li, span, div[class*="pagination"] *'),
    ) as HTMLElement[]

    const btn = candidates.find((el) => {
      const t = this.text(el).replace(/\s/g, '')
      if (t !== '下一页' && t !== '下页' && t !== '>') return false
      // 排除禁用态（最后一页）
      const cls = el.className || ''
      const disabled =
        /disabled|is-disabled|btn-disable/.test(String(cls)) ||
        el.getAttribute('aria-disabled') === 'true' ||
        (el as HTMLButtonElement).disabled === true
      return !disabled
    })

    if (!btn) {
      diag('ZHAOPIN', '未找到可用「下一页」（可能已是最后一页）')
      return false
    }

    diag('ZHAOPIN', '点击下一页')
    btn.scrollIntoView({ block: 'center' })
    await this.delay(500, 1000)
    btn.click()
    // 等列表刷新（智联是 SPA，URL 变但不整页重载；等卡片重新渲染）
    await this.delay(3000, 5000)
    return true
  }

  /** 在给定根元素内查找投递按钮（文本匹配） */
  private findApplyButton(root?: ParentNode): HTMLElement | null {
    if (!root) return null
    // 放宽候选范围：智联按钮可能是 div/span 实现，不止 button/a
    const candidates = Array.from(
      root.querySelectorAll('button, a, .a-button, [class*="button"], [class*="btn"], div[role="button"], span'),
    )
    // 用「包含」而非「全等」：实际文本常含空白/零宽字符，全等会漏掉。
    // 同时排除「已投递」「继续沟通」等非投递态按钮。
    const hit = candidates.find((el) => {
      const t = this.text(el).replace(/\s/g, '')
      if (!t) return false
      if (/已投递|已申请|继续沟通|收藏/.test(t)) return false
      return /^(立即投递|投递|立即申请|申请职位|一键投递)$/.test(t)
    }) as HTMLElement | undefined

    if (!hit) {
      const texts = candidates
        .map((el) => this.text(el).replace(/\s/g, ''))
        .filter((t) => t && t.length < 12)
      diag('ZHAOPIN', '卡片内未找到投递按钮，候选文本采样', Array.from(new Set(texts)).slice(0, 20))
    }
    return hit || null
  }
}
