/**
 * 流式问答客户端（B07 用）—— 负责人：韶茹
 *
 * POST /api/ask，SSE 逐字回吐。契约见 docs/接口约定.md 第二节「流式问答」。
 *
 * ⚠️ 为什么不用 axios：axios 会把响应体整个缓冲完再给你，拿不到增量，
 *    「逐字显示」就变成了「等 10 秒一次性蹦出来」。必须用原生 fetch + getReader()。
 *
 * 用法：
 *   const ctrl = new AbortController()
 *   await askStream({
 *     query: '厨余垃圾怎么堆肥？',
 *     signal: ctrl.signal,
 *     onEvent: (evt) => {
 *       if (evt.type === 'answer') bubble.value += evt.content
 *       if (evt.type === 'done') loading.value = false
 *       if (evt.type === 'error') message.value = evt.content
 *     }
 *   })
 */
import http, { TOKEN_KEY } from './http'
import { ASK_ERROR_TEXT, isPublicSafeText } from '../utils/askCopy'

/** 来源卡片的一条（T4：回答里 `【资料名：…】` / `<kb doc="…" />` 解析出来的） */
export interface AskSource {
  /** 展示用资料名 */
  name: string
  /** 站内详情页地址，后端给的形如 `/doc/<id>` */
  url: string
  /**
   * 【T8 追加，可选】发布机构 / 发布年份 / 类型。
   * 后端优先读引用自带的 `knowledge_custom_metadata`，读不到退回书架清单本地关联；
   * 都没有时这三个字段直接不出现（卡片退化成只显示资料名，与从前一致）。
   */
  org?: string
  year?: string
  type?: string
}

/**
 * 一条流事件。
 *
 * 五个 type：`answer` / `thinking` / `done` / `error` 带 `content`；
 * `sources`（T4 新增）只带 `items`，不带 content。
 */
export type AskStreamEvent =
  | { type: 'answer' | 'thinking' | 'done'; content: string }
  /** 失败帧：`code` 是后端给的机器可读码（AI_QUOTA_EXHAUSTED / AI_TIMEOUT …），公众界面只显示 content */
  | { type: 'error'; content: string; code?: string }
  | { type: 'sources'; items: AskSource[] }

/** 单个问题的字数上限（与后端 backend/src/routes/ask.ts 的 MAX_QUERY_LEN 一致） */
export const MAX_QUESTION_LENGTH = 500

/** 客户端整体超时（后端引擎超时是 180s，这里留一点余量再判超时） */
const ASK_CLIENT_TIMEOUT_MS = 200_000

/**
 * 失败分三类：断网 / 超时 / 被中止。
 *
 * 🔴 以前这里只抛原生 Error（message = 'Failed to fetch'），页面直接把这句英文显示出来；
 *    现在统一成 AskError，调用方按 kind 拿中文文案。
 */
export type AskErrorKind = 'network' | 'timeout' | 'aborted' | 'http' | 'unknown'

export class AskError extends Error {
  readonly kind: AskErrorKind
  /** HTTP 状态码（只有 kind === 'http' 时有） */
  readonly status?: number
  /** 后端给的错误码 */
  readonly code?: string

  constructor(
    kind: AskErrorKind,
    message: string,
    options: { status?: number; code?: string } = {}
  ) {
    super(message)
    this.name = 'AskError'
    this.kind = kind
    this.status = options.status
    this.code = options.code
    // ES5 target 下 extends Error 会丢原型，显式补回来（否则 instanceof 失效）
    Object.setPrototypeOf(this, AskError.prototype)
  }
}

/**
 * 匿名访客的会话归属令牌（与 frontend/src/api/chat.ts 同一枚）。
 *
 * ⚠️ 后端从 2026-10-21 起对「带着别人的 conversationId 提问」直接 403，
 *    所以问接口也必须带上自己那枚令牌，否则匿名用户会把自己刚建的会话当成别人的。
 */
const OWNER_KEY = 'zwp.chat.owner'
const OWNER_HEADER = 'X-Chat-Owner'
const OWNER_TOKEN_RE = /^[0-9a-f]{32}$/

function ownerToken(): string {
  try {
    return localStorage.getItem(OWNER_KEY) ?? ''
  } catch {
    return ''
  }
}

function ownerHeaders(): Record<string, string> {
  const token = ownerToken()
  return token && OWNER_TOKEN_RE.test(token) ? { [OWNER_HEADER]: token } : {}
}

/** 后端第一次给匿名访客发令牌时存下来（后端会把 X-Chat-Owner 放进 expose headers） */
function rememberOwner(res: Response): void {
  const raw = res.headers.get('x-chat-owner')
  if (typeof raw === 'string' && OWNER_TOKEN_RE.test(raw)) {
    try {
      localStorage.setItem(OWNER_KEY, raw)
    } catch {
      // 隐私模式存不下就算了：后端还有 cookie 兜底
    }
  }
}

