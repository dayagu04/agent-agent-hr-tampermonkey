import { describe, expect, it } from 'vitest'
import { selectChatActionId, shouldReportContactOnly } from './chat-action-report'

describe('chat action reporting', () => {
  it('acknowledges a shared action once after text/resume completion', () => {
    expect(selectChatActionId(12, 12)).toBe(12)
    expect(shouldReportContactOnly(true, true)).toBe(false)
  })

  it('acknowledges contact-only actions only after a successful card', () => {
    expect(selectChatActionId(null, 34)).toBe(34)
    expect(shouldReportContactOnly(false, true)).toBe(true)
    expect(shouldReportContactOnly(false, false)).toBe(false)
  })
})
