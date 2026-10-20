/**
 * 行为分析 · 契约类型与常量 —— 2026-10-19 新增
 *
 * 字段名与 docs/接口约定.md 第二节「行为分析」逐项对应，**禁止自创同义别名**。
 *
 * 本目录只放**纯函数**（输入：事件数组 + 时间；输出：聚合结果）：不读文件、不查库、不打引擎。
 * 好处是能脱离 Express / Prisma 单独自证，将来埋点从 JSONL 换成 SQLite 也只改调用方。
 *
 * 口径复用：`AsksSummary` / `SearchTermCount` / `DownloadTopItem` 直接用 track 模块的类型，
 * 「无答案率」也直接调用 track/stats.ts 里同一个聚合函数 —— 看板和分析不该有两套算法。
 */
import type {
  AsksSummary,
  DownloadTopItem,
  SearchTermCount,
  TrackEvent
} from '../track/types.js'

/** Top 榜长度（检索词 / 零结果词 / 下载排行） */
export const ANALYTICS_TOP_LIMIT = 10

/** 账号榜最多列多少个账号 */
export const ANALYTICS_USERS_LIMIT = 20

/** 区间聚合：默认看最近 30 天，允许 1..365 天 */
export const ANALYTICS_DEFAULT_DAYS = 30
export const ANALYTICS_MAX_DAYS = 365

/** 单账号明细：默认最近 90 天、每页 20 条、每页上限 100 条 */
export const ACTIVITY_DEFAULT_DAYS = 90
export const ACTIVITY_DEFAULT_PAGE_SIZE = 20
export const ACTIVITY_MAX_PAGE_SIZE = 100

/**
 * 匿名访客在明细接口里的「账号 id」。
 * ⚠️ 存储层仍然是 `userId: null`（null 才是「匿名」的唯一真相），这个词只在展示层出现。
 */
export const ANALYTICS_GUEST_ID = '__guest__'

/** 事件名 -> 中文（看板、明细、CSV 导出同一套叫法） */
export const EVENT_LABELS: Record<TrackEvent, string> = {
  page_view: '页面访问',
  search: '搜索',
  preview: '在线预览',
  download: '下载',
  ai_ask: 'AI 提问',
  register: '注册',
  feedback_submit: '反馈提交'
}

/** 星期几中文标签，下标即 JS `getDay()`：0 = 周日 */
export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/**
 * 单账号明细可筛选的事件：`all` + 五类主要行为。
 * 注册 / 反馈只在 `all` 里出现（它们不是「使用资料」的动作，单列筛选意义不大）。
 */
export const ACTIVITY_EVENT_FILTERS = [
  'all',
  'page_view',
  'search',
  'preview',
  'download',
  'ai_ask'
] as const

export type ActivityEventFilter = (typeof ACTIVITY_EVENT_FILTERS)[number]

