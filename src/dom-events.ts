// 点击事件工具 —— BOSS 等平台用 Vue 事件委托监听完整鼠标/指针事件序列，
// 裸 el.click() 不产生这些事件，合成点击需按真实序列派发。

interface EventPoint {
  clientX: number
  clientY: number
}

function baseEvent(pos: EventPoint): EventInit & MouseEventInit {
  // 不能传 view: window —— 油猴沙箱里的 window 是包装对象，
  // 构造 MouseEvent 会抛 "Failed to convert value to 'Window'"。
  return { bubbles: true, cancelable: true, composed: true, clientX: pos.clientX, clientY: pos.clientY }
}

function pointerEvent(el: HTMLElement, type: string, pos: EventPoint, buttons: number): void {
  const init = {
    ...baseEvent(pos),
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons,
  } as PointerEventInit
  // 老浏览器无 PointerEvent 时忽略指针事件，后续 mouse 序列仍可触发 handler
  try {
    el.dispatchEvent(new PointerEvent(type, init))
  } catch {
    /* ignore */
  }
}

function centerOf(el: HTMLElement): EventPoint {
  const r = el.getBoundingClientRect()
  return {
    clientX: Math.round(r.left + (r.width || 1) / 2),
    clientY: Math.round(r.top + (r.height || 1) / 2),
  }
}

/**
 * 直接对元素派发完整点击序列，不经 elementFromPoint。
 *
 * 用于元素被其它节点遮挡或尺寸为 0（elementFromPoint 会命中别的节点）的场景。
 */
export function clickDirect(el: HTMLElement): void {
  const pos = centerOf(el)
  pointerEvent(el, 'pointerover', pos, 1)
  pointerEvent(el, 'pointerenter', pos, 1)
  pointerEvent(el, 'pointerdown', pos, 1)
  el.dispatchEvent(new MouseEvent('mouseover', baseEvent(pos)))
  el.dispatchEvent(new MouseEvent('mouseenter', baseEvent(pos)))
  el.dispatchEvent(new MouseEvent('mousedown', { ...baseEvent(pos), button: 0, buttons: 1 }))
  pointerEvent(el, 'pointerup', pos, 0)
  el.dispatchEvent(new MouseEvent('mouseup', { ...baseEvent(pos), button: 0, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('click', { ...baseEvent(pos), button: 0, detail: 1 }))
  try {
    el.click()
  } catch {
    /* ignore */
  }
}

/**
 * 模拟真实鼠标点击：先滚动到元素，再把点击派发给「坐标处最上层的元素」。
 *
 * 平台的监听常挂在内层节点，直接点容器不会冒泡到正确的 handler，
 * 因此用 elementFromPoint 找到实际可见节点再派发。
 */
export function realClick(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center' })
  const pos = centerOf(el)
  const target = (document.elementFromPoint(pos.clientX, pos.clientY) as HTMLElement) || el
  clickDirect(target)
}
