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
import { ConversationForbiddenError, assertConversationOwner, resolveOwner } from '../chat/owner.js'
import {
  EngineError,
  askKnowledgeBase,
  createAskSession,
  isTerminalEvent,
  resolveCitationSources
} from '../weknora/index.js'
import { readAgentSources } from '../weknora/agent-sse.js'
import type { AskEvent, AskSource } from '../weknora/index.js'
import { recordEvent } from '../track/store.js'
import { bumpGuestAsk, countGuestAsk } from '../guest/ask-usage.js'
import { userIdFromRequest } from '../guest/identity.js'
import { loadGuestPermissions } from '../guest/permissions.js'

const router = Router()

/** 单次提问最大长度（防超长 query 打爆模型额度） */
export const MAX_QUERY_LEN = 500

/**
 * 落库前缀：失败 / 库内没有 / 已取消。
 *
 * 🔴 为什么用前缀而不是加字段：Message 表只有 content 一个文本列（没有 error/status 列），
 *    改表结构是别的任务的地盘。前缀方案对本项目足够可靠 —— AI 回答不会以「【问答失败】」开头。
 *    ⚠️ 这三个常量必须与 frontend/src/utils/askCopy.ts 里的同名常量保持一致（两边互相指路）。
 */
const STORED_FAILED_PREFIX = '【问答失败】'
/** 落库前缀：正常收尾，但库内没有能回答这个问题的资料 */
const STORED_NO_ANSWER_PREFIX = '【库内暂无】'
/** 落库前缀：这一轮被用户主动取消（重新生成 / 删会话） */
const STORED_CANCELLED_PREFIX = '【已取消】'

/**
 * 在途轮次：**按轮次登记**，不是按会话只存一条。
 *
 * 🔴 2026-10-21 修掉的竞态：以前 inFlightTurns 是 conversationId → 轮次，
 *   同一个会话连开两轮时，老一轮的 finally 会 delete(conv.id)，
 *   把**新一轮**的登记一起删掉 → 之后点「停止生成」找不到在途轮次，取消不生效。
 * 现在分两张表：
 *   - inFlightTurns：turnId → 轮次（每轮一条，收尾只准清自己那条）
 *   - conversationTurns：conversationId → 该会话**当前**在途的 turnId
 */
interface InFlightTurn {
  /** 本轮唯一标识：收尾时只清自己这一条 */
  turnId: string
  /** 所属会话（取消接口按会话找在途轮次） */
  conversationId: string
  controller: AbortController
  discarded: boolean
}
const inFlightTurns = new Map<string, InFlightTurn>()
/** conversationId → 当前在途轮次的 turnId */
const conversationTurns = new Map<string, string>()
let turnSeq = 0
function newTurnId(): string {
  turnSeq += 1
  return `turn-${Date.now().toString(36)}-${turnSeq.toString(36)}`
}

/**
 * 额度耗尽（上游 429）的对外口径 —— 这句话**只在这里写一次**。
 * classifyEngineText（EngineError 文本命中）与 publicEngineError（跨形态识别）共用，
 * 避免两处硬编码同一条文案、改一处漏一处。
 */
function quotaExhausted(): { code: string; message: string } {
  return { code: 'AI_QUOTA_EXHAUSTED', message: 'AI 服务的调用额度暂时用尽，请稍后再试' }
}

/**
 * 🔴 R6（2026-10-21）：把「429 的线索」从任意异常形态里抠出来，拼成一条字符串。
 *
 * 429 不一定以 EngineError 的身份到达：fetch 包装、上游 SDK、代理层会把它挂在
 * err.status / statusCode / response.status / response.data.error.message / cause 上。
 * 只认 EngineError 会漏掉这些形态（→ 掉进兜底分支，退化成通用文案）。
 * 只做「收集线索」，判定逻辑留在调用处。
 */
function errorHints(err: unknown): string {
  if (typeof err !== 'object' || err === null) return typeof err === 'string' ? err : ''
  const e = err as {
    message?: unknown
    code?: unknown
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown; data?: { error?: { message?: unknown } } }
    cause?: { message?: unknown }
  }
  return [
    e.message,
    e.code,
    e.status,
    e.statusCode,
    e.response?.status,
    e.response?.data?.error?.message,
    e.cause?.message
  ]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v))
    .join(' | ')
}