/** 是不是合法的明细事件筛选值 */
export function isActivityEventFilter(value: string): value is ActivityEventFilter {
  return (ACTIVITY_EVENT_FILTERS as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ 聚合形状 */

/** 六项行为计数（总量 / 某一天 / 某个账号 / 游客组共用同一形状） */
export interface CounterSet {
  events: number
  pv: number
  searches: number
  previews: number
  downloads: number
  asks: number
}

/** 区间总量：在六项行为之外多 uv 与注册/反馈数 */
export interface AnalyticsTotals extends CounterSet {
  /** 区间内按 `userId ?? sessionId` 去重的访客数（两个都空的不算） */
  uv: number
  registers: number
  feedbacks: number
}

/** 匿名访客汇总（`userId` 为 null 的事件） */
export type GuestSummary = CounterSet

/** 按日趋势里的一天（区间内每天都给，没有事件也给 0） */
export interface AnalyticsDayPoint extends CounterSet {
  /** YYYY-MM-DD（本地时区） */
  date: string
  /** 当天的去重访客数 */
  uv: number
}

/** 按小时分布的一项（固定 24 项，0..23） */
export interface HourlyPoint {
  hour: number
  events: number
}

/** 按星期分布的一项（固定 7 项，0 = 周日） */
export interface WeekdayPoint {
  weekday: number
  label: string
  /** 区间内该星期几的事件数 */
  events: number
}

/** 转化漏斗（就是 totals 里那五项，给前端直接画图） */
export interface AnalysisFunnel {
  pv: number
  searches: number
  previews: number
  downloads: number
  asks: number
}

/** 检索分析 */
export interface SearchAnalysis {
  /** 检索事件数 */
  total: number
  /** 其中零结果的条数 */
  zero: number
  /** 零结果率 = zero / total（total=0 给 0，保留 4 位小数） */
  zeroRate: number
  /** 检索词 Top（最多 10 条） */
  top: SearchTermCount[]
  /** 零结果检索词 Top（最多 10 条） */
  zeroTerms: SearchTermCount[]
}

/** 下载分析 */
export interface DownloadAnalysis {
  /** 服务端下载接口记的权威条数（source = server） */
  server: number
  /** 下载埋点总条数（含前端上报口径） */
  events: number
  /** 下载排行（最多 10 条，只认服务端口径） */
  top: DownloadTopItem[]
}

/** 账号榜的一行 */
export interface UserAnalyticsRow extends CounterSet {
  userId: string
  name: string
  org: string
  /** 区间内最后一次事件的 ISO 时刻 */
  lastSeen: string
}

/** 聚合区间 */
export interface AnalyticsRange {
  days: number
  /** YYYY-MM-DD（本地时区） */
  from: string
  /** YYYY-MM-DD（本地时区） */
  to: string
}

/** GET /api/admin/analytics 响应 */
export interface AnalyticsResponse {
  success: true
  /** 生成时刻 ISO 8601 */
  generatedAt: string
  range: AnalyticsRange
  totals: AnalyticsTotals
  /** 补齐区间内每一天，按日期升序（长度恒等于 days） */
  daily: AnalyticsDayPoint[]
  /** 固定 24 项 */
  hourly: HourlyPoint[]
  /** 固定 7 项 */
  weekday: WeekdayPoint[]
  funnel: AnalysisFunnel
  search: SearchAnalysis
  downloads: DownloadAnalysis
  /** 与 GET /api/track/stats 的 asks 同一口径 */
  asks: AsksSummary
  /** 按事件数降序，最多 20 条；匿名访客不在这个数组里 */
  users: UserAnalyticsRow[]
  /** 匿名访客单独汇总（totals 里已含它们，这里只是拆开看） */
  guest: GuestSummary
}

/** 账号档案（从 SQLite 的 User 表补上 name/org；查不到就留空，不报错） */
export type UserProfileDirectory = Map<string, UserProfile>

/** 账号档案的一项 */
export interface UserProfile {
  name: string
  org: string
}

/** 单账号明细里的一条事件 */
export interface ActivityItem {
  /** 发生时刻 ISO 8601 */
  ts: string
  event: TrackEvent
  /** 中文可读事件名（如「在线预览」）；事件名取自同一条事件 */
  label: string
  /** 给人看的一句话：ai_ask=提问原文，search=检索词，preview/download=文件名，page_view=页面路径 */
  detail: string
  /** 关联资料编号；缺失给空字符串 */
  docId: string
  /** 关联资料文件名；缺失给空字符串 */
  fileName: string
  /** 只有 ai_ask 有意义：未判定给 null（与埋点字段同一形状） */
  noAnswer: boolean | null
  /** 来源页面 / 接口路径；缺失给空字符串 */
  path: string
}

/** GET /api/admin/user-activity 响应 */
export interface UserActivityResponse {
  success: true
  /** 回显查询的账号（`__guest__` 表示匿名事件） */
  userId: string
  /** 账号姓名；查不到留空字符串，匿名固定「游客」 */
  name: string
  /** 账号机构；查不到留空字符串 */
  org: string
  /** 筛选后的总条数（不是本页条数） */
  total: number
  page: number
  pageSize: number
  items: ActivityItem[]
}
