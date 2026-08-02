// 枚举 BOSS 会话列表里**当前真实存在**的会话身份
//
// 为什么需要（2026-08-02 用户反馈）：面板的会话列表读的是后端
// `GET /api/conversations/list`（`conversations` 表），而用户在 BOSS 页面上
// **手动删掉**的会话，后端记录依然存在 —— 插件无从知道，于是那些会话一直显示，
// 30s 轮询也刷不掉（刷新拉回来的还是后端那份数据）。
//
// 「已删除」台账此前只记「经插件删除」的（deleteHRThread 成功后记账），
// 手动删除完全不可见。要覆盖手动删除，唯一可靠的信息源是 BOSS 页面本身：
// 把列表滚一遍、收集所有还在的会话身份，凡是后端有、BOSS 没有的，就是被手动
// 删掉的（或对方已失效）。
//
// 独立成文件的原因：boss-chat.ts 正被多方改动，且这里只做只读枚举，
// 与删除/回复链路无耦合。
import { diag } from '../logger'

const delay = (min: number, max: number) =>
  new Promise((r) => setTimeout(r, min + Math.random() * (max - min)))

/** 与 boss-chat.ts 的 SEL.thread 保持一致（那边是私有的，这里复制一份） */
const THREAD_SELECTORS = [
  '.geek-item',
  '.user-list li',
  '[class*="chat-user-item"]',
  'li[role="listitem"]',
]

function threadEls(): HTMLElement[] {
  for (const s of THREAD_SELECTORS) {
    const els = Array.from(document.querySelectorAll(s)) as HTMLElement[]
    if (els.length) return els
  }
  return []
}

/** 列表项的可见文本（含姓名+公司+职务拼接），压掉空白便于包含判断 */
function rowText(el: HTMLElement): string {
  return (el.textContent || '').replace(/\s+/g, '')
}

/** 找会话列表的滚动容器：按「实际可滚动」判定，不认样式（BOSS 用 overlay） */
function findScrollContainer(): HTMLElement | null {
  const first = threadEls()[0]
  if (!first) return null
  let cur: HTMLElement | null = first.parentElement
  let fallback: HTMLElement | null = null
  for (let i = 0; i < 10 && cur; i++) {
    const scrollable = cur.scrollHeight > cur.clientHeight + 4
    if (scrollable && /auto|scroll|overlay/.test(getComputedStyle(cur).overflowY)) return cur
    if (scrollable && !fallback) fallback = cur
    cur = cur.parentElement
  }
  return fallback
}

/**
 * 滚一遍会话列表，收集所有会话行的可见文本。
 *
 * 必须滚：BOSS 是虚拟列表，DOM 里恒定只有约 40 个节点，不滚只能看到一屏。
 * 结束条件是「连续 3 屏没有新身份」——行为特征，不依赖任何页面标记
 * （底部「没有更多了」是常驻占位符，不能用）。
 *
 * 结束后把滚动位置复位，避免打扰用户视野。
 */
export async function collectExistingThreadTexts(): Promise<string[] | null> {
  if (!threadEls().length) {
    diag('CHAT', '会话身份枚举：页面上没有会话列表，跳过')
    return null
  }

  const container = findScrollContainer()
  const seen = new Set<string>()
  const collect = () => {
    for (const el of threadEls()) {
      const t = rowText(el)
      if (t) seen.add(t)
    }
  }

  if (!container) {
    // 没有滚动容器（会话很少，一屏装得下）→ 直接收当前屏
    collect()
    diag('CHAT', `会话身份枚举完成（无需滚动）：${seen.size} 条`)
    return Array.from(seen)
  }

  const restore = container.scrollTop
  try {
    container.scrollTo({ top: 0 })
    await delay(350, 500)

    const step = Math.max(1, Math.floor(container.clientHeight * 0.8)) // 留 20% 重叠防漏
    const maxScroll = container.scrollHeight - container.clientHeight
    let emptyScreens = 0

    for (let screen = 0; screen < 300; screen++) {
      const before = seen.size
      collect()
      if (seen.size === before) {
        emptyScreens++
        if (emptyScreens >= 3) break
      } else {
        emptyScreens = 0
      }

      const target = step * (screen + 1)
      if (target > maxScroll + step) break
      container.scrollTo({ top: Math.min(target, maxScroll) })
      await delay(400, 550) // 等虚拟列表渲染新窗口
    }
  } finally {
    container.scrollTo({ top: restore })
  }

  diag('CHAT', `会话身份枚举完成：BOSS 列表现存 ${seen.size} 条`)
  return Array.from(seen)
}

/**
 * 判断某个会话（按公司名）是否还在 BOSS 列表里。
 *
 * 匹配方式与 deleteThread 一致：列表项文本是「姓名+公司+职务」拼接，
 * 而面板卡片只有公司名，故用 includes。同名公司多会话会误判为"还在"——
 * 这是保守方向，宁可漏标也不能把还在的会话标成已删除。
 */
export function threadTextsInclude(texts: string[], company: string): boolean {
  const target = company.replace(/\s+/g, '')
  if (!target) return true // 身份不可辨 → 当作还在，不标记
  return texts.some((t) => t.includes(target))
}