export interface AskOptions {
  query: string
  /** 是否要思考过程（默认不要，前端一般不需要） */
  includeThinking?: boolean
  // ⚠️ T7（契约 C9）：检索范围能力已下线 —— 不再支持指定知识库
  /**
   * T5：带上 = 「接着聊」。
   *
   * 后端会复用这个会话的引擎 session（AI 记得上文），并把本轮问答落库。
   * **不传**就是一次性问答 —— 首页旧气泡就是这么调的，行为与加这个字段之前完全一致。
   */
  conversationId?: string
  /** 中止（用户关窗口 / 组件卸载）——会真正断开上游，不让引擎白跑 */
  signal?: AbortSignal
  /** 每收到一条事件回调一次 */
  onEvent: (event: AskStreamEvent) => void
}

/** 后端地址与 http 封装保持一致，避免两处配置漂移 */
function apiBase(): string {
  return http.defaults.baseURL ?? 'http://localhost:4000/api'
}

/**
 * 发起一次流式提问。
 * 正常结束（收到 done）时 resolve；流内报错时回调 onEvent({type:'error'}) 后 resolve；
 * 连接层面出错（后端没起、超时、网络断）时 reject，调用方需自己兜。
 */
export async function askStream(options: AskOptions): Promise<void> {
  const token = localStorage.getItem(TOKEN_KEY)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...ownerHeaders()
  }
  if (token) headers.Authorization = `Bearer ${token}`

  // 自己的中止信号 + 客户端超时，合成一个信号传给 fetch
  const controller = new AbortController()
  const onOuterAbort = (): void => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onOuterAbort)
  }
  const timer = window.setTimeout(() => controller.abort(), ASK_CLIENT_TIMEOUT_MS)

  try {
    const res = await fetch(`${apiBase()}/ask`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: options.query,
        includeThinking: options.includeThinking === true,
        ...(options.conversationId ? { conversationId: options.conversationId } : {})
      }),
      signal: controller.signal
    })
    rememberOwner(res)

    // 流开始前的错误是普通 JSON（能把状态码发出来）
    if (!res.ok) {
      const { message, code } = await readErrorMessage(res)
      throw new AskError('http', message, { status: res.status, code })
    }
    if (!res.body) {
      throw new AskError('unknown', '后端没有返回数据流')
    }

    await readSse(res.body, options.onEvent)
  } catch (err) {
    if (err instanceof AskError) throw err
    // 三种失败分清楚，别再把 'Failed to fetch' 甩给公众
    if (options.signal?.aborted) throw new AskError('aborted', ASK_ERROR_TEXT.aborted)
    if (controller.signal.aborted) throw new AskError('timeout', ASK_ERROR_TEXT.timeout)
    throw new AskError('network', ASK_ERROR_TEXT.network)
  } finally {
    window.clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * 流开始前的错误体：{ type:'error', content } 或统一错误信封。
 *
 * 🔴 双保险：后端已经只给中文了，但如果文案里混进了内部细节（request_id / URL / 英文原文），
 *    这里换成通用中文，不给公众看。
 */
async function readErrorMessage(res: Response): Promise<{ message: string; code?: string }> {
  try {
    const payload = (await res.json()) as {
      content?: unknown
      error?: { message?: unknown; code?: unknown }
    }
    const raw =
      typeof payload.content === 'string' && payload.content
        ? payload.content
        : typeof payload.error?.message === 'string'
          ? payload.error.message
          : ''
    const code = typeof payload.error?.code === 'string' ? payload.error.code : undefined
    if (raw && isPublicSafeText(raw)) return { message: raw, code }
    if (raw) return { message: ASK_ERROR_TEXT.http, code }
    return { message: `提问失败（HTTP ${res.status}）`, code }
  } catch {
    // 不是 JSON 就退回状态码
    return { message: `提问失败（HTTP ${res.status}）` }
  }
}

/** 逐帧读 SSE，解析成 AskStreamEvent 回调出去 */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AskStreamEvent) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 以空行分帧
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const event = parseFrame(frame)
        if (event !== null) onEvent(event)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** 一帧 -> 事件；只取 data: 行，其余（注释 / event: 行）忽略 */
