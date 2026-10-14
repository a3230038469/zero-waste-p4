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
  | { type: 'answer' | 'thinking' | 'done' | 'error'; content: string }
  | { type: 'sources'; items: AskSource[] }

export interface AskOptions {
  query: string
  /** 是否要思考过程（默认不要，前端一般不需要） */
  includeThinking?: boolean
  /** 指定知识库；不传用后端 .env 里的默认库 */
  knowledgeBaseIds?: string[]
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
    Accept: 'text/event-stream'
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${apiBase()}/ask`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: options.query,
      includeThinking: options.includeThinking === true,
      ...(options.knowledgeBaseIds ? { knowledgeBaseIds: options.knowledgeBaseIds } : {}),
      ...(options.conversationId ? { conversationId: options.conversationId } : {})
    }),
    ...(options.signal ? { signal: options.signal } : {})
  })

  // 流开始前的错误是普通 JSON（能把状态码发出来）
  if (!res.ok) {
    throw new Error(await readErrorMessage(res))
  }
  if (!res.body) {
    throw new Error('后端没有返回数据流')
  }

  await readSse(res.body, options.onEvent)
}

/** 流开始前的错误体：{ type:'error', content } 或统一错误信封 */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { content?: unknown; error?: { message?: unknown } }
    if (typeof payload.content === 'string' && payload.content) return payload.content
    if (typeof payload.error?.message === 'string') return payload.error.message
  } catch {
    // 不是 JSON 就退回状态码
  }
  return `提问失败（HTTP ${res.status}）`
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
  if (
    parsed['type'] === 'answer' ||
    parsed['type'] === 'thinking' ||
    parsed['type'] === 'done' ||
    parsed['type'] === 'error'
  ) {
    const content = parsed['content']
    return { type: parsed['type'], content: typeof content === 'string' ? content : '' }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
