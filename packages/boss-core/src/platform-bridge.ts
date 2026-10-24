// 共享业务只依赖宿主能力；扩展与历史 userscript 分别安装自己的适配器。
export interface StorageAPI {
  get<T>(key: string, defaultValue: T): Promise<T>
  set<T>(key: string, value: T): Promise<void>
  remove(key: string): Promise<void>
  clear(): Promise<void>
}

export interface NetworkAPI {
  /** 由宿主运行时执行跨域 HTTP 请求 */
  request(opts: {
    method: string
    url: string
    headers?: Record<string, string>
    data?: string
    timeout?: number
  }): Promise<{ status: number; responseText: string }>
}

export interface NotificationAPI {
  /** 桌面通知 */
  notify(title: string, message: string): void
}

/** 已在启动前载入的配置快照，保留面板同步读写的调用方式。 */
export interface ConfigurationAPI {
  get(key: string, defaultValue: string): string
  set(key: string, value: string): void
}

export interface PlatformRuntime {
  storage: StorageAPI
  network: NetworkAPI
  notification: NotificationAPI
  configuration: ConfigurationAPI
}

let installedRuntime: PlatformRuntime | null = null

/** 必须在挂载面板、启动轮询或执行业务动作前安装。 */
export function installPlatformRuntime(runtime: PlatformRuntime): void {
  installedRuntime = runtime
}

function runtime(): PlatformRuntime {
  if (!installedRuntime) throw new Error('platform_runtime_not_installed')
  return installedRuntime
}

export const storage: StorageAPI = {
  get: (key, defaultValue) => runtime().storage.get(key, defaultValue),
  set: (key, value) => runtime().storage.set(key, value),
  remove: key => runtime().storage.remove(key),
  clear: () => runtime().storage.clear(),
}
export const network: NetworkAPI = {
  request: options => runtime().network.request(options),
}
export const notification: NotificationAPI = {
  notify: (title, message) => runtime().notification.notify(title, message),
}
export const configuration: ConfigurationAPI = {
  get: (key, defaultValue) => runtime().configuration.get(key, defaultValue),
  set: (key, value) => runtime().configuration.set(key, value),
}
