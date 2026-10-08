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

/** 一条流事件（与后端四个 type 一一对应） */
export interface AskStreamEvent {
  type: 'answer' | 'thinking' | 'done' | 'error'
  content: string
}

export interface AskOptions {
  query: string
  /** 是否要思考过程（默认不要，前端一般不需要） */
  includeThinking?: boolean
  /** 指定知识库；不传用后端 .env 里的默认库 */
  knowledgeBaseIds?: string[]
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
      ...(options.knowledgeBaseIds ? { knowledgeBaseIds: options.knowledgeBaseIds } : {})
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

  try {
    const parsed = JSON.parse(dataLines.join('\n')) as Partial<AskStreamEvent>
    if (
      parsed.type === 'answer' ||
      parsed.type === 'thinking' ||
      parsed.type === 'done' ||
      parsed.type === 'error'
    ) {
      return { type: parsed.type, content: typeof parsed.content === 'string' ? parsed.content : '' }
    }
  } catch {
    // 中途一条脏帧不该打断整段回答
  }
  return null
}
