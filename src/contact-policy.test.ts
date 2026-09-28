import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_POLICY,
  contactChannelFromQuestion,
  isContactExchangeAllowed,
  normalizeAgentPolicy,
} from './contact-policy'

describe('contact policy', () => {
  it('normalizes backend policy and boolean channel flags', () => {
    const policy = normalizeAgentPolicy(
      {
        mode: 'full_auto',
        actions: { exchange_phone: 'allow' },
      },
      { phone: true, wechat: false, allow_platform_card: true },
    )
    expect(policy.mode).toBe('full_auto')
    expect(policy.contact.channels).toEqual(['phone'])
    expect(isContactExchangeAllowed(policy, 'phone')).toBe(true)
    expect(isContactExchangeAllowed(policy, 'wechat')).toBe(false)
  })

  it('does not allow an unconfigured or unknown channel in full_auto', () => {
    expect(isContactExchangeAllowed(DEFAULT_AGENT_POLICY, 'phone')).toBe(false)
    const policy = normalizeAgentPolicy({}, { channels: ['email'] })
    expect(isContactExchangeAllowed(policy, 'phone')).toBe(false)
    expect(isContactExchangeAllowed(policy, null)).toBe(false)
  })

  it('respects explicit deny and disabled platform cards', () => {
    const denied = normalizeAgentPolicy(
      { mode: 'full_auto', actions: { exchange_phone: 'deny' } },
      { channels: ['phone'] },
    )
    expect(isContactExchangeAllowed(denied, 'phone')).toBe(false)
    const disabled = normalizeAgentPolicy({}, { channels: ['phone'], allowPlatformCard: false })
    expect(isContactExchangeAllowed(disabled, 'phone')).toBe(false)
  })

  it('extracts explicit channels from card text', () => {
    expect(contactChannelFromQuestion('是否方便交换微信？')).toBe('wechat')
    expect(contactChannelFromQuestion('请留下您的邮箱')).toBe('email')
    expect(contactChannelFromQuestion('方便交换联系方式吗')).toBeNull()
  })
})

