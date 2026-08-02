// 待发招呼语队列（跨页持久化）
//
// 为什么需要：BOSS 在 /web/geek/jobs 点「立即沟通」只建立会话、不弹聊天框
// （2026-07-30 实测），招呼语必须到 /web/geek/chat 才能发。两个页面之间会
// 整页跳转，内存状态丢失，故用 GM 存储中转。
const KEY = 'aah_pending_greetings'
const TTL_MS = 24 * 60 * 60 * 1000 // 超过一天未补发即视为过期，避免陈旧消息发出去

export interface PendingGreeting {
  platformJobId: string
  title: string
  company: string
  greeting: string
  createdAt: number
}

function load(): PendingGreeting[] {
  try {
    const raw = GM_getValue(KEY, '')
    if (!raw) return []
    const list = JSON.parse(raw as string) as PendingGreeting[]
    const now = Date.now()
    return list.filter((x) => x && now - (x.createdAt || 0) < TTL_MS)
  } catch {
    return []
  }
}

function save(list: PendingGreeting[]): void {
  try {
    GM_setValue(KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

/** 入队（同一岗位只保留一条，避免重复发送） */
export function pushPendingGreeting(item: Omit<PendingGreeting, 'createdAt'>): void {
  const list = load().filter((x) => x.platformJobId !== item.platformJobId)
  list.push({ ...item, createdAt: Date.now() })
  save(list)
}

export function listPendingGreetings(): PendingGreeting[] {
  return load()
}

export function pendingGreetingCount(): number {
  return load().length
}

/** 出队（发送成功后调用） */
export function removePendingGreeting(platformJobId: string): void {
  save(load().filter((x) => x.platformJobId !== platformJobId))
}

export function clearPendingGreetings(): void {
  try {
    GM_deleteValue(KEY)
  } catch {
    /* ignore */
  }
}

/** 按公司/岗位名模糊匹配待发项（聊天页只能读到公司名和岗位名） */
export function findPendingByCompanyJob(company: string, jobTitle: string): PendingGreeting | null {
  const list = load()
  const c = (company || '').trim()
  const j = (jobTitle || '').trim()
  if (!c && !j) return null
  // 公司名在聊天列表常被截断，用前 6 字双向前缀匹配
  const head = (s: string) => s.slice(0, 6)
  return (
    list.find((x) => {
      const companyHit =
        !!c && !!x.company && (x.company.startsWith(head(c)) || c.startsWith(head(x.company)))
      const jobHit = !!j && !!x.title && (x.title.startsWith(head(j)) || j.startsWith(head(x.title)))
      return companyHit || jobHit
    }) || null
  )
}
