// BOSS 会话行时间解析 —— 独立成模块便于单元测试。
//
// BOSS 列表只显示相对/简略时间文本（"刚刚"/"昨天"/"HH:mm"/"MM-DD"/"YYYY-MM-DD"），
// 跨天边界（凌晨 0 点前后）按字面量解析会差出近一天：例如 00:10 看到昨天 23:50
// 的消息，若把 "HH:mm" 当今天，会算出 20 分钟前而不是 23 小时前。

/** "3分钟前"/"5小时前"/"2天前" 等相对时间 → epoch 毫秒 */
const RELATIVE_RE = /^(\d+)\s*(秒|分钟|小时|天|周|个月|月)前$/

const UNIT_MS: Record<string, number> = {
  秒: 1000,
  分钟: 60_000,
  小时: 3_600_000,
  天: 86_400_000,
  周: 7 * 86_400_000,
  月: 30 * 86_400_000,
}

/**
 * BOSS 会话行时间文本 → epoch 毫秒。
 *
 * 规则：
 * - "刚刚" → now；
 * - "N秒/分钟/小时/天/周/个月前" → now 前推；
 * - 纯数字 → epoch 秒/毫秒（>1e12 视为毫秒）；
 * - "昨天 [HH:mm]" → 昨天对应时刻；
 * - "HH:mm" → 若已过当前时刻则视为昨天（跨天修正）；
 * - "MM-DD [HH:mm]" → 今年；构造出的时间在未来（跨年）则视为去年；
 * - "YYYY-MM-DD [HH:mm]" → 字面时间。
 * 解析不了返回 null（调用方改用 DB 时间兜底）。
 */
export function parseThreadTimeMs(text: string, now: number): number | null {
  const t = (text || '').trim()
  if (!t) return null
  if (t === '刚刚') return now

  const num = Number(t)
  if (!Number.isNaN(num)) {
    // 纯数字：可能是 epoch 秒/毫秒，也可能是"3分钟前"这类被解析成数字
    return num > 1e12 ? num : now - num * 1000
  }

  const rel = t.match(RELATIVE_RE)
  if (rel) {
    const unit = UNIT_MS[rel[2]]
    if (unit) return now - Number(rel[1]) * unit
  }

  const nowDate = new Date(now)
  const y = nowDate.getFullYear()

  // 昨天 [HH:mm]
  const yd = t.match(/^昨天(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (yd) {
    const d = new Date(now)
    d.setDate(d.getDate() - 1)
    if (yd[1]) {
      d.setHours(Number(yd[1]), Number(yd[2]), 0, 0)
    } else {
      // 无时刻的「昨天」最晚也只能是昨天 23:59:59 —— 按最晚时刻保守估算，
      // 避免凌晨把昨晚刚聊过的会话误判成超时（删除不可逆，宁可多留一轮）
      d.setHours(23, 59, 59, 999)
    }
    return d.getTime()
  }

  const full = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (full) {
    return new Date(
      Number(full[1]), Number(full[2]) - 1, Number(full[3]),
      full[4] ? Number(full[4]) : 0, full[5] ? Number(full[5]) : 0,
    ).getTime()
  }

  const md = t.match(/^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (md) {
    let d = new Date(
      y, Number(md[1]) - 1, Number(md[2]),
      md[3] ? Number(md[3]) : 0, md[4] ? Number(md[4]) : 0,
    )
    // 构造出的时间还在未来（比如 12-31 在 01-01 之后被构造）→ 视为去年
    if (d.getTime() > now) d = new Date(
      y - 1, Number(md[1]) - 1, Number(md[2]),
      md[3] ? Number(md[3]) : 0, md[4] ? Number(md[4]) : 0,
    )
    return d.getTime()
  }

  const hm = t.match(/^(\d{1,2}):(\d{2})$/)
  if (hm) {
    const d = new Date(now)
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0)
    // 凌晨 0 点前后：HH:mm 已过当前时刻 → 是昨天的消息
    if (d.getTime() > now) d.setDate(d.getDate() - 1)
    return d.getTime()
  }
  return null
}