/**
 * 🔴 对外只给中文人话：**不外泄**内部 URL、request_id、英文原文。
 *
 * 以前引擎报错是原文透出去的，公众页面上直接出现过
 * "create chat completion stream: API request failed with status 429: {...request_id...}"。
 * 现在统一收敛成一句中文 + 一个错误码（错误码沿用引擎自己的，方便运维定位）。
 */
function classifyEngineText(raw: string): { code: string; message: string } | null {
  if (!raw) return null
  if (/insufficient balance|余额不足|额度用尽|quota|429/i.test(raw)) {
    return quotaExhausted()
  }
  if (/per-response output limit|output limit|maximum context length|too many tokens/i.test(raw)) {
    return { code: 'AI_OUTPUT_LIMIT', message: '这次回答超出了模型单次输出上限，请换个问法再试一次' }
  }
  if (/timeout|timed out|超时/i.test(raw)) {
    return { code: 'AI_TIMEOUT', message: '回答超时了，请稍后重试' }
  }
  if (/not configured|未配置|演示版/i.test(raw)) {
    return { code: 'AI_UNAVAILABLE', message: 'AI 问答暂未开放，请稍后再试' }
  }
  if (/unauthorized|invalid api key|401|403/i.test(raw)) {
    return { code: 'AI_UNAVAILABLE', message: 'AI 问答服务暂时不可用，请稍后再试' }
  }
  return null
}

/** 任何异常 → 对外中文文案 + 错误码（export 仅为便于用临时脚本喂异常形态，业务代码不直接用） */
export function publicEngineError(err: unknown): { code: string; message: string } {
  // 🔴 R6（2026-10-21）：**跨形态 429 识别**，必须放在任何分支之前。
  //    以前只有「EngineError 且 message 里带关键词」才给额度专用文案，
  //    非 EngineError 的 429（status / code / response.status / cause 携带）会掉到兜底，
  //    退化成通用「AI 问答服务暂时不可用，请稍后再试」→ 用户不知道该充值还是该重试。
  //    这里只增加「命中即返回」，下面的 EngineError / 兜底分支保持原样。
  if (/\b429\b|quota|insufficient|balance|额度|余额/i.test(errorHints(err))) {
    return quotaExhausted()
  }
  if (err instanceof EngineError) {
    const hit = classifyEngineText(err.message || '')
    if (hit) return hit
    if (err.code === 'INTERNAL_ERROR') {
      return { code: err.code, message: '问答过程中出错，请稍后再试' }
    }
    return { code: err.code, message: 'AI 问答服务暂时不可用，请稍后再试' }
  }
  return { code: 'AI_UNAVAILABLE', message: '问答过程中出错，请稍后再试' }
}

/**
 * 🔴 「引擎把错误当答案返回」的识别（lead 追加要求，2026-10-21）。
 *
 * 上游模型有时不吐 error 帧，而是把一句英文报错当**正文**吐出来，例如：
 *   "Sorry, this answer hit the model's per-response output limit before any text was produced."
 * 这种正文照原样渲染出去，公众看到的就是一句英文技术话 —— 必须转成中文失败态。
 *
 * 判定口径（宁可漏判也不误伤正常答案）：
 *   - 正文里出现中文 → 不判（正常回答一定是中文的）；
 *   - 正文太长（> 400 字）→ 不判；
 *   - 整段命中已知英文报错特征 → 判失败。
 */
function detectEngineErrorAnswer(answerText: string): { code: string; message: string } | null {
  const text = answerText.trim()
  if (text === '') return null
  if (/[\u4e00-\u9fa5]/.test(text)) return null
  if (text.length > 400) return null
  if (!/sorry|error|failed|failure|limit|429|quota|balance|unavailable|timeout|exceeded/i.test(text)) {
    return null
  }
  return classifyEngineText(text)
}

