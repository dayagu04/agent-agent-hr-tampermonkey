import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyCard,
  completeResumeSend,
  findDialogButton,
  findResumeDialog,
  isActionCardAllowed,
  isContactCardAllowed,
  resumeDialogKind,
  selectResumeInDialog,
} from './boss-chat'
import { normalizeAgentPolicy } from '../contact-policy'

describe('BOSS interaction card classification', () => {
  it('does not classify phone interview cards as contact exchange', () => {
    expect(classifyCard('电话面试时间方便吗？')).toBe('unknown')
    expect(classifyCard('电话沟通一下工作内容')).toBe('unknown')
    expect(classifyCard('请留下手机号')).toBe('contact_exchange')
    expect(classifyCard('方便交换微信吗？')).toBe('contact_exchange')
  })

  it('enforces backend allowed channels for every contact card', () => {
    const policy = normalizeAgentPolicy(
      { mode: 'full_auto' },
      { channels: ['phone', 'wechat', 'email'] },
    )
    const decision = {
      provided: true,
      allowed: true,
      channel: null,
      channels: ['phone' as const],
      actionId: null,
    }
    expect(isContactCardAllowed(decision, 'phone', policy)).toBe(true)
    expect(isContactCardAllowed(decision, 'wechat', policy)).toBe(false)
    expect(isContactCardAllowed({ ...decision, channels: [] }, 'phone', policy)).toBe(false)
  })

  it('blocks resume and location card side effects when their actions are denied', () => {
    const policy = normalizeAgentPolicy(
      {
        mode: 'full_auto',
        actions: { send_resume: 'deny', answer_city: 'allow', negotiate_interview: 'allow' },
      },
      { channels: [] },
    )
    expect(isActionCardAllowed(policy, 'resume_request')).toBe(false)
    expect(isActionCardAllowed(policy, 'location_confirm')).toBe(true)

    const locationDenied = normalizeAgentPolicy(
      {
        mode: 'full_auto',
        actions: { answer_city: 'allow', negotiate_interview: 'ask_once' },
      },
      { channels: [] },
    )
    expect(isActionCardAllowed(locationDenied, 'location_confirm')).toBe(false)
  })
})

describe('BOSS resume picker DOM handling', () => {
  function setRect(el: Element, width: number, height: number): void {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    })
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('finds the visible resume picker and its send button through a portal dialog', () => {
    document.body.innerHTML = `
      <div role="dialog" class="upload-resume-dialog">
        <div class="dialog-header">请选择要发送的简历</div>
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const button = dialog.querySelector('button') as HTMLElement
    setRect(dialog, 720, 398)
    setRect(button, 100, 40)

    expect(findResumeDialog()).toBe(dialog)
    expect(findDialogButton(dialog, /^(发送|确定)$/)).toBe(button)
  })

  it('keeps recognizing a picker that also offers an upload-resume entry', () => {
    document.body.innerHTML = `
      <div role="dialog" class="dialog-wrap active">
        <div class="dialog-header">请选择要发送的简历</div>
        <button type="button">上传简历</button>
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const header = dialog.querySelector('.dialog-header') as HTMLElement
    setRect(dialog, 720, 398)
    setRect(header, 240, 40)

    expect(findResumeDialog()).toBe(dialog)
  })

  it('returns the actionable ancestor and preserves its disabled state', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <button type="button" disabled><span>发送</span></button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    const span = dialog.querySelector('span') as HTMLElement
    setRect(dialog, 720, 398)
    setRect(button, 100, 40)
    setRect(span, 80, 24)

    expect(findDialogButton(dialog, /^发送$/)).toBe(button)
    expect(button.disabled).toBe(true)
  })

  it('finds an icon-only action by its accessible label', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <button type="button" aria-label="确认发送"><svg></svg></button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    setRect(dialog, 720, 398)
    setRect(button, 100, 40)

    expect(findDialogButton(dialog, /^确认发送$/)).toBe(button)
  })

  it('selects the configured resume before a disabled send button can become enabled', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item"><input type="radio" name="resume"><span>候选人简历 C++.pdf</span></label>
        <button type="button" disabled><span>发送</span></button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const row = dialog.querySelector('label') as HTMLElement
    const name = dialog.querySelector('label span') as HTMLElement
    const input = dialog.querySelector('input') as HTMLInputElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    for (const el of [dialog, row, name, input, button, button.querySelector('span')!]) setRect(el, 100, 40)
    row.addEventListener('click', () => {
      input.checked = true
      button.disabled = false
    })

    expect(button.disabled).toBe(true)
    expect(selectResumeInDialog(dialog, '候选人简历C+++.pdf')).toBe(true)
    expect(input.checked).toBe(true)
    expect(button.disabled).toBe(false)
  })

  it('fails closed when the configured resume is not present', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item"><span>另一份材料.pdf</span></label>
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const option = dialog.querySelector('label span') as HTMLElement
    setRect(dialog, 720, 398)
    setRect(option, 200, 40)

    expect(selectResumeInDialog(dialog, '指定的软件工程师简历.pdf')).toBe(false)
  })

  it('classifies an unknown resume form separately from safe picker/confirm flows', () => {
    document.body.innerHTML = `
      <div class="dialog-wrap active">
        <div>请补充简历信息</div>
        <input required aria-label="必填字段">
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('.dialog-wrap') as HTMLElement

    expect(resumeDialogKind(dialog)).toBe('unknown')
  })

  it('selects first, waits for enablement, then sends exactly once', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item"><input type="radio"><span>后端工程师简历.pdf</span></label>
        <button type="button" disabled><span>发送</span></button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const row = dialog.querySelector('label') as HTMLElement
    const input = dialog.querySelector('input') as HTMLInputElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    for (const el of [dialog, row, input, row.querySelector('span')!, button, button.querySelector('span')!]) {
      setRect(el, 120, 40)
    }
    const selections = vi.fn(() => {
      input.checked = true
      button.disabled = false
    })
    const sends = vi.fn(() => dialog.remove())
    row.addEventListener('click', selections)
    button.addEventListener('click', sends)

    const result = completeResumeSend('后端工程师简历.pdf')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe(true)
    expect(selections).toHaveBeenCalledTimes(1)
    expect(sends).toHaveBeenCalledTimes(1)
  })

  it('does not retry an unconfirmed send click', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item selected"><span>后端工程师简历.pdf</span></label>
        <button type="button"><span>发送</span></button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const row = dialog.querySelector('label') as HTMLElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    for (const el of [dialog, row, row.querySelector('span')!, button, button.querySelector('span')!]) {
      setRect(el, 120, 40)
    }
    const sends = vi.fn()
    button.addEventListener('click', sends)

    const result = completeResumeSend('后端工程师简历.pdf')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe(false)
    expect(sends).toHaveBeenCalledTimes(1)
  })

  it('ignores hidden dialog remnants after the picker closes', () => {
    document.body.innerHTML = `
      <div class="dialog-wrap upload-resume-dialog">
        <div>请选择要发送的简历</div>
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('.dialog-wrap') as HTMLElement
    setRect(dialog, 0, 0)

    expect(findResumeDialog()).toBeNull()
  })
})
