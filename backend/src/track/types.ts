/**
 * 埋点统计 · 契约类型 —— 负责人：韶茹
 *
 * 字段名与 docs/接口约定.md 第二节「行为埋点与统计」逐项对应，**禁止自创同义别名**。
 * 本文件是 track 模块对外数据形状的唯一真相来源。
 */

/** 事件白名单（七类）；不在表内的事件名一律拒绝，不产生脏数据 */
export const TRACK_EVENTS = [
  'page_view',
  'search',
  'preview',
  'download',
  'ai_ask',
  'register',
  'feedback_submit'
] as const

export type TrackEvent = (typeof TRACK_EVENTS)[number]

/** 单次请求最多收多少条（超了整批 400，防「一次 POST 灌十万条」） */
export const TRACK_MAX_EVENTS_PER_REQUEST = 100

/** payload 序列化后的字符数上限 */
export const TRACK_MAX_PAYLOAD_CHARS = 4000

/** 各字段上限；超出按截断处理（非拒绝——匿名访客不该因为串太长而丢数据） */
export const TRACK_MAX_SESSION_ID_CHARS = 64
export const TRACK_MAX_USER_ID_CHARS = 64
export const TRACK_MAX_PATH_CHARS = 512
/** 检索词上限（派生列 term）；超出截断 */
export const TRACK_MAX_TERM_CHARS = 100

/** 校验/拒绝原因码（前端与验收脚本按 code 分支，不解析 message 文案） */
export type TrackIssueCode =
  | 'INVALID_BODY'
  | 'EMPTY_BATCH'
  | 'TOO_MANY_EVENTS'
  | 'INVALID_ITEM'
  | 'UNKNOWN_EVENT'
  | 'PAYLOAD_TOO_LARGE'
  | 'ALL_REJECTED'

/** 单条被拒（或整批被拒）的原因；index 是它在批次里的下标 */
export interface TrackIssue {
  index: number
  code: TrackIssueCode
  message: string
}

/** 事件来源：client = 前端上报；server = 后端接口自动记（预览/下载的权威口径） */
export type TrackSource = 'client' | 'server'

/** 落库的一行事件（已归一化：长度截断、派生列算好） */
export interface StoredEvent {
  /** 发生时刻，ISO 8601 */
  ts: string
  event: TrackEvent
  /** null = 匿名访客 */
  userId: string | null
  sessionId: string
  /** 页面来源（路由 fullPath）；服务端记的事故填接口路径 */
  path: string
  payload: Record<string, unknown>
  source: TrackSource
  /** 派生列：search 的检索词（小写化） */
  term: string
  /** 派生列：search 是否零结果 */
  zeroResult: boolean
  /** 派生列：ai_ask 是否无答案；null = 未判定 */
  noAnswer: boolean | null
}

/** POST /api/track 成功响应（accepted == 实际落库行数） */
export interface TrackAcceptedResponse {
  success: true
  accepted: number
  rejected: TrackIssue[]
}

/** POST /api/track 失败响应 */
export interface TrackErrorResponse {
  success: false
  error: {
    code: 'VALIDATION_FAILED' | 'INTERNAL_ERROR'
    message: string
    issues: TrackIssue[]
  }
}

/* ------------------------------------------------------------------ 统计 */

/** 检索词计数（Top / 零结果词共用） */
export interface SearchTermCount {
  term: string
  count: number
}

/** 下载排行条目（fileName 即 B06 下发给浏览器的重命名文件名） */
export interface DownloadTopItem {
  docId: string
  fileName: string
  count: number
}

/** 提问统计（无答案率口径见接口约定） */
export interface AsksSummary {
  /** ai_ask 事件总数 */
  total: number
  /** 有回答证据、可判定的条数（noAnswer IS NOT NULL） */
  judged: number
  /** 判定为无答案的条数 */
  noAnswer: number
  /** 未判定条数 */
  unjudged: number
  /** 无答案率 = noAnswer / judged（judged=0 时为 0） */
  noAnswerRate: number
}

/** 按日趋势里的一天 */
export interface DailyPoint {
  /** YYYY-MM-DD（本地时区） */
  date: string
  events: number
  pv: number
  download: number
  ai_ask: number
  preview: number
  search: number
}

/** GET /api/track/stats 响应 */
export interface StatsSummaryResponse {
  success: true
  /** 生成时刻 ISO 8601 */
  generatedAt: string
  totals: {
    /** 事件总行数 */
    events: number
    /** PV = page_view 条数 */
    pv: number
    /** UV = 按 userId ?? sessionId 去重的访客数 */
    uv: number
  }
  /** 各事件计数（未发生的给 0，前端不用判空） */
  events: Record<TrackEvent, number>
  topSearchTerms: SearchTermCount[]
  zeroResultSearchTerms: SearchTermCount[]
  /** 下载 Top（权威口径 = 服务端 download 接口记的 source:'server'） */
  topDownloads: DownloadTopItem[]
  downloads: {
    /** 服务端下载接口计数（权威） */
    server: number
    /** 前端埋点口径；与 server 不等 = 有绕过前端的直连调用 */
    events: number
  }
  asks: AsksSummary
  /** 最近 N 天趋势（看板画条形图用） */
  daily: DailyPoint[]
}
