import { BasePlatform, type ApplyResult } from '../../../packages/boss-core/src/platforms/base'
import { installPageDriver, type ExecutionApplyContext, type ExecutionPlatform } from '../../../packages/boss-core/src/execution-host'
import type { JobCard } from '../../../packages/boss-core/src/types'
import { diag } from '../../../packages/boss-core/src/logger'
import { storage } from '../../../packages/boss-core/src/platform-bridge'
import { nativePageCall, nativePageContext, nativePageNavigate, nativeSend } from './host-bridge'

/** 面板中的平台代理。只调用页面原子动作，匹配、招呼语和记账仍由原 ApplyEngine 负责。 */
export class NativeBossPlatform extends BasePlatform implements ExecutionPlatform {
  readonly name = 'BOSS直聘'
  readonly code = 'zhipin' as const
  readonly chatUrl = 'https://www.zhipin.com/web/geek/chat'

  async scanJobs(options: { withDetail?: boolean } = {}): Promise<JobCard[]> {
    return nativePageCall<JobCard[]>('platform.scan_jobs', { withDetail: !!options.withDetail })
  }

  async applyJob(card: JobCard, context?: ExecutionApplyContext): Promise<ApplyResult> {
    if (!card.platformJobId) throw new Error('job_id_required')
    if (!context?.idempotencyKey) throw new Error('execution_id_required')
    // 导航/刷新恢复后复用同一招呼语，使相同幂等键始终对应相同页面载荷。
    const preparationKey = `aah_native_apply:${context.idempotencyKey}`
    let prepared = await storage.get<{ jobId: string; greeting: string } | null>(preparationKey, null)
    if (prepared && (prepared.jobId !== card.platformJobId || typeof prepared.greeting !== 'string')) {
      throw new Error('apply_preparation_conflict')
    }
    if (!prepared) {
      // 后端生成失败在页面动作之前直接拒绝，不能点击后自行编造招呼语。
      prepared = { jobId: card.platformJobId, greeting: context.getGreeting ? await context.getGreeting() : '' }
      await storage.set(preparationKey, prepared)
    }
    try {
      const result = await nativePageCall<ApplyResult>('platform.apply_job', {
        jobId: card.platformJobId,
        greeting: prepared.greeting,
      }, context.idempotencyKey)
      if (!result || !['applied', 'unknown', 'failed'].includes(result.outcome)) {
        return { outcome: 'unknown', message: 'invalid_page_apply_result' }
      }
      return result
    } catch (error) {
      // 页面可能已点击/发出，传输中断不能当作明确失败，更不能自动再发一遍。
      diag('BOSS', '页面投递回执未确认', { errorType: (error as Error).name || 'Error' })
      return { outcome: 'unknown', message: 'page_apply_unconfirmed' }
    }
  }

  async nextPage(context?: { idempotencyKey: string }): Promise<boolean> {
    if (!context?.idempotencyKey) throw new Error('execution_id_required')
    return nativePageCall<boolean>('platform.next_page', {}, context.idempotencyKey)
  }

  markCard(card: JobCard, color: string): void {
    if (!card.platformJobId) return
    void nativePageCall('platform.mark_card', { jobId: card.platformJobId, color }).catch(error => {
      diag('BOSS', '岗位标记未更新', { errorType: (error as Error).name || 'Error' })
    })
  }
}

/** 在初始化原 App/执行器前安装；不会启动 remote 或第二套心跳。 */
export function installNativeExecutionHost(): void {
  installPageDriver({
    context: nativePageContext,
    navigate: nativePageNavigate,
    cancel: () => { void nativeSend('boss.panel.cancel').catch(() => undefined) },
    detectRiskControl: () => nativePageCall<boolean>('page.detect_risk'),
    platform(url) {
      const page = new URL(url)
      return page.protocol === 'https:' && page.hostname === 'www.zhipin.com'
        ? new NativeBossPlatform()
        : null
    },
  })
}
