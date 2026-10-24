// Pure contract shared by the trusted background and the MAIN dispatcher.
// No page imports, credentials, backend requests, or caller-provided executable code.
type Rule = (value: unknown) => boolean
const text = (max = 512, required = false): Rule => value => typeof value === 'string' && value.length <= max && (!required || !!value.trim())
const flag: Rule = value => typeof value === 'boolean'
const integer = (max: number): Rule => value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const nullable = (rule: Rule): Rule => value => value === null || rule(value)
function fields(properties: Record<string, Rule> = {}, required: string[] = []): Rule {
  return value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const object = value as Record<string, unknown>
    return required.every(key => Object.hasOwn(object, key)) &&
      Object.entries(object).every(([key, entry]) => Object.hasOwn(properties, key) && properties[key](entry))
  }
}
const thread = { company: text(512, true), jobTitle: text() }
const target = fields({
  key: text(512, true), name: text(), company: text(), jobTitle: text(), unread: flag,
  bossId: text(), jobId: text(), lastTS: nullable(integer(Number.MAX_SAFE_INTEGER)), sourceId: text(),
}, ['key', 'name', 'company', 'jobTitle', 'unread', 'bossId', 'jobId', 'lastTS'])
const card = fields({
  key: text(512, true), kind: value => typeof value === 'string' && ['resume_request', 'contact_exchange', 'location_confirm', 'unknown'].includes(value),
  question: text(20000), canAccept: flag, canReject: flag,
}, ['key', 'kind', 'question', 'canAccept', 'canReject'])
const schemas: Record<string, Rule> = {
  'platform.scan_jobs': fields({ withDetail: flag }),
  'platform.apply_job': fields({ jobId: text(512, true), greeting: text(20000) }, ['jobId', 'greeting']),
  'platform.next_page': fields(),
  'platform.mark_card': fields({ jobId: text(512, true), color: value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) }, ['jobId', 'color']),
  'page.context': fields(),
  'page.detect_risk': fields(),
  'ui.list_threads': fields(),
  'ui.thread_rows': fields(),
  'ui.current_thread_info': fields(),
  'ui.open_thread': fields(thread, ['company']),
  'ui.delete_thread': fields(thread, ['company']),
  'ui.probe_search_filters': fields({ reason: text(128) }),
  'chat.snapshot': fields(),
  'chat.sources': fields(),
  'chat.window': fields({ screen: integer(1000) }),
  'chat.open': fields({ target }, ['target']),
  'chat.current': fields(),
  'chat.messages': fields({ expectedThread: text(512, true) }, ['expectedThread']),
  'chat.cards': fields({ expectedThread: text(512, true) }, ['expectedThread']),
  'chat.card': fields({ card, accept: flag, expectedThread: text(512, true), resumeName: nullable(text()) }, ['card', 'accept', 'expectedThread', 'resumeName']),
  'chat.send': fields({ text: text(20000, true), expectedThread: text(512, true) }, ['text', 'expectedThread']),
  'chat.resume': fields({ resumeName: nullable(text()), expectedThread: text(512, true) }, ['resumeName', 'expectedThread']),
  'chat.delete': fields({ expectedThread: text(512, true), guardMs: integer(300000), target, dbLastMessageAt: nullable(integer(Number.MAX_SAFE_INTEGER)) }, ['expectedThread', 'guardMs']),
}
const sideEffects = new Set(['platform.apply_job', 'platform.next_page', 'ui.delete_thread', 'chat.card', 'chat.send', 'chat.resume', 'chat.delete'])
const operationName = (name: string): string => name.startsWith('core:') ? name.slice(5) : name

export function validateCoreOperation(name: string, args: unknown = {}): { ok: boolean; error?: string } {
  const operation = operationName(name)
  if (!Object.hasOwn(schemas, operation)) return { ok: false, error: 'unknown_core_operation' }
  try {
    if (JSON.stringify(args).length > 64000 || !schemas[operation](args)) return { ok: false, error: 'invalid_arguments' }
  } catch { return { ok: false, error: 'invalid_arguments' } }
  return { ok: true }
}

/** Unknown operations fail closed even if a caller forgets to validate first. */
export function isCoreSideEffect(name: string): boolean {
  const operation = operationName(name)
  return !Object.hasOwn(schemas, operation) || sideEffects.has(operation)
}
