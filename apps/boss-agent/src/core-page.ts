// Narrow MAIN-world operations for the original panel and business engine.
import { BossPlatform } from '../../../packages/boss-core/src/platforms/boss'
import { chatPageOperations, currentThreadInfo, deleteThread, listThreads, onChatPage, openThreadConfirmed, readRowJobInfo } from '../../../packages/boss-core/src/platforms/boss-chat'
import { detectNavUnread } from '../../../packages/boss-core/src/nav-unread'
import { probeSearchFiltersOnce } from '../../../packages/boss-core/src/search-filters'
import { assertToolExecutionActive } from '../../../packages/boss-core/src/tool-execution-guard'
import type { JobCard } from '../../../packages/boss-core/src/types'
import { validateCoreOperation } from './core-operation-contract'

const MAX_ROWS = 300
const MAX_RESULT_CHARS = 2_000_000
let scannedJobs: JobCard[] = []
const string = (value: unknown, max = 512): string => typeof value === 'string' ? value.slice(0, max) : ''
function requireChat(): void { if (!onChatPage()) throw new Error('not_chat_page') }
function jobDTO(job: JobCard): Omit<JobCard, 'cardElement'> {
  return {
    platformJobId: string(job.platformJobId), title: string(job.title), company: string(job.company),
    city: string(job.city), salary: string(job.salary), description: string(job.description, 10000),
    jd: string(job.jd, 100000), url: string(job.url, 4096),
  }
}
async function uniqueCard(platform: BossPlatform, jobId: string): Promise<JobCard> {
  const jobs = await platform.scanJobs()
  assertToolExecutionActive()
  const exact = jobs.filter(job => job.platformJobId === jobId)
  const matches = exact.length ? exact : jobId.length >= 12
    ? jobs.filter(job => job.platformJobId.length >= 12 && (job.platformJobId.startsWith(jobId) || jobId.startsWith(job.platformJobId)))
    : []
  if (!matches.length) throw new Error('job_not_found')
  if (matches.length !== 1) throw new Error('job_ambiguous')
  return matches[0]
}
const operations: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> = {
  'platform.scan_jobs': async args => {
    scannedJobs = (await new BossPlatform().scanJobs({ withDetail: args.withDetail === true })).slice(0, MAX_ROWS)
    return scannedJobs.map(jobDTO)
  },
  'platform.apply_job': async args => {
    const platform = new BossPlatform()
    const card = await uniqueCard(platform, String(args.jobId))
    // The trusted engine already fetched this greeting and owns application accounting.
    return platform.applyJob(card, { getGreeting: async () => String(args.greeting) })
  },
  'platform.next_page': () => new BossPlatform().nextPage(),
  'platform.mark_card': args => {
    // Mark the exact element from the scan; marking hundreds of rows must not rescan/scroll each time.
    const matches = scannedJobs.filter(job => job.platformJobId === args.jobId && job.cardElement?.isConnected)
    if (matches.length === 1) new BossPlatform().markCard(matches[0], String(args.color))
    return null
  },
  'page.context': () => ({ url: location.href, visibility: document.visibilityState, navUnread: detectNavUnread().count }),
  'page.detect_risk': () => {
    const element = document.querySelector('.security-check, .captcha, .geetest_panel, [class*="security-check"]') as HTMLElement | null
    if (element) {
      const rect = element.getBoundingClientRect()
      if (rect.width > 4 && rect.height > 4) return true
    }
    return /security-check|captcha|verify/.test(location.pathname + location.search)
  },
  'ui.list_threads': () => {
    requireChat()
    return listThreads().slice(0, MAX_ROWS).map(thread => ({
      name: string(thread.name), company: string(thread.company), jobTitle: string(thread.jobTitle),
      unread: thread.unread, bossId: string(thread.bossId),
    }))
  },
  'ui.thread_rows': () => {
    requireChat()
    return listThreads().slice(0, MAX_ROWS).map(thread => ({ company: string(thread.company), info: readRowJobInfo(thread.el) }))
  },
  'ui.current_thread_info': () => { requireChat(); return currentThreadInfo() },
  'ui.open_thread': args => { requireChat(); return openThreadConfirmed(String(args.company), string(args.jobTitle)) },
  'ui.delete_thread': args => {
    requireChat()
    // Backend ledger and local mirror updates belong to the trusted panel, never MAIN.
    return deleteThread(String(args.company), string(args.jobTitle), undefined, async () => {})
  },
  'ui.probe_search_filters': args => { probeSearchFiltersOnce(string(args.reason, 128) || 'panel'); return null },
  ...chatPageOperations,
}

export async function dispatchCoreOperation(name: string, args: Record<string, unknown>): Promise<unknown> {
  const validation = validateCoreOperation(name, args)
  if (!validation.ok) throw new Error(validation.error)
  const operation = name.startsWith('core:') ? name.slice(5) : name
  const run = operations[operation]
  if (!run) throw new Error('unknown_core_operation')
  assertToolExecutionActive()
  const result = await run(args)
  assertToolExecutionActive()
  // Never transfer DOM references or unbounded page data through the privileged bridge.
  const serialized = JSON.stringify(result ?? null)
  if (serialized.length > MAX_RESULT_CHARS) throw new Error('core_result_too_large')
  return JSON.parse(serialized)
}
