// 会话数据源探测（方案 C 可行性验证）——零滚动读取 BOSS 聊天页内部列表数据。
//
// BOSS 聊天页是虚拟列表：DOM 恒定只渲染 ~40 行，要看全部会话必须滚动。
// 但如果页面内存（Vuex store / 组件树）里保存着完整会话列表，就能一次读全，
// 跳过滚动。本模块负责「探测」：把根实例、store、组件树里所有疑似会话列表
// 数组的位置与字段结构 dump 到插件日志（tag=STORE），确认后即可实现零滚动扫描。
// 探测是只读的，不点击、不写入任何 BOSS 数据。

import { diag, flushLogs } from './logger'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const CHAT_KEY_RE = /chat|session|friend|conversation|msg|boss|list|geek/i

/** 会话/BOSS 数据判定：securityId（行级）或 encryptBossId/friendId/uid（列表项）任一命中。 */
function looksLikeBoss(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Any
  return (
    typeof o.securityId === 'string' ||
    typeof o.encryptBossId === 'string' ||
    typeof o.friendId === 'string' ||
    typeof o.uid === 'string' ||
    typeof o.uniqueId === 'string'
  )
}

function truncate(v: unknown, n = 40): string {
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'string') return v.length > n ? v.slice(0, n) + '…' : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return Object.prototype.toString.call(v)
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `Array(${v.length})`
  if (typeof v === 'object') {
    const keys = Object.keys(v as object)
    return `Object{${keys.length}}`
  }
  return typeof v
}

function safeKeys(v: unknown): string[] {
  try {
    return Object.keys(v as object).filter((k) => !k.startsWith('_') && !k.startsWith('$'))
  } catch {
    return []
  }
}

function sampleFields(obj: unknown): string {
  const keys = safeKeys(obj).slice(0, 24)
  const parts = keys.map((k) => {
    try {
      return `${k}=${truncate((obj as Any)[k])}`
    } catch {
      return `${k}=<getter-throw>`
    }
  })
  return parts.join(' ')
}

/** 找根 Vue 实例：常见挂载容器 + 聊天页行组件兜底。 */
function findRoots(): Array<{ label: string; value: Any }> {
  const out: Array<{ label: string; value: Any }> = []
  for (const sel of ['#app', '#root', '#main', '.app', '[class*="app-shell"]', 'body']) {
    const app = document.querySelector(sel) as Any
    if (!app) continue
    if (app.__vue__) {
      out.push({ label: `${sel}.__vue__ (Vue2)`, value: app.__vue__ })
      break
    }
    if (app.__vue_app__) {
      out.push({ label: `${sel}.__vue_app__ (Vue3)`, value: app.__vue_app__ })
      break
    }
  }
  // 兜底：任意元素上的 __vue__ 实例（聊天页行组件）
  const row = document.querySelector('.geek-item, .user-list li, [class*="chat-user-item"]')
  if (row && (row as Any).__vue__) out.push({ label: 'row.__vue__', value: (row as Any).__vue__ })
  return out
}

/** 从组件实例找 $store（Vue2 直挂；Vue3 在 provides / _context 里）。 */
function findStore(vm: Any): Any | null {
  if (vm?.$store) return vm.$store
  const provides = vm?.$?.provides || vm?._context?.provides || vm?.appContext?.provides
  if (!provides) return null
  const found = Object.values(provides).find(
    (v) => v && typeof v === 'object' && (v as Any).state && typeof (v as Any).state === 'object',
  )
  return found ?? null
}

