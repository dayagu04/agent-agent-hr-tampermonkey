// BOSS 直聘适配器
// 页面：https://www.zhipin.com/web/geek/job（搜索列表）
//
// 投递方式：点「立即沟通」建立会话 + 发送打招呼语（与主项目 zhipin_action.apply_job 同语义）。
// 服务器端 Playwright 走这条路已被风控（_security_check 滑块），改由用户浏览器执行，
// 天然带真实登录态与指纹，不触发风控。
//
// 关键约束（来自主项目实战教训）：
//  - BOSS 每小时投递上限 3、最小间隔 180s（server/utils/rate_limiter.py::zhipin），
//    引擎会先查 /api/plugin/quota 再投，不可绕过（保号红线）。
//  - 不能点卡片导航离开列表页，否则后续岗位全部失效。
import { BasePlatform, type ApplyContext, type ApplyResult } from './base'
import type { JobCard, PlatformCode } from '../types'
import { diag } from '../logger'
import { pendingGreetingCount, pushPendingGreeting } from '../pending'

export class BossPlatform extends BasePlatform {
  readonly name = 'BOSS直聘'
  readonly code: PlatformCode = 'zhipin'
  /** 与 onChatPage() 的路径判断保持一致（/web/geek/chat） */
  readonly chatUrl = 'https://www.zhipin.com/web/geek/chat'

  async scanJobs(): Promise<JobCard[]> {
    // 按「精确 → 宽松」取第一个能拿到有效卡片的选择器。
    // 教训（智联同问题）：`[class*=xxx]` 会连嵌套子元素一起匹配，命中多 ≠ 更好。
    const cardSelectors = [
      '.job-card-wrap',               // 2026-07-30 实测（用户采样里出现，无 -per 后缀）
      'li.job-card-wrapper',          // 早期版本
      '.job-list-box > li',
      '.search-job-result li.job-card-wrapper',
      '.job-card-body',
      'div[class*="job-card-wrapper"]',
    ]
    const hasJobContent = (el: HTMLElement) =>
      !!el.querySelector('a.job-card-left, a[href*="job_detail"], .job-name')

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
    diag('BOSS', `卡片选择器命中 "${usedSelector}" → ${cards.length} 个有效卡片`)
    if (!cards.length) {
      // 一个都没命中：把页面上疑似卡片容器的 class 名列出来，供离线定位选择器
      const guess = Array.from(document.querySelectorAll('li, div'))
        .map((el) => String((el as HTMLElement).className || ''))
        .filter((c) => /job|card|position|list/i.test(c))
        .slice(0, 25)
      diag('BOSS', '无卡片命中，页面疑似容器 class 采样', guess)
    }

    const jobs: JobCard[] = []
    const dropped: string[] = []

    for (const card of cards) {
      const link = card.querySelector(
        'a.job-card-left, a[href*="job_detail"]',
      ) as HTMLAnchorElement | null
      const href = link?.href || ''

      // 提取纯 ID：/job_detail/<id>.html。先剥 query/hash，
      // 避免 fallback 成整段 URL（会导致后端 422，智联已踩过）。
      const cleanHref = href.split('?')[0].split('#')[0]
      const idMatch = cleanHref.match(/job_detail\/([A-Za-z0-9_~-]+)/)
      let platformJobId = idMatch ? idMatch[1] : ''
      if (!platformJobId) {
        // 兜底：卡片 data 属性 / securityId
        platformJobId =
          card.getAttribute('data-jobid') ||
          card.getAttribute('data-jid') ||
          (href.match(/securityId=([^&]+)/)?.[1] ?? '')
      }

      // 薪资：BOSS 把数字放在 <em> 等子节点里，直接取 .salary 文本会漏数字
      // （实测得到 "-K"）。故先单独取薪资，再从标题里剔除它。
      const salaryEl = card.querySelector('.salary, [class*="salary"], [class*="job-limit"] .red')
      let salary = this.text(salaryEl)
      if (!/\d/.test(salary)) {
        // 兜底：从卡片全文正则捞薪资区间（10-13K / 1.5-2万 / 14-28K·14薪）
        const m = (card.textContent || '').match(/\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*[Kk万]/)
        salary = m ? m[0].replace(/\s/g, '') : ''
      }

      let title = this.text(card.querySelector('.job-name, .job-title, [class*="jobName"]'))
      // 标题里常被拼进薪资（实测 "C＋＋开发工程师-K"），剥掉尾部薪资片段
      title = title
        .replace(/\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*[Kk万](?:·\d+薪)?/g, '')
        .replace(/[-~]\s*[Kk万]$/, '')
        .trim()

      const company = this.text(
        card.querySelector('.company-name, [class*="companyName"], .boss-name'),
      )
      const city = this.text(card.querySelector('.job-area, [class*="jobArea"], .city'))
      // 列表页无 JD 全文，用标签拼接供语义匹配
      const tags = Array.from(
        card.querySelectorAll('.tag-list li, .job-card-footer .tag, [class*="tagList"] li'),
      )
        .map((t) => this.text(t))
        .filter(Boolean)
        .join(' ')

      if (!title || !platformJobId) {
        dropped.push(`title="${title}" id="${platformJobId}" href="${href.slice(0, 50)}"`)
        continue
      }

      jobs.push({
        platformJobId,
        title,
        company,
        salary,
        city,
        description: tags,
        url: href,
        cardElement: card,
      })
    }

    if (dropped.length) {
      diag('BOSS', `${dropped.length} 张卡片缺 id/标题被跳过`, dropped.slice(0, 5))
    }
    diag('BOSS', `有效岗位 ${jobs.length} 个`, jobs[0]
      ? { id: jobs[0].platformJobId, title: jobs[0].title, company: jobs[0].company, salary: jobs[0].salary }
      : null)
    return jobs
  }