/**
 * 透给前端的流事件（契约见 docs/接口约定.md 第二节「流式问答」）。
 *
 * 五个 type：前四个带 content，最后的 sources 只带 items（不带无意义的空 content）。
 */
type AskStreamEvent =
  | { type: 'answer' | 'thinking' | 'done'; content: string }
  | { type: 'error'; content: string; code?: string }
  | { type: 'sources'; items: AskSource[] }

interface AskRequestBody {
  query: string
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
  const conversationId = obj['conversationId']
  // ⚠️ T7（契约 C9）：检索范围已下线 —— 请求体里的「资料范围」字段一律**忽略**（不报错、不透传）
  return {
    query: query.trim(),
    includeThinking: obj['includeThinking'] === true,
    conversationId:
      typeof conversationId === 'string' && conversationId.trim() !== ''
        ? conversationId.trim()
        : undefined
  }
}

/**
 * 🔴 T11：游客能不能问 AI，以及游客当天问了几次 —— **在开流之前**判定。
 *
 * 放在开流前的原因：流一旦开始，HTTP 状态码就发出去了改不了，
 * 只能以 `error` 事件收尾 —— 那时用户已经看到「在思考」再被拒，体验最差。
 *
 * 口径（与全站其余「游客判定」同源，见 guest/identity.ts）：
 *   - 「是不是游客」按 **JWT 校验通过** 判（不是只看有没有 Authorization 头），
 *     凭证无效按游客处理（fail closed：判不出登录态时绝不放行）。
 *   - `aiAsk` 关闭 → 403 `GUEST_ASK_CLOSED`。
 *   - `aiAskDailyLimit > 0` 且当天用满 → 403 `GUEST_ASK_LIMIT_REACHED`；
 *     **已登录用户完全不受限**（直接跳过这一段，也不消耗额度）。
 *   - 计数在放行前 +1：被拒的请求不消耗额度。
 */
function allowGuestAsk(req: Request, askerId: string | null): { ok: true } | { ok: false; status: number; code: string; message: string } {
  if (askerId) return { ok: true }

  const permissions = loadGuestPermissions()
  if (!permissions.aiAsk) {
    return { ok: false, status: 403, code: 'GUEST_ASK_CLOSED', message: 'AI 问答暂未对游客开放，请登录后使用' }
  }

  const limit = permissions.aiAskDailyLimit
  if (limit > 0) {
    const used = countGuestAsk(req)
    if (used >= limit) {
      return {
        ok: false,
        status: 403,
        code: 'GUEST_ASK_LIMIT_REACHED',
        message: `游客每天可提问 ${limit} 次，今天已用完，请登录后继续提问`
      }
    }
    // 放行前记一次（引擎后来报错也算用掉：限流防的是刷，不是失败补偿）
    bumpGuestAsk(req)
  }
  return { ok: true }
}

/** 每条事件按 SSE 规范写成 `data: {json}\n\n`（curl -N 能实时看到） */
function writeSse(res: Response, event: AskStreamEvent): void {
  if (res.writableEnded || res.destroyed) return
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  } catch {
    // 客户端已经走了（刷新 / 关页）：写不进去就算了 —— 服务端会把这一轮跑完并落库
  }
}

/** 错误转一句话（给 warn 日志用，别把整坨对象塞进日志） */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 流开始前的错误：普通 JSON，能改状态码（对外一律中文，不外泄内部信息） */
function sendPreStreamError(res: Response, err: unknown): void {
  const pub = publicEngineError(err)
  const status = err instanceof EngineError ? err.status : 500
  res.status(status).json({
    success: false,
    type: 'error',
    content: pub.message,
    error: { code: pub.code, message: pub.message }
  })
}

router.post('/', (req: Request, res: Response) => {
  void handleAsk(req, res)
})

/**
 * 取消一轮在途问答（前端「重新生成」/「删除会话」时调用）。
 *
 * 🔴 为什么需要这个接口：**客户端断开 ≠ 用户想中止**（刷新页面也会断开）。
 *    服务端现在遇到断开会把这一轮跑完并落库（刷新回来还能看到答案），
 *    所以「用户真的不要这一轮了」必须由前端显式说一声：
 *      - 掐断上游引擎（不白花额度）
 *      - 标记这一轮「丢弃」→ 收尾只留一条「【已取消】」，不落正文
 *
 * 归属校验同 T1：只能取消自己会话里的在途问答。
 */
