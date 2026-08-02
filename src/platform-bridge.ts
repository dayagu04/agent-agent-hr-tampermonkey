// 平台桥接层 —— 隔离 GM API
//
// 业务代码只调这一层、不直接用 GM_*；将来迁移到独立扩展时只换这个文件。

export interface StorageAPI {
  get<T>(key: string, defaultValue: T): Promise<T>
  set<T>(key: string, value: T): Promise<void>
  remove(key: string): Promise<void>
  clear(): Promise<void>
}

export interface NetworkAPI {
  /** 跨域 HTTP 请求（油猴用 GM_xmlhttpRequest，扩展用 fetch） */
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

class GMStorageAPI implements StorageAPI {
  async get<T>(key: string, defaultValue: T): Promise<T> {
    const raw = GM_getValue<string | undefined>(key, undefined)
    if (raw === undefined || raw === '') return defaultValue
    try {
      return JSON.parse(raw) as T
    } catch {
      // 存量脏数据/手工改过的值：退回默认值
      return defaultValue
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    GM_setValue(key, JSON.stringify(value))
  }

  async remove(key: string): Promise<void> {
    GM_deleteValue(key)
  }

  async clear(): Promise<void> {
    const keys = GM_listValues()
    keys.forEach((k) => GM_deleteValue(k))
  }
}

class GMNetworkAPI implements NetworkAPI {
  request(opts: {
    method: string
    url: string
    headers?: Record<string, string>
    data?: string
    timeout?: number
  }): Promise<{ status: number; responseText: string }> {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method,
        url: opts.url,
        headers: opts.headers,
        data: opts.data,
        timeout: opts.timeout ?? 180000,
        onload: (resp) => resolve({ status: resp.status, responseText: resp.responseText }),
        onerror: () => reject(new Error('网络请求失败')),
        ontimeout: () => reject(new Error(`请求超时（${(opts.timeout ?? 180000) / 1000}s）`)),
      })
    })
  }
}

class GMNotificationAPI implements NotificationAPI {
  notify(title: string, message: string): void {
    if (typeof GM_notification === 'function') {
      GM_notification({ title, text: message, timeout: 5000 })
    } else {
      // 降级：控制台输出
      console.log(`[通知] ${title}: ${message}`)
    }
  }
}

export const storage: StorageAPI = new GMStorageAPI()
export const network: NetworkAPI = new GMNetworkAPI()
export const notification: NotificationAPI = new GMNotificationAPI()
