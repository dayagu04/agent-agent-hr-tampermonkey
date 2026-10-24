// 平台工厂 —— 根据当前页面 URL 返回对应平台适配器
//
// 平台适配状态：
// - zhipin (BOSS直聘)：主平台，投递/会话托管/智能编排全链路支持
// - zhaopin (智联招聘)：选择器已校准，支持列表页投递
// - qiancheng (51前程无忧) / liepin (猎聘)：适配器存在但未在真实页面验证，
//   @match 未启用，仅作扩展预留
import { BasePlatform } from './base'
import { BossPlatform } from './boss'
import { ZhaopinPlatform } from './zhaopin'
import { LiepinPlatform } from './liepin'
import { QianchengPlatform } from './qiancheng'

export function detectPlatform(url: string = location.href): BasePlatform | null {
  if (url.includes('zhipin.com')) return new BossPlatform()
  if (url.includes('zhaopin.com')) return new ZhaopinPlatform()
  if (url.includes('51job.com')) return new QianchengPlatform()
  if (url.includes('liepin.com')) return new LiepinPlatform()
  return null
}

export { BasePlatform }
