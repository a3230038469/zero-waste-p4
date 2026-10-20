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

import {
  ConversationNotFoundError,
  appendMessage,
  getConversation,
  setEngineSessionId,
  touchConversation,
  DEFAULT_TITLE
} from '../chat/store.js'
import {
  EngineError,
  askKnowledgeBase,
  createAskSession,
  isTerminalEvent,
  resolveCitationSources
} from '../weknora/index.js'
import type { AskEvent, AskSource } from '../weknora/index.js'
import { recordEvent } from '../track/store.js'

const router = Router()

/** 单次提问最大长度（防超长 query 打爆模型额度） */
export const MAX_QUERY_LEN = 500

/**
 * 透给前端的流事件（契约见 docs/接口约定.md 第二节「流式问答」）。
 *
 * 五个 type：前四个带 content，最后的 sources 只带 items（不带无意义的空 content）。
 */
type AskStreamEvent =
  | { type: 'answer' | 'thinking' | 'done' | 'error'; content: string }
  | { type: 'sources'; items: AskSource[] }

interface AskRequestBody {
  query: string
  knowledgeBaseIds: string[] | undefined
  includeThinking: boolean
  /**
   * T5：带上就「接着聊」（复用该会话的引擎 session → 上下文连续，并落库本轮问答）。
   * 不带（首页旧气泡就是这么调的）= 一次性问答，**行为与加这个字段之前逐字节一致**。
   */
  conversationId: string | undefined
}