router.post('/cancel', (req: Request, res: Response) => {
  const body = req.body as { conversationId?: unknown } | undefined
  const raw = body?.conversationId
  const conversationId = typeof raw === 'string' ? raw.trim() : ''
  if (!conversationId) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_BODY', message: '缺少 conversationId' }
    })
    return
  }
  const owner = resolveOwner(req, res)
  void assertConversationOwner(conversationId, owner)
    .then(() => {
      // 按会话找出在途轮次：同一会话可能同时挂着几轮（老轮次收尾慢 + 新一轮已开），
      // 全部掐掉 —— 用户点「停止生成」的意图是「这个会话里别再跑了」。
      const entries = [...inFlightTurns.values()].filter((t) => t.conversationId === conversationId)
      for (const entry of entries) {
        entry.discarded = true
        entry.controller.abort()
        inFlightTurns.delete(entry.turnId)
        if (conversationTurns.get(entry.conversationId) === entry.turnId) {
          conversationTurns.delete(entry.conversationId)
        }
      }
      res.json({ success: true, cancelled: entries.length > 0 })
    })
    .catch((err: unknown) => {
      if (err instanceof ConversationForbiddenError) {
        res.status(403).json({
          success: false,
          error: { code: 'CONVERSATION_FORBIDDEN', message: '无权访问这个对话' }
        })
        return
      }
      if (err instanceof ConversationNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'CONVERSATION_NOT_FOUND', message: '这个对话不存在或已被删除' }
        })
        return
      }
      res.status(500).json({
        success: false,
        error: { code: 'ASK_INTERNAL_ERROR', message: '取消失败，请稍后再试' }
      })
    })
})

