// 页面能力由执行宿主提供；原页面宿主保留直接 DOM 行为，扩展面板使用窄 RPC。
import type { ApplyContext, ApplyResult, BasePlatform } from './platforms/base'
import type { JobCard } from './types'
import { detectNavUnread } from './nav-unread'

export interface ExecutionPageContext {
  url: string
  visibility: string
  navUnread: number
}

export interface ExecutionApplyContext extends ApplyContext {
  /** 同一编排运行、同一岗位的页面动作共用此键，刷新后也不得重复提交。 */
  idempotencyKey?: string
}

export interface ExecutionPlatform extends BasePlatform {
  applyJob(card: JobCard, context?: ExecutionApplyContext): Promise<boolean | ApplyResult>
  nextPage(context?: { idempotencyKey: string }): Promise<boolean>
}

export interface PageDriver {
  context(): ExecutionPageContext
  navigate(url: string): Promise<void>
  detectRiskControl(): Promise<boolean>
  cancel?(): void
  platform(url: string): ExecutionPlatform | null
}

let pageDriver: PageDriver | null = null

/** 仅由可信宿主在面板挂载前安装，网页不能通过消息替换此实现。 */
export function installPageDriver(driver: PageDriver): void {
  pageDriver = driver
}

/** undefined 表示旧页面宿主，由原平台工厂继续选择 DOM 适配器。 */
export function drivenPlatform(url: string): ExecutionPlatform | null | undefined {
  return pageDriver ? pageDriver.platform(url) : undefined
}

export function executionPageContext(): ExecutionPageContext {
  return pageDriver ? pageDriver.context() : {
    url: window.location.href,
    visibility: document.visibilityState,
    navUnread: detectNavUnread().count,
  }
}

export function executionPageUrl(): URL {
  return new URL(pageDriver ? pageDriver.context().url : window.location.href)
}

export async function navigateExecutionPage(url: string): Promise<void> {
  if (pageDriver) await pageDriver.navigate(url)
  else window.location.href = url
}

/** 与原执行器相同的可见验证码容器和验证页 URL 判定。 */
export async function detectExecutionRisk(): Promise<boolean> {
  if (pageDriver) return pageDriver.detectRiskControl()
  const element = document.querySelector(
    '.security-check, .captcha, .geetest_panel, [class*="security-check"]',
  ) as HTMLElement | null
  if (element) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 4 && rect.height > 4) return true
  }
  return /security-check|captcha|verify/.test(window.location.pathname + window.location.search)
}

/** 原页面宿主继续由引擎标记中断；原生宿主同时撤销当前页面动作。 */
export function cancelExecutionPage(): void { pageDriver?.cancel?.() }
