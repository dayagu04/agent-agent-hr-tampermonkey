// DOM 事件监控工具 — 用于调试删除功能的悬停按钮出现逻辑
//
// 用途：用户手动执行一次删除操作时，记录完整的事件序列和DOM变化，
// 帮助定位「···」操作按钮是如何被唤出的（鼠标事件、Vue字段、DOM结构变化）。

import { diag } from './logger'

interface EventRecord {
  timestamp: number
  type: string
  target: string
  targetRect?: { x: number; y: number; w: number; h: number }
  vueFields?: string[]
  classList?: string[]
}

interface MutationRecord {
  timestamp: number
  type: string // 'childList' | 'attributes'
  target: string
  addedClasses?: string[]
  removedClasses?: string[]
  addedNodes?: string[]
  removedNodes?: string[]
}

export class DOMMonitor {
  private events: EventRecord[] = []
  private mutations: MutationRecord[] = []
  private eventListeners: Array<() => void> = []
  private mutationObserver: MutationObserver | null = null
  private isRunning = false

  /**
   * 启动监控。
   *
   * 监听所有鼠标事件（用于追踪悬停序列）和 DOM 变化（用于追踪按钮出现）。
   * 只记录最近 1000 个事件和 500 个变化，防止内存爆炸。
   */
  start(): void {
    if (this.isRunning) {
      diag('MONITOR', 'DOM监控已在运行，跳过重复启动')
      return
    }

    this.isRunning = true
    this.events = []
    this.mutations = []

    // 监听所有鼠标事件（捕获阶段，能拿到所有事件包括被 stopPropagation 的）
    const mouseEvents = ['mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click']
    for (const eventType of mouseEvents) {
      const handler = (e: Event) => this.recordEvent(eventType, e)
      document.addEventListener(eventType, handler, true)
      this.eventListeners.push(() => document.removeEventListener(eventType, handler, true))
    }

    // 监听 DOM 变化（属性变化用于追踪 class 修改，子树变化用于追踪节点插入删除）
    this.mutationObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        this.recordMutation(m)
      }
    })
    this.mutationObserver.observe(document.body, {
      childList: true, // 监听节点增删
      subtree: true, // 递归监听整棵树
      attributes: true, // 监听属性变化
      attributeFilter: ['class', 'style'], // 只关注 class 和 style（按钮显隐通常靠这两个）
      attributeOldValue: true, // 记录旧值，便于对比
    })

    diag('MONITOR', 'DOM监控已启动（鼠标事件 + DOM变化）')
  }

  /**
   * 停止监控并保留已记录的数据（可导出）。
   */
  stop(): void {
    if (!this.isRunning) return

    // 移除所有事件监听器
    for (const cleanup of this.eventListeners) {
      cleanup()
    }
    this.eventListeners = []

    // 断开 MutationObserver
    if (this.mutationObserver) {
      this.mutationObserver.disconnect()
      this.mutationObserver = null
    }

    this.isRunning = false
    diag('MONITOR', 'DOM监控已停止', {
      eventsCount: this.events.length,
      mutationsCount: this.mutations.length,
    })
  }

  /**
   * 记录鼠标事件。
   */
  private recordEvent(type: string, e: Event): void {
    const target = e.target as HTMLElement
    if (!target || !target.tagName) return

    // 提取 Vue 实例的所有可用字段（非私有）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vue = (target as any).__vue__
    const vueFields = vue
      ? Object.keys(vue)
          .filter((k) => !k.startsWith('_') && !k.startsWith('$'))
          .slice(0, 30)
      : undefined

    // 记录元素位置和尺寸（用于判断按钮是否可见）
    const rect = target.getBoundingClientRect()
    const targetRect =
      rect.width > 0 || rect.height > 0
        ? {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          }
        : undefined

    this.events.push({
      timestamp: Date.now(),
      type,
      target: this.getSelector(target),
      targetRect,
      vueFields,
      classList: Array.from(target.classList || []),
    })

    // 只保留最近 1000 个事件
    if (this.events.length > 1000) {
      this.events.shift()
    }
  }

  /**
   * 记录 DOM 变化。
   */
  private recordMutation(m: globalThis.MutationRecord): void {
    const target = m.target as HTMLElement
    if (!target || !target.tagName) return

    const record: MutationRecord = {
      timestamp: Date.now(),
      type: m.type,
      target: this.getSelector(target),
    }

    // 属性变化（特别关注 class 的增删）
    if (m.type === 'attributes' && m.attributeName === 'class') {
      const oldClasses = m.oldValue ? m.oldValue.split(/\s+/).filter(Boolean) : []
      const newClasses = Array.from(target.classList || [])
      record.addedClasses = newClasses.filter((c) => !oldClasses.includes(c))
      record.removedClasses = oldClasses.filter((c) => !newClasses.includes(c))
    }

    // 子节点变化（追踪操作按钮的插入）
    if (m.type === 'childList') {
      record.addedNodes = Array.from(m.addedNodes)
        .map((n) => this.getSelector(n as HTMLElement))
        .filter(Boolean)
        .slice(0, 5)
      record.removedNodes = Array.from(m.removedNodes)
        .map((n) => this.getSelector(n as HTMLElement))
        .filter(Boolean)
        .slice(0, 5)
    }

    this.mutations.push(record)

    // 只保留最近 500 个变化
    if (this.mutations.length > 500) {
      this.mutations.shift()
    }
  }

  /**
   * 生成元素的可读选择器（用于日志显示）。
   *
   * 格式: tagName#id.class[widthxheight]
   */
  private getSelector(el: HTMLElement): string {
    if (!el || !el.tagName) return 'null'

    const tag = el.tagName.toLowerCase()
    const id = el.id ? `#${el.id}` : ''
    const cls = el.className
      ? `.${String(el.className).trim().split(/\s+/).slice(0, 2).join('.')}`
      : ''

    // 添加尺寸信息（0x0 的元素通常是隐藏的）
    const rect = el.getBoundingClientRect()
    const size = `[${Math.round(rect.width)}x${Math.round(rect.height)}]`

    return `${tag}${id}${cls}${size}`
  }

  /**
   * 导出监控日志为 JSON 字符串。
   *
   * 用户在设置页点「导出DOM监控日志」时调用，将返回值复制给开发者分析。
   */
  export(): string {
    const data = {
      metadata: {
        url: location.href,
        ua: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        timestamp: new Date().toISOString(),
        isRunning: this.isRunning,
      },
      events: this.events,
      mutations: this.mutations,
    }

    return JSON.stringify(data, null, 2)
  }

  /**
   * 清空已记录的数据（不停止监控）。
   */
  clear(): void {
    this.events = []
    this.mutations = []
    diag('MONITOR', 'DOM监控数据已清空')
  }

  /**
   * 获取监控状态摘要。
   */
  getStatus(): { running: boolean; eventsCount: number; mutationsCount: number } {
    return {
      running: this.isRunning,
      eventsCount: this.events.length,
      mutationsCount: this.mutations.length,
    }
  }
}

// 全局单例
export const domMonitor = new DOMMonitor()