function dumpStoreState(store: Any): void {
  diag('STORE', `store 顶层 state keys: ${safeKeys(store.state).join(', ') || '(空)'}`)
  for (const k of safeKeys(store.state)) {
    if (!CHAT_KEY_RE.test(k)) continue
    const v = store.state[k]
    diag('STORE', `state.${k} → ${describe(v)}`)
    if (Array.isArray(v)) {
      const first = v[0]
      diag('STORE', `  [0] ${describe(first)} keys: ${safeKeys(first).join(', ') || '(无)'}`)
      if (looksLikeBoss(first)) diag('STORE', `  [0] boss 样例: ${sampleFields(first)}`)
      else if (first && typeof first === 'object') diag('STORE', `  [0] 样例: ${sampleFields(first)}`)
    } else if (v && typeof v === 'object') {
      const subKeys = safeKeys(v).slice(0, 12)
      for (const sk of subKeys) {
        const sv = v[sk]
        diag('STORE', `  .${sk} → ${describe(sv)}`)
        if (Array.isArray(sv) && looksLikeBoss(sv[0])) diag('STORE', `    [0] boss 样例: ${sampleFields(sv[0])}`)
      }
    }
  }
  // 模块名 + chat 相关 actions/getters
  const modules = safeKeys(store._modules?.root?._children || {})
  diag('STORE', `store 模块: ${modules.join(', ') || '(无)'}`)
  const actions = safeKeys(store._actions || {}).filter((k) => CHAT_KEY_RE.test(k))
  diag('STORE', `store chat 相关 actions: ${actions.join(', ') || '(无)'}`)
}

/** 从行实例向上走 $parent 链，找「整份会话列表」所在容器（列表数组在祖先组件里）。 */
function walkAncestors(vm: Any): void {
  let cur: Any = vm
  for (let depth = 0; depth < 10 && cur; depth++) {
    const name =
      cur.$options?.name ||
      cur.$options?._componentTag ||
      cur.$?.type?.name ||
      cur.$?.type?.__name ||
      '?'
    const dataKeys = safeKeys(cur.$data || {})
    diag('STORE', `祖先[${depth}] ${name}：data keys=${dataKeys.join(', ') || '(空)'}`)
    for (const k of dataKeys) {
      const v = (cur.$data || {})[k]
      if (Array.isArray(v) && v.length >= 1) {
        const first = v[0]
        const isFriendList = first && typeof first === 'object' && looksLikeBoss(first)
        diag(
          'STORE',
          `  数组 ${k}(${v.length}) ${isFriendList ? '→ 疑似会话列表！' : ''} [0] keys=${safeKeys(first).join(', ')}`,
        )
        if (isFriendList) {
          diag('STORE', `  [0] 样例: ${sampleFields(first)}`)
          return
        }
      }
    }
    cur = cur.$parent || cur.$.parent
  }
}

/** 广度遍历组件树，找「boss 对象数组」（即整份会话列表）。 */
function walkComponentTree(root: Any): void {
  const queue: Array<{ vm: Any; depth: number; path: string }> = [
    {
      vm: root,
      depth: 0,
      path:
        root.$options?.name ||
        root.$options?._componentTag ||
        root.$?.type?.name ||
        root.$?.type?.__name ||
        'root',
    },
  ]
  const seen = new Set<Any>()
  let nodes = 0
  while (queue.length && nodes < 400) {
    const { vm, depth, path } = queue.shift()!
    nodes++
    if (seen.has(vm)) continue
    seen.add(vm)

    for (const key of ['data', '$data', 'list', 'sessionList', 'friendList', 'chatList', 'conversationList', '$props']) {
      let v: Any
      try {
        v = key === '$data' ? vm.$data : key === '$props' ? vm.$props : vm[key]
      } catch {
        continue
      }
      if (!v) continue
      if (Array.isArray(v) && v.length >= 2 && looksLikeBoss(v[0])) {
        diag('STORE', `组件树 ${path} 的 ${key} → 会话数组(${v.length})`)
        diag('STORE', `  [0] boss 样例: ${sampleFields(v[0])}`)
        return // 找到即可，避免刷屏
      }
      if (key === '$data' && typeof v === 'object') {
        for (const k of safeKeys(v)) {
          const sv = v[k]
          if (Array.isArray(sv) && sv.length >= 2 && looksLikeBoss(sv[0])) {
            diag('STORE', `组件树 ${path} 的 data.${k} → 会话数组(${sv.length})`)
            diag('STORE', `  [0] boss 样例: ${sampleFields(sv[0])}`)
            return
          }
        }
      }
    }

    if (depth < 6) {
      const kids: Any[] = []
      if (Array.isArray(vm.$children)) kids.push(...vm.$children)
      const sub = vm.$?.subTree
      if (sub) {
        if (sub.component) kids.push(sub.component)
        const collect = (vn: Any) => {
          if (vn?.component) kids.push(vn.component)
          if (Array.isArray(vn?.children)) vn.children.forEach(collect)
          if (Array.isArray(vn?.dynamicChildren)) vn.dynamicChildren.forEach(collect)
        }
        collect(sub)
      }
      for (const c of kids) {
        if (!c || typeof c !== 'object') continue
        queue.push({
          vm: c,
          depth: depth + 1,
          path: `${path} > ${
            c.$options?.name ||
            c.$options?._componentTag ||
            c.$?.type?.name ||
            c.$?.type?.__name ||
            '?'
          }`,
        })
      }
    }
  }
  diag('STORE', `组件树遍历 ${nodes} 个节点，未找到 boss 会话数组（需在聊天页且列表已加载）`)
}

