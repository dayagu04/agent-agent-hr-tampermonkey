// 插件共享类型定义

/** 平台代号 */
export type PlatformCode = 'zhipin' | 'zhaopin' | 'liepin' | 'qiancheng'

/** 从页面扫描到的单个岗位卡片 */
export interface JobCard {
  platformJobId: string // 平台职位唯一 ID（去重用）
  title: string // 职位标题
  company: string // 公司名
  city?: string // 城市
  salary?: string // 薪资文本（如 "15-25K"）
  description?: string // JD 摘要（用于匹配）
  url?: string // 职位详情 URL
  /** 投递按钮的 DOM 引用（点击投递用，不上传后端） */
  applyElement?: HTMLElement
  /** 卡片根元素（用于高亮/标记已处理） */
  cardElement?: HTMLElement
}

/** 后端匹配结果 */
export interface MatchResultItem {
  platform_job_id: string
  score: number
  recommend: boolean
  reason: string
}

/** 投递过滤规则（来自后端 /api/plugin/rules，与 Web Agent 同源） */
export interface ApplyRule {
  id: number
  rule_type: string // block_company | block_keyword | min_salary
  value: string
}

/** 平台配额状态（来自后端 /api/plugin/quota，与 Web Agent 共用限流器） */
export interface QuotaInfo {
  platform: string
  can_apply: boolean
  reason: string
  applied_last_hour: number
  applied_last_day: number
  max_per_hour: number
  max_per_day: number
  min_interval_seconds: number
}

/** 投递真实结果：applied=平台已确认 / unknown=无法确认 / failed=明确失败 */
export type ApplyOutcome = 'applied' | 'unknown' | 'failed'

/** 插件配置（存 GM_setValue） */
export interface PluginConfig {
  apiBase: string // 后端地址，如 https://gudaya.chat
  token: string // JWT Token
  resumeId: number | null // 选用的简历 ID
  threshold: number // 匹配阈值（>= 则投递）
  maxApply: number // 单次最多投递数
  delayMin: number // 投递间隔最小毫秒（拟人）
  delayMax: number // 投递间隔最大毫秒
  /** 自动翻页：当前页投完后自动进入下一页继续（直到达上限或无下一页） */
  autoPaginate: boolean
  /** 自动翻页最多翻几页（防跑飞） */
  maxPages: number
  /** 跨页续跑：翻页后页面重载，自动恢复任务继续投 */
  autoResume: boolean
  /** 期望工作城市（从网站求职偏好同步）。用于判断 HR 发来的工作地点卡片是否接受 */
  prefCity: string
  /**
   * 城市不符时是否拒绝工作地点卡片。
   *
   * 默认 false（接受并标记）：机会不该因为地点自动放弃，用户可能愿意考虑。
   * 需要严格按城市筛选的用户，在设置页显式开启后才生效。
   */
  rejectOffCityLocation: boolean
  /**
   * 投递间隔地板（秒），低于此值会被提升到该值。默认 180（3 分钟）。
   * 低于 60 秒时设置页显示风控警告，且必须勾选 acknowledgeRiskyInterval 才生效，
   * 否则回落到 180。
   */
  minIntervalSeconds: number
  /**
   * 确认「我知道低间隔有封号风险」。仅当 minIntervalSeconds < 60 时检查。
   * 未勾选时插件回落到 180 秒地板，拒绝放行 0 秒连投。
   */
  acknowledgeRiskyInterval: boolean
  /**
   * 会话回复匹配分阈值。低于此值的会话不调 LLM，直接跳过。默认 50。
   * 用于过滤 HR 主动骚扰（垃圾岗位、审核员等）。
   */
  minReplyScore: number
}

/** 面板 Tab 键 */
export type TabKey = 'apply' | 'chat' | 'settings' | 'logs'

/**
 * 会话 Tab 展示用的 HR 消息摘要。
 *
 * 数据来源：GET /api/conversations/list 的 last_hr_message 字段（一次请求拿全）。
 *
 * 原计划是「再对前 N 条各拉一次 GET /api/conversations/{id} 取正文」，实施时
 * 放弃了：那个端点会对「已分类且未回复」的 HR 消息调 LLM 生成回复草稿
 * （server/routers/conversations.py 的 get_conversation），面板每 30s 轮询 5 条
 * 就是每小时约 600 次 LLM 调用，且响应要等生成完。改为在 /list 里带上正文摘要
 * ——那里 messages 已被 joinedload 取出，取摘要零额外查询、零 LLM。
 */
export interface HRMessageSummary {
  /** 我方后端的 conversation.id（非 BOSS 会话 ID，不能用于 URL 跳转） */
  id: number
  company: string
  jobTitle: string
  /** 最后一条 HR 消息正文（已截断） */
  content: string
  /** 毫秒时间戳（后端返回 ISO 字符串，前端转换后存这里） */
  timestamp: number
  /** 是否有未读。后端无已读字段，用「HR 消息且未分类（intent 为空）」近似 */
  unread: boolean
  /**
   * 该会话对应投递记录的匹配分（0-100）。
   *
   * null = 没有投递记录（HR 主动打招呼/老数据），与 0 分语义不同：
   * 前者是「无从判断」，后者是「判过且很差」。两者后端都会跳过回复，
   * 但提示文案要能区分，否则用户无法判断该调阈值还是该查投递记录。
   */
  matchScore: number | null
  /** 后端 last_message_at 原文（本地镜像增量刷新比较用） */
  lastMessageAt?: string
}

/** 后端会话清单项（GET /api/plugin/chat/manifest）—— 删除对账的权威输入 */
export interface ManifestItem {
  conversation_id: number
  company: string
  job_title: string
  platform: string
  status: string
  last_message_at: string
  /** 服务端按与插件一致的归一化算法算出的会话指纹 */
  thread_key: string
}

/** 左侧 Tab 导航项 */
export interface TabItem {
  key: TabKey
  label: string
}

/** 投递进度状态 */
export interface ApplyProgress {
  scanned: number // 已扫描岗位数
  matched: number // 匹配通过数
  applied: number // 已投递数
  skipped: number // 跳过数（低分/已投）
  failed: number // 投递失败数
  running: boolean
  logs: string[] // 操作日志
  /** 当前正在投递的岗位（实时显示用） */
  currentJob?: { title: string; company: string; score: number } | null
}