async function handleAsk(req: Request, res: Response): Promise<void> {
  const body = parseAskBody(req.body)
  if (body === null) {
    res.status(400).json({ success: false, type: 'error', content: '请求体需为 {"query":"你的问题"}', error: { code: 'VALIDATION_FAILED', message: '请求体需为 {"query":"你的问题"}' } })
    return
  }
  if (body.query.length > MAX_QUERY_LEN) {
    res
      .status(400)
      .json({ success: false, type: 'error', content: `问题过长（上限 ${MAX_QUERY_LEN} 字）`, error: { code: 'VALIDATION_FAILED', message: `问题过长（上限 ${MAX_QUERY_LEN} 字）` } })
    return
  }

  /**
   * 🔴 T1 会话鉴权：带着**别人的** conversationId 来提问 → 403，绝不往别人的会话里追加消息。
   *
   * 三个位置要求：
   *   1. 在开流前判（开流后状态码就改不了了，只能以 error 帧收尾）；
   *   2. 在额度判定**前**（越权探测不该消耗游客的提问次数）；
   *   3. 越权时**不返回任何会话内容**（连「这个对话存不存在」都不告诉外人）。
   *
   * 归属口径见 backend/src/chat/owner.ts（auth-sec 落地，契约 C1.1）：
   * 匿名用户靠 X-Chat-Owner 头 / zwp_chat_owner cookie 认领自己的会话，登录用户按 JWT 认领。
   */
  if (body.conversationId) {
    const owner = resolveOwner(req, res)
    try {
      await assertConversationOwner(body.conversationId, owner)
    } catch (err) {
      if (err instanceof ConversationForbiddenError) {
        res.status(403).json({
          success: false,
          type: 'error',
          content: '无权访问这个对话',
          error: { code: 'CONVERSATION_FORBIDDEN', message: '无权访问这个对话' }
        })
        return
      }
      if (err instanceof ConversationNotFoundError) {
        res.status(404).json({
          success: false,
          type: 'error',
          content: '这个对话不存在或已被删除，请新建一个',
          error: { code: 'CONVERSATION_NOT_FOUND', message: '这个对话不存在或已被删除' }
        })
        return
      }
      throw err
    }
  }

  // 🔴 T11：游客权限真拦（开流前）。已登录用户不受开关与次数限制。
  //    askerId 同时用于本次问答的埋点归属（T11-B：埋点必须带上账号）。
  const askerId = userIdFromRequest(req)
  const gate = allowGuestAsk(req, askerId)
  if (!gate.ok) {
    // 形状与开流前的其它错误一致：前端 api/ask.ts 的 readErrorMessage 读 content 字段
    res.status(gate.status).json({
      success: false,
      type: 'error',
      content: gate.message,
      error: { code: gate.code, message: gate.message }
    })
    return
  }

  /**
   * 本轮的上游控制权。
   *
   * 🔴 语义变更（2026-10-21）：**客户端断开不再中止上游**。
   *   以前这里直接 abort：用户刷新页面 / 关掉标签页 = 这一次问答白花额度且答案丢失，
   *   刷新回来只剩一个光秃秃的提问气泡。现在改成「客户端断开后服务端把这一轮跑完并落库」，
   *   前端刷新后从历史里把它捞回来（ChatView 的轮询 + 「回答还在生成中」提示）。
   *   真正要中止的场景只有「用户主动取消」（重新生成 / 删会话）→ 走 POST /api/ask/cancel。
   */
  const turn: InFlightTurn = {
    turnId: newTurnId(),
    conversationId: body.conversationId ?? '',
    controller: new AbortController(),
    discarded: false
  }
  /** 客户端是否已经断开（只用于判断「这一轮还有没有人听」，不再用来 abort 上游） */
  let clientGone = false
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

      /**
       * T5：user 消息在**问引擎之前**就落库。
       *
       * 为什么必须这么早：以前是「等引擎的响应头到了再落库」——
       * 引擎慢（首个 token 要十几秒）时，用户的提问在历史里迟迟不出现，
       * 中途切走/刷新回来看到的会话是**空的**，前端也判断不出「还有个回答在生成中」。
       * 现在问题先入库：历史里立刻能看到「我问了」，前端据此轮询等答案。
       *
       * ⚠️ 落库失败**绝不能**打断这一次问答：全部吞掉，最多 warn 一行。
       */
      try {
        await appendMessage({ conversationId: conv.id, role: 'user', content: body.query })
        conv.userMsgSaved = true
      } catch (err) {
        console.warn(`[ask] 用户消息落库失败（本轮问答不受影响）：${describeError(err)}`)
      }

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
    // 登记在途轮次：取消接口（POST /api/ask/cancel）靠它掐断这一轮
    // ⚠️ 按轮次登记：老轮次收尾时只清自己那条（见 finally），不会误删新一轮
    if (conv) {
      turn.conversationId = conv.id
      inFlightTurns.set(turn.turnId, turn)
      conversationTurns.set(conv.id, turn.turnId)
    }
    events = await askKnowledgeBase({
      sessionId,
      query: body.query,
      // ⚠️ T7（契约 C9）：不再透传检索范围，引擎侧一律用智能体自己配置的库
      signal: turn.controller.signal
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
    /**
     * 开流**前**就失败（引擎连不上 / 没配 key / 用户中途取消）：流还没开。
     *   - 失败 → 对外只给中文，历史里落一条「【问答失败】+中文提示」；
     *   - 取消 → 落一条「【已取消】」，别在历史里留一个永远没有回答的提问。
     * （user 消息在问引擎之前就落库了，这里补的是「结局」，不是重复。）
     */
    const pub = turn.discarded
      ? { code: 'ASK_CANCELLED', message: '本次提问已取消' }
      : publicEngineError(err)
    if (conv) {
      try {
        await appendMessage({
          conversationId: conv.id,
          role: 'assistant',
          content: `${turn.discarded ? STORED_CANCELLED_PREFIX : STORED_FAILED_PREFIX}${pub.message}`
        })
        const firstQuestion =
          conv.title === DEFAULT_TITLE ? body.query.replace(/\s+/g, ' ').trim().slice(0, 20) : ''
        await touchConversation({
          conversationId: conv.id,
          ...(firstQuestion ? { newTitle: firstQuestion } : {})
        })
      } catch (saveErr) {
        console.warn(`[ask] 开流前收尾落库失败：${describeError(saveErr)}`)
      }
    }
    if (turn.discarded) {
      // 用户主动取消：流还没开，回一帧 error（前端显示成「本次提问已取消」）
      res.status(200)
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.flushHeaders()
      writeSse(res, { type: 'error', content: pub.message, code: pub.code })
      res.end()
      return
    }
    sendPreStreamError(res, err)
    return
  }

  // 客户端断开只记个标记，**不**掐上游（理由见上面 turn 的注释）
  req.on('aborted', () => {
    clientGone = true
  })
  res.on('close', () => {
    clientGone = true
  })

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
  /** 本轮失败时给公众看的中文提示（落库 + error 帧都用它） */
  let failureText = ''
  /** T5：本轮拿到的来源卡片，收尾时与正文一起落库 */
  let collectedSources: AskSource[] = []

  /**
   * 收尾前补发来源卡片（每条流只发一次）。
   *
   * 放在 `done` **之前**：前端按事件顺序渲染，先给卡片再收尾，气泡不会「先结束、后冒卡片」。
   * 注意这发生在**全部正文流完之后**，所以不影响「逐字到达」的体验；
   * resolveCitationSources 内部已吞掉所有异常，这里再兜一层，绝不让它打断收尾。
   */
  const sendSources = async (): Promise<void> => {
    if (sourcesSent || turn.discarded) return
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
      // 用户主动取消 -> 停止消费（这一轮会被标记「已取消」，不落正文）
      if (turn.discarded) break
      // 终止信号：complete / stop / error（**不是 done**，见 weknora/types.ts 注释）
      if (isTerminalEvent(evt)) {
        if (evt.responseType === 'error') {
          // 失败的一轮：**不挂来源条**（正文没答出来，挂一堆「参考来源」是假引用）
          failed = true
          sourcesSent = true
          collectedSources = []
          const pub = classifyEngineText(evt.content || '') ?? {
            code: 'AI_UNAVAILABLE',
            message: 'AI 问答服务暂时不可用，请稍后再试'
          }
          failureText = pub.message
          writeSse(res, { type: 'error', content: pub.message, code: pub.code })
        } else {
          await sendSources()
          writeSse(res, { type: 'done', content: evt.content })
        }
        terminated = true
        break
      }
      if (evt.responseType === 'answer') {
        if (evt.content !== '') {
          answerText += evt.content
          // 🔴 引擎可能把报错当**正文**吐出来（lead 追加要求）：
          //    "Sorry, this answer hit the model's per-response output limit before any text was produced."
          //    一旦认出来，这轮就是失败 —— 英文那句**不写给前端、也不进历史**，
          //    改成一条中文失败提示（可重试）。
          const engineError = detectEngineErrorAnswer(answerText)
          if (engineError) {
            failed = true
            sourcesSent = true
            collectedSources = []
            failureText = engineError.message
            writeSse(res, { type: 'error', content: engineError.message, code: engineError.code })
            terminated = true
            break
          }
          writeSse(res, { type: 'answer', content: evt.content })
        }
        continue
      }
      /**
       * T7：智能体链路的「来源」。
       *
       * 引擎 `agent-chat` 的 references 事件**一条带全部引用**（不是分段推），
       * 且实测落在正文**之前**。weknora/agent-sse.ts 已把它翻译成 `{name, url, org, year…}`，
       * 这里转成前端既有的 `sources` 事件 —— **对前端的五种事件格式一个字都没改**
       * （第六章第 3 条），前端组件无需任何改动。
       *
       * 发完就把 sourcesSent 置位：后面的 sendSources() 会直接返回，
       * 不会出现「智能体给一次、引用解析再给一次」的双份卡片。
       */
      if (evt.responseType === 'references') {
        const items = readAgentSources(evt)
        if (items.length > 0 && !sourcesSent && !res.writableEnded) {
          sourcesSent = true
          collectedSources = items
          writeSse(res, { type: 'sources', items })
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
      // 其余类型（agent_query 入队确认 / session_title 等）不透给前端
    }
    // 上游没发终止帧就断了（异常收尾）：补一个 done，前端才知道流结束
    if (!terminated && !res.writableEnded && !turn.discarded) {
      await sendSources()
      writeSse(res, { type: 'done', content: '' })
    }
  } catch (err) {
    failed = true
    // 流已开始，只能以 SSE error 事件收尾（**对外只给中文**，不外泄内部 URL / request_id）
    //
    // 🔴 用户主动取消时，abort 抛出来的不是「引擎坏了」，别把内部错误透给用户：
    //    明确回一句「本次提问已取消」，前端据此显示已取消的提示。
    const pub = turn.discarded
      ? { code: 'ASK_CANCELLED', message: '本次提问已取消' }
      : publicEngineError(err)
    failureText = pub.message
    writeSse(res, { type: 'error', content: pub.message, code: pub.code })
  } finally {
    // 无答案口径只在这一处落库：正常收尾且正文为空 = 引擎没答上来（noAnswer=true）；
    // 有正文 = 有答案（false）；出错/中途断开 = 判不了（null，进 unjudged）
    //
    // 🔴 T11-B：userId 必须带上 —— 提问是服务端埋点，不带的话「使用明细」里
    //    每个账号的提问次数永远是 0（全部落进「游客」组）。游客仍是 null（不编造 id）。
    const finishedNormally = !failed && !turn.discarded
    recordEvent({
      event: 'ai_ask',
      userId: askerId,
      path: '/api/ask',
      payload: {
        query: body.query,
        noAnswer: finishedNormally ? answerText.trim() === '' : null,
        // 客户端中途断开（刷新/关页）：这一轮照样跑完并落库，前端刷新后能捞回来
        clientDisconnected: clientGone
      }
    })

    // T5：助手回复落库 + 会话置顶。
    //
    // ⚠️ 在 `finally` 里：**一定要在 res.end() 之前**。res.end() 一执行，
    //    本次请求的生命周期就结束了，后面再 await 落库属于「响应已发还在写」，
    //    客户端断开时这段 await 会被打断，历史里就少这一条。
    //
    // 🔴 2026-10-21：三种结局都要留痕（以前只有「有正文」才写 → 失败/库内没有刷新后是空白）：
    //   - 正常有正文 → 写正文 + 来源卡片
    //   - 失败（引擎报错 / 引擎把报错当正文）→ 写「【问答失败】+ 中文提示」，**不挂来源**
    //   - 正常收尾但库里没有 → 写「【库内暂无】」标记（前端还原成「库内暂未收录」）
    //   - 用户主动取消 → 写「【已取消】」（别在历史里留一个永远没有回答的提问）
    if (conv) {
      try {
        if (turn.discarded) {
          await appendMessage({
            conversationId: conv.id,
            role: 'assistant',
            content: `${STORED_CANCELLED_PREFIX}本次提问已取消`
          })
        } else if (failed) {
          await appendMessage({
            conversationId: conv.id,
            role: 'assistant',
            content: `${STORED_FAILED_PREFIX}${failureText || 'AI 问答服务暂时不可用，请稍后再试'}`
          })
        } else if (answerText.trim() === '') {
          await appendMessage({
            conversationId: conv.id,
            role: 'assistant',
            content: STORED_NO_ANSWER_PREFIX
          })
        } else {
          await appendMessage({
            conversationId: conv.id,
            role: 'assistant',
            content: answerText,
            sources: collectedSources
          })
        }
        // 标题还是默认的 -> 用首问改标题（**失败/取消也一样**），
        // 否则列表里全是「新对话」，用户根本分不清哪个是自己刚聊的那个
        const firstQuestion =
          conv.title === DEFAULT_TITLE
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
    // 收尾只清**自己**这一条：老轮次的 finally 绝不能把新一轮的登记删掉
    // （这正是「停止生成」取消不生效的根因，见文件头注释）
    inFlightTurns.delete(turn.turnId)
    if (conv && conversationTurns.get(conv.id) === turn.turnId) {
      conversationTurns.delete(conv.id)
    }

    try {
      res.end()
    } catch {
      // 客户端早走了：结束响应失败也不影响已经落库的历史
    }
  }
}

export default router

