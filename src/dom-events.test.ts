import { describe, expect, it, vi } from 'vitest'
import { clickDirect } from './dom-events'

describe('synthetic DOM clicks', () => {
  it('emits exactly one terminal click for an irreversible action', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
      toJSON: () => ({}),
    })
    const handler = vi.fn()
    button.addEventListener('click', handler)

    clickDirect(button)

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('keeps the click bubbling for delegated Vue handlers', () => {
    const row = document.createElement('div')
    const label = document.createElement('span')
    row.appendChild(label)
    document.body.appendChild(row)
    vi.spyOn(label, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
      toJSON: () => ({}),
    })
    const delegated = vi.fn()
    row.addEventListener('click', delegated)

    clickDirect(label)

    expect(delegated).toHaveBeenCalledTimes(1)
  })
})