function parseFrame(frame: string): AskStreamEvent | null {
  const dataLines: string[] = []
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith('data:')) continue
    const value = line.slice(5).trimStart()
    dataLines.push(value)
  }
  if (dataLines.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(dataLines.join('\n'))
  } catch {
    // 中途一条脏帧不该打断整段回答
    return null
  }
  if (!isRecord(parsed)) return null

  if (parsed['type'] === 'sources') {
    const items = toSources(parsed['items'])
    // 认得这个事件但没有可用条目：返回 null，不往气泡上挂空卡片
    return items.length > 0 ? { type: 'sources', items } : null
  }
  if (parsed['type'] === 'answer' || parsed['type'] === 'thinking' || parsed['type'] === 'done') {
    const content = parsed['content']
    return { type: parsed['type'], content: typeof content === 'string' ? content : '' }
  }
  if (parsed['type'] === 'error') {
    const content = parsed['content']
    const code = parsed['code']
    const raw = typeof content === 'string' ? content : ''
    return {
      type: 'error',
      // 内部细节不外泄
      content: raw && isPublicSafeText(raw) ? raw : ASK_ERROR_TEXT.unknown,
      ...(typeof code === 'string' && code ? { code } : {})
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 取消一轮在途问答（重新生成 / 删除会话时用）。
 *
 * 🔴 为什么需要它：服务端从 2026-10-21 起**不再**因为「客户端断开」而中止上游
 *    （断开 ≠ 用户想中止，刷新页面也会断开，那一轮还得跑完落库）。
 *    所以「用户真的不要这一轮了」必须显式说一声：掐断上游 + 这一轮只留一条「已取消」。
 *
 * 归属校验同后端：只能取消自己会话里的在途问答（越权 403）。
 */
export async function cancelAskTurn(conversationId: string): Promise<boolean> {
  if (!conversationId) return false
  try {
    const res = await http.post<{ success?: boolean; cancelled?: boolean }>(
      '/ask/cancel',
      { conversationId },
      { headers: ownerHeaders(), silent: true }
    )
    return res.data?.cancelled === true
  } catch {
    // 取消失败不该打断界面：服务端那一轮最多就是白跑一次
    return false
  }
}

/** 游客今天还能问几次（后端 GET /api/guest/ask-usage） */
export interface AskUsage {
  limit: number
  used: number
  remaining: number
}

/**
 * 读游客剩余提问次数。
 *
 * 接口还没有 / 读不到 → 返回 null（界面就不显示次数，不编数字）。
 * 用 silent:true 是因为接口不存在时不该弹 axios 的通用错误 toast。
 */
export async function fetchAskUsage(): Promise<AskUsage | null> {
  try {
    const res = await http.get('/guest/ask-usage', { silent: true })
    const body = res.data as Record<string, unknown>
    const raw = (isRecord(body?.['data']) ? body['data'] : body) as Record<string, unknown>
    const limit = Number(raw?.['limit'])
    const used = Number(raw?.['used'])
    const remaining = Number(raw?.['remaining'])
    if (!Number.isFinite(limit) || !Number.isFinite(used) || !Number.isFinite(remaining)) return null
    return { limit, used, remaining }
  } catch {
    return null
  }
}

/** 引擎当前能不能问答（后端 GET /api/ai/status） */
export interface AskAiStatus {
  available: boolean
  reason?: string
  messageZh?: string
}

/**
 * 读引擎可用状态。
 *
 * 接口还没有 / 读不到 → 返回 null（界面不显示降级公告，不编状态）。
 */
export async function fetchAiStatus(): Promise<AskAiStatus | null> {
  try {
    const res = await http.get('/ai/status', { silent: true })
    const body = res.data as Record<string, unknown>
    const raw = (isRecord(body?.['data']) ? body['data'] : body) as Record<string, unknown>
    if (typeof raw?.['available'] !== 'boolean') return null
    return {
      available: raw['available'],
      ...(typeof raw['reason'] === 'string' ? { reason: raw['reason'] } : {}),
      ...(typeof raw['messageZh'] === 'string' ? { messageZh: raw['messageZh'] } : {})
    }
  } catch {
    return null
  }
}

/** 后端给的 items 逐项校验：字段不全的丢掉，不让半个 undefined 漏到模板里 */
function toSources(raw: unknown): AskSource[] {
  if (!Array.isArray(raw)) return []
  const items: AskSource[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const name = entry['name']
    const url = entry['url']
    if (typeof name !== 'string' || !name.trim()) continue
    if (typeof url !== 'string' || !url.startsWith('/')) continue
    // T8：机构 / 年份 / 类型是可选的（老后端不发这三个字段 → 卡片只显示资料名）
    const org = entry['org']
    const year = entry['year']
    const type = entry['type']
    items.push({
      name,
      url,
      ...(typeof org === 'string' && org ? { org } : {}),
      ...(typeof year === 'string' && year ? { year } : {}),
      ...(typeof type === 'string' && type ? { type } : {})
    })
  }
  return items
}

