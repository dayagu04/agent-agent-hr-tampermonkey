import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ diag: vi.fn() }))

import { readDeliveryState } from './boss-chat'
import { BossPlatform } from './boss'

// 结构照 2026-10-21 实测：
// li.item-myself > .message-content > .text > i.message-status + p > span
function bubble(statusCls: string, statusText: string): HTMLElement {
  const li = document.createElement('li')
  li.className = 'message-item item-myself'
  const st = statusCls
    ? '<i class="message-status ' + statusCls + '">' + statusText + '</i>'
    : ''
  const body = '<p><span class="text-content">测试消息发送功能</span></p>'
  li.innerHTML = '<div class="message-content"><div class="text">' + st + body + '</div></div>'
  return li
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('message delivery state (BOSS receipt marker)', () => {
  it('reads the measured 送达 marker and distinguishes platform and custom application greetings', async () => {
    expect(readDeliveryState(bubble('status-delivery', '送达'))).toBe('delivered')
    vi.useFakeTimers()
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 500, bottom: 500, width: 500, height: 500, toJSON: () => ({}),
    })
    try {
      const greeting = '测试消息发送功能完整指定文案'
      for (const mode of ['platform_default', 'draft', 'different_suffix', 'failed', 'agent']) {
        document.body.innerHTML = '<button id="start">立即沟通</button><section id="chat"><ul></ul><div id="chat-input" contenteditable="true"></div><button class="btn-send">发送</button></section>'
        const start = document.querySelector<HTMLElement>('#start')!
        start.scrollIntoView = vi.fn()
        const input = document.querySelector<HTMLElement>('#chat-input')!
        const messages = document.querySelector('#chat ul')!
        const previous = bubble('status-delivery', '送达')
        previous.querySelector('.text-content')!.textContent = greeting
        messages.appendChild(previous)
        const clicked = vi.fn(() => {
          if (mode === 'platform_default') document.body.insertAdjacentHTML('beforeend', '<div>已向BOSS发送消息<button>留在此页</button></div>')
        })
        start.addEventListener('click', clicked)
        const sent = vi.fn()
        document.querySelector('.btn-send')!.addEventListener('click', sent)
        const entered = vi.fn(() => {
          if (mode === 'draft') return
          const next = bubble(mode === 'failed' ? 'status-failed' : 'status-delivery', mode === 'failed' ? '发送失败' : '送达')
          next.querySelector('.text-content')!.textContent = mode === 'different_suffix' ? greeting + '其他内容' : greeting
          messages.appendChild(next)
        })
        input.addEventListener('keydown', entered)
        const getGreeting = vi.fn(async () => greeting)
        const pending = new BossPlatform().applyJob({ platformJobId: 'job-1', title: '岗位', company: '公司' }, { getGreeting })
        await vi.runAllTimersAsync()
        const result = await pending
        expect(result).toMatchObject({
          outcome: 'applied', greetingSent: mode === 'platform_default' || mode === 'agent',
          greetingSource: mode === 'platform_default' || mode === 'agent' ? mode : 'unknown',
          customGreetingSent: mode === 'agent',
        })
        expect(clicked).toHaveBeenCalledTimes(1)
        expect(getGreeting).toHaveBeenCalledTimes(mode === 'platform_default' ? 0 : 1)
        expect(entered).toHaveBeenCalledTimes(mode === 'platform_default' ? 0 : 1)
        expect(sent).toHaveBeenCalledTimes(mode === 'platform_default' ? 0 : 1)
        if (mode === 'platform_default') expect(result.message).toBe('已建立会话，BOSS 已发送默认招呼语')
        if (mode === 'draft') expect(input.textContent).toBe(greeting)
      }
    } finally { geometry.mockRestore(); vi.useRealTimers() }
  })

  it('reads the measured 已读 marker as read', () => {
    expect(readDeliveryState(bubble('status-read', '已读'))).toBe('read')
  })

  it('reports none when BOSS has not stamped a receipt yet', () => {
    expect(readDeliveryState(bubble('', ''))).toBe('none')
  })
})