/** 请求体解析：非对象 / query 非字符串 / query 空串一律判 null（→400） */
function parseAskBody(raw: unknown): AskRequestBody | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const query = obj['query']
  if (typeof query !== 'string' || query.trim() === '') return null
  const ids = obj['knowledgeBaseIds']
  const conversationId = obj['conversationId']
  return {
    query: query.trim(),
    knowledgeBaseIds: Array.isArray(ids)
      ? ids.filter((v): v is string => typeof v === 'string')
      : undefined,
    includeThinking: obj['includeThinking'] === true,
    conversationId:
      typeof conversationId === 'string' && conversationId.trim() !== ''
        ? conversationId.trim()
        : undefined
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

/** 错误转一句话（给 warn 日志用，别把整坨对象塞进日志） */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 流开始前的错误：普通 JSON，能改状态码 */
function sendPreStreamError(res: Response, err: unknown): void {
  if (err instanceof EngineError) {
    res.status(err.status).json({
      success: false,
      type: 'error',
      content: err.message,
      error: { code: err.code, message: err.message }
    })
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
    res
      .status(400)
      .json({ success: false, type: 'error', content: '请求体需为 {"query":"你的问题"}' })
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

  /**
   * T5：接着聊的上下文载体。
   *
   * 有 conversationId 时：
   *   - 复用该会话的引擎 session → AI 记得这个对话前面说过什么（**不新建**，这就是「上下文连续」的全部秘密）
   *   - 本轮 user / assistant + sources 落库，前端刷新后能恢复画面
   * 没有 conversationId（首页旧气泡）：conv 为 null，下面每一步都跳过，行为与从前一致。
   */
  let conv: { id: string; title: string; userMsgSaved: boolean } | null = null
  try {
    if (body.conversationId) {
      const row = await getConversation(body.conversationId)
      conv = { id: row.id, title: row.title, userMsgSaved: false }

      if (row.engineSessionId) {
        sessionId = row.engineSessionId
      } else {
        // 会话建的时候引擎没就绪（密钥没到位 / 额度 429），这会儿再懒建一次并回填
        sessionId = await createAskSession(`web:${body.query.slice(0, 30)}`)
        await setEngineSessionId(row.id, sessionId)
      }
    } else {
      sessionId = await createAskSession(`web:${body.query.slice(0, 30)}`)
    }
    events = await askKnowledgeBase({
      sessionId,
      query: body.query,
      ...(body.knowledgeBaseIds ? { knowledgeBaseIds: body.knowledgeBaseIds } : {}),
      signal: clientGone.signal
    })
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      res.status(404).json({
        success: false,
        type: 'error',
        content: '这个对话不存在或已被删除，请新建一个',
        error: { code: 'CONVERSATION_NOT_FOUND', message: '这个对话不存在或已被删除' }
      })
      return
    }
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
  let sourcesSent = false
  /** T5：本轮拿到的来源卡片，收尾时与正文一起落库 */
  let collectedSources: AskSource[] = []

  /**
   * T5：user 消息在开流**之前**就落库。
   *
   * 为什么不是等回答完再一起写：用户的问题先入库，哪怕这次问答超时/断线/额度耗尽，
   * 历史里也还留着他问过什么 —— 刷新页面看到的是「我问过，但这次没答上来」，
   * 而不是自己的输入凭空消失。
   *
   * ⚠️ 落库失败**绝不能**打断这一次问答（它已经是锦上添花）：全部吞掉，最多 warn 一行。
   */
  if (conv) {
    try {
      await appendMessage({ conversationId: conv.id, role: 'user', content: body.query })
      conv.userMsgSaved = true
    } catch (err) {
      console.warn(`[ask] 用户消息落库失败（本轮问答不受影响）：${describeError(err)}`)
    }
  }

  /**
   * 收尾前补发来源卡片（每条流只发一次）。
   *
   * 放在 `done` **之前**：前端按事件顺序渲染，先给卡片再收尾，气泡不会「先结束、后冒卡片」。
   * 注意这发生在**全部正文流完之后**，所以不影响「逐字到达」的体验；
   * resolveCitationSources 内部已吞掉所有异常，这里再兜一层，绝不让它打断收尾。
   */
  const sendSources = async (): Promise<void> => {
    if (sourcesSent || clientGone.signal.aborted) return
    sourcesSent = true
    try {
      const items = await resolveCitationSources(answerText)
      if (items.length > 0) {
        collectedSources = items // T5：留着落库
        if (!res.writableEnded) {
          writeSse(res, { type: 'sources', items })
        }
      }
    } catch {
      // 理论上到不了这里（解析函数自己吞异常），留着是为了不让任何意外掐掉收尾帧
    }
  }

  try {
    for await (const evt of events) {
      if (clientGone.signal.aborted) break
      // 终止信号：complete / stop / error（**不是 done**，见 weknora/types.ts 注释）
      if (isTerminalEvent(evt)) {
        if (evt.responseType === 'error') failed = true
        await sendSources()
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
      await sendSources()
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

    // T5：助手回复落库 + 会话置顶。
    //
    // ⚠️ 在 `finally` 里：**一定要在 res.end() 之前**。res.end() 一执行，
    //    本次请求的生命周期就结束了，后面再 await 落库属于「响应已发还在写」，
    //    客户端断开时这段 await 会被打断，历史里就少这一条。
    //
    // 只在「有正文且是 assistant 视角」时写：错误帧（429 / 引擎不可用）不是回答，
    // 写进历史会让刷新后的页面出现一条永远答不出来的死气泡。
    if (conv && answerText.trim() !== '') {
      try {
        await appendMessage({
          conversationId: conv.id,
          role: 'assistant',
          content: answerText,
          sources: collectedSources
        })
        // 标题还是默认的 + 这是第一条用户消息 -> 用首问改标题，
        // 否则列表里全是「新对话」，用户根本分不清哪个是自己刚聊的那个
        const firstQuestion =
          !conv.userMsgSaved || conv.title === DEFAULT_TITLE
            ? body.query.replace(/\s+/g, ' ').trim().slice(0, 20)
            : ''
        await touchConversation({
          conversationId: conv.id,
          ...(firstQuestion ? { newTitle: firstQuestion } : {})
        })
      } catch (err) {
        console.warn(`[ask] 助手回复落库失败（问答已完成，不影响本次返回）：${describeError(err)}`)
      }
    }

    res.end()
  }
}

export default router
