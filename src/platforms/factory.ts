// 平台工厂 — 根据当前页面 URL 返回对应平台适配器
//
// 验证状态（2026-07-29）：
// ✅ zhaopin (智联招聘)   - 选择器已按真实页面校准
// ✅ zhipin  (BOSS直聘)   - 已启用；沟通+招呼语链路重写，待真实页面校准
// ⚠ qiancheng (51前程)   - 选择器未在真实页面验证
// ⏸ liepin  (猎聘)       - @match 未启用
import { BasePlatform } from './base'
import { BossPlatform } from './boss'
import { ZhaopinPlatform } from './zhaopin'
import { LiepinPlatform } from './liepin'
import { QianchengPlatform } from './qiancheng'

export function detectPlatform(url: string = location.href): BasePlatform | null {
  // ✅ 已验证平台
  if (url.includes('zhaopin.com')) return new ZhaopinPlatform()
  if (url.includes('51job.com')) return new QianchengPlatform()

  // ⏸ 待验证平台（vite.config.ts 中已注释 @match，理论上不会触发）
  if (url.includes('zhipin.com')) return new BossPlatform()
  if (url.includes('liepin.com')) return new LiepinPlatform()

  return null
}

export { BasePlatform }
