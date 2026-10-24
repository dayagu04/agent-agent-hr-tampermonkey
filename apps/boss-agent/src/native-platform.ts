import type { NetworkAPI, StorageAPI } from '../../../packages/boss-core/src/platform-bridge'

export const DEFAULT_API_BASE = 'https://gudaya.chat'

export function normalizeApiBase(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid_api_origin')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('invalid_api_origin') }
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.hostname === '[::1]' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '') ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('invalid_api_origin')
  return url.origin
}

export function apiPermissionPattern(apiBase: string): string {
  const url = new URL(normalizeApiBase(apiBase))
  return `${url.protocol}//${url.hostname}/*`
}

/** Only constructed in trusted extension contexts. clear() cannot erase another scope's receipts. */
export class NativeStorage implements StorageAPI {
  readonly ready: Promise<void>
  constructor(private readonly area: chrome.storage.LocalStorageArea, private readonly prefix: string) {
    if (!prefix || !prefix.startsWith('boss-agent.')) throw new Error('invalid_storage_scope')
    this.ready = area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  }
  async get<T>(key: string, defaultValue: T): Promise<T> {
    await this.ready
    const name = this.prefix + key
    const values = await this.area.get(name)
    return values[name] === undefined ? defaultValue : values[name] as T
  }
  async set<T>(key: string, value: T): Promise<void> {
    await this.ready
    await this.area.set({ [this.prefix + key]: value })
  }
  async remove(key: string): Promise<void> {
    await this.ready
    await this.area.remove(this.prefix + key)
  }
  async clear(): Promise<void> {
    await this.ready
    const names = Object.keys(await this.area.get(null)).filter(key => key.startsWith(this.prefix))
    if (names.length) await this.area.remove(names)
  }
}

export interface NativeCredentials { apiBase: string; token: string }
type RequestOptions = Parameters<NetworkAPI['request']>[0] & { signal?: AbortSignal }
const API_ROUTES = new Set([
  'POST /api/auth/login', 'GET /api/auth/token', 'GET /api/plugin/config',
  'POST /api/plugin/heartbeat', 'POST /api/plugin/greeting', 'POST /api/plugin/record',
  'POST /api/plugin/chat/mark-deleted', 'POST /api/plugin/tools/result',
])

/** Native fetch adapter; never exposed as a generic content/MAIN-world message proxy. */
export class NativeNetwork implements NetworkAPI {
  constructor(
    private readonly permissions: Pick<typeof chrome.permissions, 'contains'>,
    private readonly fetcher: typeof fetch,
    private readonly credentials: () => NativeCredentials,
  ) {}
  async request(options: RequestOptions): Promise<{ status: number; responseText: string }> {
    const config = { ...this.credentials() }
    const origin = normalizeApiBase(config.apiBase)
    const url = new URL(options.url)
    if (url.origin !== origin || url.username || url.password || url.hash || url.search ||
        !API_ROUTES.has(`${options.method} ${url.pathname}`)) throw new Error('api_path_forbidden')
    // Core may supply its existing authHeaders, but it cannot override the runtime's identity.
    for (const [key, value] of Object.entries(options.headers || {})) {
      const header = key.toLowerCase()
      if ((header === 'authorization' && value === `Bearer ${config.token}`) ||
          (header === 'content-type' && value === 'application/json')) continue
      throw new Error('api_header_forbidden')
    }
    if (origin !== DEFAULT_API_BASE && !await this.permissions.contains({ origins: [apiPermissionPattern(origin)] })) {
      throw new Error('api_permission_required')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) controller.abort()
    const timeout = setTimeout(abort, Math.min(180_000, Math.max(1, options.timeout ?? 20_000)))
    try {
      const response = await this.fetcher(url.href, {
        method: options.method,
        headers: { 'Content-Type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
        ...(options.data === undefined ? {} : { body: options.data }),
        signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
      })
      return { status: response.status, responseText: await response.text() }
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
    }
  }
}
