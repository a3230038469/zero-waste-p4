/**
 * 埋点通道（B03 附加）—— 负责人：韶茹
 *
 * POST /api/track 的唯一出口。契约见 docs/接口约定.md 第二节「行为埋点与统计」。
 *
 * 设计原则：
 *  - **fire-and-forget**：埋点失败绝不影响用户操作（发不出去就吞掉，只在控制台留一行 warn）；
 *  - **不上报 JWT**：/api/track 不做服务端鉴权（公众侧匿名行为），没必要把登录凭证发到统计接口上；
 *  - 会话标识（sessionId）由本文件统一生成并存在 sessionStorage，调用方不用操心。
 *
 * 注意：`preview` / `download` / `search` 已经由后端在对应接口自动记了，
 * 前端**不要重复上报**这三类，否则看板会翻倍。
 */
import http from './http'

/** 与后端白名单一一对应（docs/接口约定.md） */
export const TRACK_EVENTS = [
  'page_view',
  'search',
  'preview',
  'download',
  'ai_ask',
  'register',
  'feedback_submit'
] as const

export type TrackEventName = (typeof TRACK_EVENTS)[number]

/** 一条待上报事件 */
export interface TrackEventInput {
  event: TrackEventName
  /** 用户 ID；null / 缺省 = 匿名访客 */
  userId?: string | null
  /** 页面来源（路由 fullPath） */
  path?: string
  /** 事件载荷（普通对象；后端限 4000 字符） */
  payload?: Record<string, unknown>
}

/** 后端回执 */
export interface TrackAcceptedResponse {
  success: true
  accepted: number
  rejected: { index: number; code: string; message: string }[]
}

/** GET /api/track/stats 的响应（与后端 StatsSummaryResponse 对应） */
export interface StatsSummary {
  success: true
  generatedAt: string
  totals: { events: number; pv: number; uv: number }
  events: Record<TrackEventName, number>
  topSearchTerms: { term: string; count: number }[]
  zeroResultSearchTerms: { term: string; count: number }[]
  topDownloads: { docId: string; fileName: string; count: number }[]
  downloads: { server: number; events: number }
  asks: { total: number; judged: number; noAnswer: number; unjudged: number; noAnswerRate: number }
  daily: {
    date: string
    events: number
    pv: number
    download: number
    ai_ask: number
    preview: number
    search: number
  }[]
}

const SESSION_KEY = 'zwp.sessionId'

/** 会话标识：一次标签页会话一个（关掉标签页就换新的） */
function sessionId(): string {
  try {
    const saved = sessionStorage.getItem(SESSION_KEY)
    if (saved) return saved
    const created = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    sessionStorage.setItem(SESSION_KEY, created)
    return created
  } catch {
    // 隐私模式下 sessionStorage 可能不可用——退回一次性匿名标识，不影响上报
    return `s-anon-${Math.random().toString(36).slice(2, 10)}`
  }
}

/** 上报一条事件。**永远 resolve**，调用方直接 `void trackEvent(...)` 即可。 */
export async function trackEvent(input: TrackEventInput): Promise<void> {
  await send({
    event: input.event,
    sessionId: sessionId(),
    userId: input.userId ?? null,
    path: input.path ?? '',
    payload: input.payload ?? {}
  })
}

/** 批量上报（一次请求多条，省往返；后端单次上限 100 条） */
export async function trackBatch(inputs: readonly TrackEventInput[]): Promise<void> {
  if (inputs.length === 0) return
  const sid = sessionId()
  const body = inputs.map((input) => ({
    event: input.event,
    sessionId: sid,
    userId: input.userId ?? null,
    path: input.path ?? '',
    payload: input.payload ?? {}
  }))
  await send(body.length === 1 ? body[0] : body)
}

async function send(body: unknown): Promise<void> {
  try {
    await http.post('/track', body, { silent: true })
  } catch (err) {
    // 埋点是旁路：网络抖动 / 后端 500 都不该在控制台刷红，只留一行便于排障
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[track] 埋点上报失败（已忽略）：${detail}`)
  }
}

/**
 * 拉看板数据。需要口令（X-Admin-Token）。
 * 与埋点不同，这个**会抛错**——看板页要据此显示「口令不对 / 未配置」。
 */
export async function fetchStats(token: string): Promise<StatsSummary> {
  const res = await http.get<StatsSummary>('/track/stats', {
    headers: { 'X-Admin-Token': token },
    silent: true
  })
  return res.data
}
