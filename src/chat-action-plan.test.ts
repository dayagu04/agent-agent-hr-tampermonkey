import { describe, expect, it } from 'vitest'
import {
  actionForCard,
  cardActionAllowed,
  normalizeChatActionPlan,
} from './chat-action-plan'

describe('structured BOSS fact/action response', () => {
  it('keeps interview facts separate and executes only planned actions', () => {
    const plan = normalizeChatActionPlan({
      action_plan_version: 1,
      actions_authoritative: true,
      facts: {
        interview_time: '周五 15:00',
        expected_cities: ['深圳'],
        location: '深圳南山',
      },
      reply: '可以，周五下午沟通。',
      actions: [
        {
          type: 'reply_text',
          text: '可以，周五下午沟通。',
          idempotency_key: 'reply:fixture:1',
        },
        {
          type: 'send_resume',
          allowed: true,
          action_id: 41,
          idempotency_key: 'resume:fixture:1',
        },
        {
          type: 'exchange_contact',
          allowed: true,
          channels: ['phone'],
          idempotency_key: 'contact:fixture:1',
        },
        {
          type: 'location_confirm',
          decision: 'allow',
        },
      ],
    })

    expect(plan.authoritative).toBe(true)
    expect(plan.facts.interview_time).toBe('周五 15:00')
    expect(plan.facts.expected_cities).toEqual(['深圳'])
    expect(plan.replyText).toBe('可以，周五下午沟通。')
    expect(plan.sendResume).toBe(true)
    expect(cardActionAllowed(plan, 'resume_request')).toBe(true)
    expect(cardActionAllowed(plan, 'contact_exchange')).toBe(true)
    expect(actionForCard(plan, 'location_confirm')?.decision).toBe('allow')
  })

  it('distinguishes a planned location rejection from a policy denial', () => {
    const plan = normalizeChatActionPlan({
      action_plan_version: 1,
      actions_authoritative: true,
      actions: [{ type: 'location_confirm', decision: 'reject' }],
    })
    expect(cardActionAllowed(plan, 'location_confirm')).toBe(true)
    expect(actionForCard(plan, 'location_confirm')?.decision).toBe('reject')
  })

  it('does not turn a fact or a denied action into a contact exchange', () => {
    const plan = normalizeChatActionPlan({
      action_plan_version: 1,
      actions_authoritative: true,
      facts: { phone: 'should never be supplied to the browser log' },
      actions: [
        { type: 'exchange_contact', allowed: false, channels: ['phone'], reason: 'policy' },
      ],
    })

    expect(plan.facts).not.toHaveProperty('phone')
    expect(plan.contactAction?.allowed).toBe(false)
    expect(cardActionAllowed(plan, 'contact_exchange')).toBe(false)
  })

  it('never promotes requested channels or contact values from action payload', () => {
    const plan = normalizeChatActionPlan({
      action_plan_version: 1,
      actions_authoritative: true,
      actions: [{
        type: 'exchange_contact',
        allowed: true,
        requested_channels: ['phone'],
        payload: { phone: 'redacted-fixture', fact_slot: 'phone' },
      }],
    })
    expect(plan.contactAction?.channels).toEqual([])
    expect(plan.contactAction?.payload).toEqual({ fact_slot: 'phone' })
  })

  it('fails closed for an unknown action and an unplanned authoritative card', () => {
    const plan = normalizeChatActionPlan({
      action_plan_version: 1,
      actions_authoritative: true,
      facts: { city: '深圳' },
      actions: [{ type: 'provide_phone_value', allowed: true }],
    })

    expect(plan.actions[0]?.type).toBe('unknown')
    expect(cardActionAllowed(plan, 'resume_request')).toBe(false)
    expect(cardActionAllowed(plan, 'location_confirm')).toBe(false)
  })

  it('does not send top-level reply text when the authoritative reply action is denied', () => {
    const plan = normalizeChatActionPlan({
      action_plan_version: 1,
      actions_authoritative: true,
      reply: '这段文字不能绕过动作权限。',
      actions: [{ type: 'reply_text', allowed: false }],
    })
    expect(plan.replyText).toBe('')
  })

  it('retains v0.6.8 top-level compatibility when no versioned plan is present', () => {
    const plan = normalizeChatActionPlan({
      reply: '收到，我会补充简历。',
      send_resume: true,
      contact_exchange: { allowed: true, channel: 'email', action_id: 9 },
    })

    expect(plan.authoritative).toBe(false)
    expect(plan.replyText).toBe('收到，我会补充简历。')
    expect(plan.sendResume).toBe(true)
    expect(plan.contactAction?.channels).toEqual(['email'])
    expect(cardActionAllowed(plan, 'resume_request')).toBeNull()
  })
})