/** 行组件 Vue 实例上的 boss 对象字段全览（含 lastMsg/未读/时间等候选字段）。 */
function dumpRowBossObject(): void {
  const row = document.querySelector<HTMLElement>('.geek-item, .user-list li, [class*="chat-user-item"]')
  if (!row) {
    diag('STORE', '未找到会话列表行元素（请确认在 BOSS 聊天页且列表已加载）')
    return
  }
  const vm = (row as Any).__vue__
  if (!vm) {
    diag('STORE', '会话行没有 __vue__，无法读取内部数据')
    return
  }
  const hosts = [
    row.querySelector('.gray.last-msg'),
    row.querySelector('.last-msg'),
    row.querySelector('.friend-content'),
    row,
  ].filter(Boolean) as HTMLElement[]
  for (const host of hosts) {
    const hvm = (host as Any).__vue__
    if (!hvm) continue
    for (const k of ['boss', 'friend', 'item', 'data', 'conversation', 'chat', 'row']) {
      const v = hvm[k] || hvm.$props?.[k]
      if (looksLikeBoss(v)) {
        diag('STORE', `行 boss 对象位置: ${k}（行内可见文本: ${(row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}）`)
        diag('STORE', `boss 字段: ${sampleFields(v)}`)
        diag('STORE', `行组件其他 data keys: ${safeKeys(hvm.$data || hvm).filter((x) => !['_init'].includes(x)).join(', ')}`)
        return
      }
    }
    const all = { ...(hvm.$data || {}), ...(hvm.$props || {}) }
    const boss = Object.values(all).find((x) => looksLikeBoss(x))
    if (boss) {
      diag('STORE', `行 boss 对象（遍历 data/$props 找到）: ${sampleFields(boss)}`)
      return
    }
  }
  diag('STORE', '行组件上未找到 boss 对象（安全起见不做深层遍历，避免误读）')
}

/** 一键探测：根实例 → store → 组件树 → 行对象，全部写入日志并立即上传。 */
export function probeChatStore(): string {
  diag('STORE', '==== 会话数据源探测开始（只读） ====')
  try {
    const roots = findRoots()
    diag('STORE', `根实例: ${roots.length ? roots.map((r) => r.label).join(' / ') : '未找到 __vue__'}`)
    for (const r of roots) {
      try {
        const store = findStore(r.value)
        diag('STORE', `${r.label}：$store=${store ? '有' : '无'}`)
        if (store) dumpStoreState(store)
      } catch (e) {
        diag('STORE', `store 探测异常: ${(e as Error).message}`)
      }
      try {
        walkAncestors(r.value)
      } catch (e) {
        diag('STORE', `祖先链探测异常: ${(e as Error).message}`)
      }
      try {
        walkComponentTree(r.value)
      } catch (e) {
        diag('STORE', `组件树探测异常: ${(e as Error).message}`)
      }
    }
  } catch (e) {
    diag('STORE', `根实例探测异常: ${(e as Error).message}`)
  }
  try {
    dumpRowBossObject()
  } catch (e) {
    diag('STORE', `行对象探测异常: ${(e as Error).message}`)
  }
  diag('STORE', '==== 探测结束，日志已上传（tag=STORE） ====')
  void flushLogs()
  return '探测完成，结果已写入日志（tag=STORE）并上传'
}
