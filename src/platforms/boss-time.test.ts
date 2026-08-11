import { describe, expect, it } from 'vitest'
import { parseThreadTimeMs } from './boss-time'

// 固定参考时刻：2026-08-08 00:10（本地时区），覆盖凌晨跨天场景
const now = new Date(2026, 7, 8, 0, 10, 0).getTime()

describe('parseThreadTimeMs', () => {
  it('「刚刚」返回当前时刻', () => {
    expect(parseThreadTimeMs('刚刚', now)).toBe(now)
  })

  it('相对时间（N秒/分钟/小时/天前）', () => {
    expect(parseThreadTimeMs('3分钟前', now)).toBe(now - 3 * 60_000)
    expect(parseThreadTimeMs('5小时前', now)).toBe(now - 5 * 3_600_000)
    expect(parseThreadTimeMs('2天前', now)).toBe(now - 2 * 86_400_000)
    expect(parseThreadTimeMs('30秒前', now)).toBe(now - 30_000)
  })

  it('跨天修正：凌晨 00:10 看到「23:50」是昨天而非今天', () => {
    const got = parseThreadTimeMs('23:50', now)
    expect(got).toBe(new Date(2026, 7, 7, 23, 50, 0).getTime())
  })

  it('同一天内「HH:mm」仍按今天解析', () => {
    const later = new Date(2026, 7, 8, 23, 55, 0).getTime()
    expect(parseThreadTimeMs('23:50', later)).toBe(
      new Date(2026, 7, 8, 23, 50, 0).getTime(),
    )
  })

  it('「昨天 HH:mm」精确到昨天对应时刻', () => {
    expect(parseThreadTimeMs('昨天 18:30', now)).toBe(
      new Date(2026, 7, 7, 18, 30, 0).getTime(),
    )
  })

  it('无时刻的「昨天」按昨天最晚时刻保守估算（不误判超时）', () => {
    expect(parseThreadTimeMs('昨天', now)).toBe(
      new Date(2026, 7, 7, 23, 59, 59, 999).getTime(),
    )
  })

  it('MM-DD 跨年修正：1 月初看到 12-31 是去年', () => {
    const jan = new Date(2026, 0, 3, 9, 0, 0).getTime()
    expect(parseThreadTimeMs('12-31 23:00', jan)).toBe(
      new Date(2025, 11, 31, 23, 0, 0).getTime(),
    )
  })

  it('YYYY-MM-DD 字面解析', () => {
    expect(parseThreadTimeMs('2026-08-01 12:00', now)).toBe(
      new Date(2026, 7, 1, 12, 0, 0).getTime(),
    )
  })

  it('解析不了返回 null', () => {
    expect(parseThreadTimeMs('', now)).toBeNull()
    expect(parseThreadTimeMs('   ', now)).toBeNull()
    expect(parseThreadTimeMs('随便写', now)).toBeNull()
  })
})
