import { describe, expect, it, vi } from 'vitest'
import {
  classifyCard,
  findDialogButton,
  findResumeDialog,
  isActionCardAllowed,
  isContactCardAllowed,
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