  async applyJob(card: JobCard, ctx?: ApplyContext): Promise<ApplyResult> {
    // BOSS /web/geek/jobs 是「左列表 + 右详情」联动布局（2026-07-30 实测）：
    // 左侧卡片内只有标题/薪资/公司文本，「立即沟通」在右侧详情面板。
    // 所以必须先点卡片让右侧详情加载，再在详情区找沟通按钮。
    // 点卡片是同页联动、不会导航离开，故安全。
    let btn = this.findChatButton(card.cardElement || undefined)

    if (!btn) {
      const clickTarget =
        (card.cardElement?.querySelector('a, .job-name, .job-title') as HTMLElement | null) ||
        card.cardElement ||
        null
      if (clickTarget) {
        clickTarget.scrollIntoView({ block: 'center' })
        await this.delay(400, 900)
        clickTarget.click()
        diag('BOSS', `点击卡片加载详情: ${card.title}`)
        // 等右侧详情渲染出沟通按钮
        btn = await this.waitForChatButton(8000)
      }
    }

    if (!btn) {
      diag('BOSS', `"${card.title}" 详情区未出现沟通按钮`, {
        url: location.href,
        detailTexts: this.sampleDetailTexts(),
      })
      return { outcome: 'failed', message: '未找到「立即沟通」按钮（详情未加载或已下线）' }
    }

    // 已沟通过的岗位按钮文本是「继续沟通」，跳过避免重复骚扰 HR
    const btnText = this.text(btn).replace(/\s/g, '')
    if (btnText.includes('继续沟通')) {
      return { outcome: 'failed', message: '该岗位已沟通过（继续沟通态）' }
    }

    btn.scrollIntoView({ block: 'center' })
    await this.delay(500, 1200)
    diag('BOSS', `点击沟通按钮: ${card.title}`)
    btn.click()

    // 先处理确认弹窗，再等聊天框：弹窗带遮罩，不关掉后续岗位全被挡死
    // （实测第一个岗位投成功后弹窗滞留，第二个即报「未出现聊天输入框」）。
    const bossSent = await this.dismissGreetingSentDialog()
    if (bossSent) {
      // BOSS 已自动发出账号默认招呼语，会话成立。
      // 此时不能再把我们的招呼语入队 —— 那会让 HR 收到两条寒暄，
      // 观感比不发更差。
      return {
        outcome: 'applied',
        message: `已建立会话，BOSS 已发送招呼语：${bossSent.slice(0, 20)}`,
        greetingSent: true,
      }
    }

    // 等聊天框出现（BOSS 点沟通后弹出聊天面板或跳转 /web/geek/chat）
    const input = await this.waitFor(
      '#chat-input, .chat-input, [contenteditable=true], textarea.input-area',
      document,
      10000,
    )

    if (!input) {
      // 可能被风控页拦截，或按钮点击未生效
      if (/_security_check|security-check/.test(location.href)) {
        diag('BOSS', '触发风控验证页', { url: location.href })
        return { outcome: 'failed', message: '触发风控验证页，请手动完成验证后重试' }
      }

      // 实测（2026-07-30）：在 /web/geek/jobs 联动页点「立即沟通」不会弹聊天框，
      // 会话已建立（消息角标 +1）但要到 /web/geek/chat 才能发消息。
      // 故此处不判失败，而是登记「待补发招呼语」，由用户在 chat 页跑「会话托管」补发。
      const greeting = (await ctx?.getGreeting?.()) || ''
      if (greeting) {
        pushPendingGreeting({
          platformJobId: card.platformJobId,
          title: card.title,
          company: card.company,
          greeting,
        })
        diag('BOSS', '会话已建立，招呼语转入待发队列（需到消息页补发）', {
          title: card.title,
          queued: pendingGreetingCount(),
        })
        return {
          outcome: 'applied',
          message: '已建立会话；招呼语待在消息页补发',
          greetingSent: false,
        }
      }

      const inputs = Array.from(document.querySelectorAll('textarea, [contenteditable=true], input[type=text]'))
        .map((el) => `${el.tagName}.${String((el as HTMLElement).className || '').slice(0, 40)}`)
        .slice(0, 10)
      diag('BOSS', '点击后未出现聊天输入框', { url: location.href, inputs })
      return { outcome: 'unknown', message: '已点沟通但未见聊天框，请在 BOSS 消息列表核对' }
    }

    // 发送打招呼语（复用后端主项目话术：template/llm 双模式 + 缓存）
    let greetingSent = false
    const greeting = (await ctx?.getGreeting?.()) || ''
    if (greeting) {
      try {
        input.focus()
        await this.delay(300, 700)
        // contenteditable 与 textarea 写值方式不同，两种都处理
        if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
          ;(input as HTMLTextAreaElement).value = greeting
          input.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          input.textContent = greeting
          input.dispatchEvent(new InputEvent('input', { bubbles: true }))
        }
        await this.delay(600, 1200)

        // 回车发送；部分版本需点「发送」按钮
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
        )
        await this.delay(800, 1500)

        const sendBtn = Array.from(document.querySelectorAll('button, .btn-send, [class*="send"]')).find(
          (el) => /^(发送|发\s*送)$/.test(this.text(el).replace(/\s/g, '')),
        ) as HTMLElement | undefined
        if (sendBtn) {
          sendBtn.click()
          await this.delay(600, 1200)
        }

        // 校验：招呼语是否出现在聊天记录里
        const body = document.body.textContent || ''
        greetingSent = body.includes(greeting.slice(0, 10))
        diag('BOSS', `招呼语${greetingSent ? '已上屏' : '未确认'}`, { greeting })
      } catch (e) {
        diag('BOSS', `发送招呼语异常: ${(e as Error).message}`)
      }
    }

    // 会话已建立即视为投递成功（与主项目 zhipin_action 同语义：出 chat_id 即成功）
    return {
      outcome: 'applied',
      message: greetingSent ? '已发起沟通并发送招呼语' : '已发起沟通（招呼语未确认）',
      greetingSent,
    }
  }

  /** 翻页：BOSS 列表分页按钮 */
  async nextPage(): Promise<boolean> {
    const candidates = Array.from(
      document.querySelectorAll('a, button, li, .options-pages *'),
    ) as HTMLElement[]
    const btn = candidates.find((el) => {
      const t = this.text(el).replace(/\s/g, '')
      if (t !== '下一页' && t !== '>') return false
      const cls = String(el.className || '')
      return !/disabled/.test(cls) && el.getAttribute('aria-disabled') !== 'true'
    })
    if (!btn) {
      diag('BOSS', '无可用「下一页」（BOSS 第2页起常被风控，属预期）')
      return false
    }
    btn.scrollIntoView({ block: 'center' })
    await this.delay(600, 1200)
    btn.click()
    await this.delay(3500, 6000)
    return true
  }

  /**
   * 找「立即沟通」按钮。
   *
   * root 省略时搜全页——BOSS 联动布局的按钮在右侧详情区，不在卡片内。
   * 只认可见元素，避免命中隐藏模板节点。
   */
  private findChatButton(root?: ParentNode, silent = false): HTMLElement | null {
    const scope = root || document
    const candidates = Array.from(
      scope.querySelectorAll(
        'a, button, .btn-startchat, [class*="startchat"], [class*="btn-chat"], span, div',
      ),
    )
    const hit = candidates.find((el) => {
      const t = this.text(el).replace(/\s/g, '')
      if (t !== '立即沟通' && t !== '继续沟通') return false
      // 必须可见：BOSS 页面有隐藏的按钮模板
      const r = (el as HTMLElement).getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }) as HTMLElement | undefined

    if (!hit && !silent) {
      const texts = Array.from(new Set(
        candidates
          .map((el) => this.text(el).replace(/\s/g, ''))
          .filter((t) => t && t.length < 10),
      ))
      diag('BOSS', '未找到沟通按钮，候选文本采样', texts.slice(0, 20))
    }
    return hit || null
  }

  /**
   * 处理「已向BOSS发送消息」确认弹窗。
   *
   * BOSS 点「立即沟通」后会自动发出账号设置里的默认招呼语，并弹出此确认框
   * （标题「已向BOSS发送消息」，正文即已发出的招呼语，按钮「留在此页」/「继续沟通」）。
   *
   * 必须点「留在此页」：
   *   - 不处理 → 弹窗遮罩挡住页面，后续岗位全部报「未出现聊天输入框」
   *     （实测 14:32 第一个投成功后弹窗未关，14:35 第二个即被挡死）
   *   - 点「继续沟通」→ 跳转 /web/geek/chat，投递循环中断
   *
   * @returns 弹窗中已发出的招呼语文本；未出现弹窗返回 null
   */
  private async dismissGreetingSentDialog(timeout = 6000): Promise<string | null> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      // 限制容器体积，避免命中整个 body（但弹窗内容可能较长，放宽到 800）
      const dialog = (Array.from(document.querySelectorAll('div, section')) as HTMLElement[]).find(
        (d) => {
          const t = (d.textContent || '').replace(/\s/g, '')
          if (!/已向BOSS发送消息|已向Boss发送消息/i.test(t)) return false
          if (t.length > 800) return false  // 放宽：招呼语+提示+按钮可能超 300
          const r = d.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        },
      )

      if (dialog) {
        // 招呼语正文＝弹窗内最长的那段文本（排除标题、提示与按钮）
        const sentText =
          Array.from(dialog.querySelectorAll('p, div, span'))
            .map((el) => (el.textContent || '').trim())
            .filter(
              (t) =>
                t.length > 8 &&
                !/已向BOSS发送消息|如需修改打招呼内容|留在此页|继续沟通/i.test(t),
            )
            .sort((a, b) => b.length - a.length)[0] || ''

        const stay = (
          Array.from(dialog.querySelectorAll('button, a, div, span')) as HTMLElement[]
        ).find((el) => {
          const t = (el.textContent || '').replace(/\s/g, '')
          if (t !== '留在此页') return false
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        })

        if (stay) {
          stay.click()
          await this.delay(600, 1000)
          diag('BOSS', 'BOSS 已自动发招呼语，点「留在此页」关闭弹窗', {
            sent: sentText.slice(0, 40),
          })
          return sentText || '(BOSS 默认招呼语)'
        } else {
          // 找不到按钮也要把情况记下来，否则下次只能看到「未出现聊天输入框」
          diag('BOSS', '发现发送确认弹窗但无「留在此页」按钮', {
            texts: Array.from(dialog.querySelectorAll('button, a, span, div'))
              .map((el) => (el.textContent || '').replace(/\s/g, ''))
              .filter((t) => t && t.length < 20)
              .slice(0, 15),
          })
          // 找不到按钮也视为弹窗存在，返回招呼语（避免走入队逻辑重复发送）
          return sentText || '(BOSS 默认招呼语，但未找到关闭按钮)'
        }
      }
      await this.delay(300, 500)
    }
    return null
  }

  /** 轮询等待详情区的沟通按钮出现（点卡片后详情异步加载） */
  private async waitForChatButton(timeout = 8000): Promise<HTMLElement | null> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const btn = this.findChatButton(undefined, true) // 全页 + 静默（避免刷屏）
      if (btn) return btn
      await this.delay(400, 600)
    }
    return null
  }

  /** 采样详情区可见短文本，用于诊断按钮文案变化 */
  private sampleDetailTexts(): string[] {
    const scope =
      document.querySelector('.job-detail-box, .job-detail, [class*="job-detail"]') || document.body
    return Array.from(
      new Set(
        Array.from(scope.querySelectorAll('a, button, span, div'))
          .filter((el) => {
            const r = (el as HTMLElement).getBoundingClientRect()
            return r.width > 0 && r.height > 0
          })
          .map((el) => this.text(el).replace(/\s/g, ''))
          .filter((t) => t && t.length <= 8),
      ),
    ).slice(0, 25)
  }
}
