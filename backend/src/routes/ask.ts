/**
 * 流式问答接口 —— 负责人：韶茹
 *
 *   POST /api/ask   提问，SSE 逐字回吐（给 B07 问答窗口用）
 *
 * 契约见 docs/接口约定.md 第二节「流式问答」。
 * 设计要点：
 *   - 前端连的是**自建后端**，引擎地址与密钥永不外泄（铁律 1 / 2）
 *   - 会话 id 服务端持有，前端拿不到
 *   - 引擎未配密钥 / 连不上 → 流开始前给 503 + {"type":"error"}，前端显示「AI 暂时不可用」
 *   - 流开始后的报错只能以 error 事件收尾（HTTP 状态码已经发出去了，改不了）
 */
import { Router, type Request, type Response } from 'express'

import { EngineError, askKnowledgeBase, createAskSession, isTerminalEvent } from '../weknora/index.js'
import type { AskEvent } from '../weknora/index.js'
import { recordEvent } from '../track/store.js'

const router = Router()

/** 单次提问最大长度（防超长 query 打爆模型额度） */
export const MAX_QUERY_LEN = 500

/** 透给前端的流事件（与契约的四个 type 一一对应） */
interface AskStreamEvent {
  type: 'answer' | 'thinking' | 'done' | 'error'
  content: string
}

interface AskRequestBody {
  query: string
  knowledgeBaseIds: string[] | undefined
  includeThinking: boolean
}

/** 请求体解析：非对象 / query 非字符串 / query 空串一律判 null（→400） */
function parseAskBody(raw: unknown): AskRequestBody | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const query = obj['query']
  if (typeof query !== 'string' || query.trim() === '') return null
  const ids = obj['knowledgeBaseIds']
  return {
    query: query.trim(),
    knowledgeBaseIds: Array.isArray(ids)
      ? ids.filter((v): v is string => typeof v === 'string')
      : undefined,
    includeThinking: obj['includeThinking'] === true
  }
}

/** 开关：提问是否需要登录（默认 false = 访客免注册可问） */
function requireLoginForAsk(): boolean {
  return (process.env.REQUIRE_LOGIN_FOR_ASK ?? '').trim().toLowerCase() === 'true'
}

/** 每条事件按 SSE 规范写成 `data: {json}\n\n`（curl -N 能实时看到） */
function writeSse(res: Response, event: AskStreamEvent): void {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

/** 流开始前的错误：普通 JSON，能改状态码 */
function sendPreStreamError(res: Response, err: unknown): void {
  if (err instanceof EngineError) {
    res
      .status(err.status)
      .json({ success: false, type: 'error', content: err.message, error: { code: err.code, message: err.message } })
    return
  }
  const message = err instanceof Error ? err.message : '服务器内部错误'
  res.status(500).json({ success: false, type: 'error', content: message })
}

router.post('/', (req: Request, res: Response) => {
  void handleAsk(req, res)
})

async function handleAsk(req: Request, res: Response): Promise<void> {
  const body = parseAskBody(req.body)
  if (body === null) {
    res.status(400).json({ success: false, type: 'error', content: '请求体需为 {"query":"你的问题"}' })
    return
  }
  if (body.query.length > MAX_QUERY_LEN) {
    res
      .status(400)
      .json({ success: false, type: 'error', content: `问题过长（上限 ${MAX_QUERY_LEN} 字）` })
    return
  }

  // 提问是否需登录：开关关着（默认）就不校验，访客可直接问
  if (requireLoginForAsk() && !req.headers.authorization) {
    // ⚠️ 这里只做「有没有带凭证」的粗判。开关打开后若要真校验 JWT，
    //    应由月月的 auth 模块提供中间件挂到这里（属接口对接，不是本模块能自证的）。
    res.status(401).json({
      success: false,
      type: 'error',
      content: '提问需要登录',
      error: { code: 'LOGIN_REQUIRED', message: '提问需要登录' }
    })
    return
  }

  // 客户端断开 -> 中止上游引擎（signal 真正透传到 fetch，引擎侧随之停止，不白跑一次模型）
  const clientGone = new AbortController()
  let events: AsyncGenerator<AskEvent, void, void>
  let sessionId: string
  try {
    sessionId = await createAskSession(`web:${body.query.slice(0, 30)}`)
    events = await askKnowledgeBase({
      sessionId,
      query: body.query,
      ...(body.knowledgeBaseIds ? { knowledgeBaseIds: body.knowledgeBaseIds } : {}),
      signal: clientGone.signal
    })
  } catch (err) {
    sendPreStreamError(res, err)
    return
  }

  req.on('aborted', () => clientGone.abort())
  res.on('close', () => clientGone.abort())

  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // 防 nginx 缓冲（deploy/nginx.conf 后续对齐）
  res.flushHeaders()

  // 埋点：一次提问只记一条，收尾时统一落库（口径 = 服务端实测有没有给出正文）
  let terminated = false
  let answerText = ''
  let failed = false
  try {
    for await (const evt of events) {
      if (clientGone.signal.aborted) break
      // 终止信号：complete / stop / error（**不是 done**，见 weknora/types.ts 注释）
      if (isTerminalEvent(evt)) {
        if (evt.responseType === 'error') failed = true
        writeSse(res, {
          type: evt.responseType === 'error' ? 'error' : 'done',
          content: evt.content
        })
        terminated = true
        break
      }
      if (evt.responseType === 'answer') {
        if (evt.content !== '') {
          answerText += evt.content
          writeSse(res, { type: 'answer', content: evt.content })
        }
        continue
      }
      // 思考过程默认不透（前端不需要），includeThinking=true 才给
      if (evt.responseType === 'thinking') {
        if (body.includeThinking && evt.content !== '') {
          writeSse(res, { type: 'thinking', content: evt.content })
        }
        continue
      }
      // 其余类型（agent_query 入队确认 / references 引用 / session_title 等）不透给前端
    }
    // 上游没发终止帧就断了（异常收尾）：补一个 done，前端才知道流结束
    if (!terminated && !res.writableEnded && !clientGone.signal.aborted) {
      writeSse(res, { type: 'done', content: '' })
    }
  } catch (err) {
    failed = true
    const error =
      err instanceof EngineError ? err : new EngineError('INTERNAL_ERROR', '问答过程中出错', 500)
    // 流已开始，只能以 SSE error 事件收尾
    writeSse(res, { type: 'error', content: error.message })
  } finally {
    // 无答案口径只在这一处落库：正常收尾且正文为空 = 引擎没答上来（noAnswer=true）；
    // 有正文 = 有答案（false）；出错/中途断开 = 判不了（null，进 unjudged）
    const finishedNormally = !failed && !clientGone.signal.aborted
    recordEvent({
      event: 'ai_ask',
      path: '/api/ask',
      payload: {
        query: body.query,
        noAnswer: finishedNormally ? answerText.trim() === '' : null
      }
    })
    res.end()
  }
}

export default router
