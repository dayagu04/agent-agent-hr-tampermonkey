import { detectPlatform } from './platforms/factory'
import { detectNavUnread, type NavUnreadResult } from './nav-unread'
import type { ChatThread, DeletedThreadTarget, currentThreadInfo, readRowJobInfo } from './platforms/boss-chat'
import type { ToolResult } from './tool-definitions'

export interface PanelPosition { top: number; right: number }
export interface PanelLayout { collapsed: boolean; position: PanelPosition }
export interface UIToolSpec {
  name: string
  description: string
  irreversible: boolean
  exampleArgs: Record<string, unknown>
}
export type UIThread = Omit<ChatThread, 'el'>
export type UIThreadInfo = ReturnType<typeof currentThreadInfo>
export interface UIThreadRow { company: string; info: ReturnType<typeof readRowJobInfo> }

/** UI-only capabilities. Native page data is serialized; no DOM nodes or credentials cross this boundary. */
export interface UIHost {
  platform(): { name: string; chatUrl: string | null } | null
  pageUrl(): string
  navUnread(): NavUnreadResult
  viewport(): { width: number; height: number }
  layout?(layout: PanelLayout): void
  listThreads(): Promise<UIThread[]>
  threadRows(): Promise<UIThreadRow[]>
  currentThreadInfo(): Promise<UIThreadInfo>
  openThread(company: string, jobTitle: string): Promise<'ok' | 'not-found' | 'ambiguous' | 'failed' | 'thread_not_confirmed'>
  deleteThread(company: string, jobTitle: string, identity: Pick<DeletedThreadTarget, 'bossId' | 'encryptJobId'>): Promise<'ok' | 'not-found' | 'failed'>
  navigate(url: string): Promise<void>
  probeSearchFilters(reason: string): Promise<void>
  toolSpecs(): Promise<UIToolSpec[]>
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>
}

// Legacy defaults preserve the same UI without requiring Chrome APIs in the userscript build.
const legacyHost: UIHost = {
  platform: () => detectPlatform(),
  pageUrl: () => location.href,
  navUnread: () => detectNavUnread(),
  viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
  async listThreads() {
    const { listThreads } = await import('./platforms/boss-chat')
    return listThreads().map(({ el: _el, ...thread }) => thread)
  },
  async threadRows() {
    const { listThreads, readRowJobInfo } = await import('./platforms/boss-chat')
    return listThreads().map(thread => ({ company: thread.company, info: readRowJobInfo(thread.el) }))
  },
  async currentThreadInfo() { return (await import('./platforms/boss-chat')).currentThreadInfo() },
  async openThread(company, jobTitle) { return (await import('./platforms/boss-chat')).openThreadConfirmed(company, jobTitle) },
  async deleteThread(company, jobTitle, identity) { return (await import('./platforms/boss-chat')).deleteThread(company, jobTitle, identity) },
  async navigate(url) { location.assign(url) },
  async probeSearchFilters(reason) { (await import('./search-filters')).probeSearchFiltersOnce(reason) },
  async toolSpecs() { return (await import('./tools')).toolSpecs() },
  async callTool(name, args) { return (await import('./tools')).callTool(name, args) },
}

let installedHost: UIHost = legacyHost
export function installUIHost(host: UIHost): void { installedHost = host }
export function getUIHost(): UIHost { return installedHost }
