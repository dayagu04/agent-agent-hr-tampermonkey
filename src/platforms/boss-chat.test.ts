import { describe, expect, it } from 'vitest'
import {
  classifyCard,
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
