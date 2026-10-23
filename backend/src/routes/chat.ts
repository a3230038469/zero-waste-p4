/**
 * 会话接口（T5 · 独立问答页）—— 负责人：韶茹
 *
 *   POST   /api/chat/conversations             建会话（顺带在引擎建 session 并记下 id）
 *   GET    /api/chat/conversations             会话列表（最近活动倒序 + 摘要 + 条数）
 *   GET    /api/chat/conversations/:id/messages  该会话全部消息（刷新页面靠它恢复画面）
 *   DELETE /api/chat/conversations/:id         删会话（连带删消息）
 *
 * 契约见 docs/接口约定.md 第二节「会话（T5）」。
 *
 * ✅ 鉴权（2026-10-21 · T1 账号与会话安全补上，P0-3）：
 *    四个接口全部按**会话归属**校验，越权一律 403 且不返回任何内容。
 *    归属怎么算在 ../chat/owner.ts（登录按 userId，匿名按服务端随机令牌）。
 *    原来这里没做归属校验，任何人拿到会话 id 就能读走/删掉别人的会话。
 */
import { Router, type Request, type Response, type NextFunction } from 'express'

import {
  ConversationNotFoundError,
  createConversation,
  deleteConversation,
  listConversations,
  listMessages,
  setEngineSessionId,
  summarize,
  type ConversationSummary
} from '../chat/store.js'
import { EngineError, createAskSession } from '../weknora/index.js'
import {
  ConversationForbiddenError,
  assertConversationOwner,
  ownerIdOf,
  resolveOwner
} from '../chat/owner.js'

const router = Router()

/** 统一错误信封（与 middleware/error.ts 一致，前端 http.ts 只读 error.message） */
function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } })
}

/**
 * 建引擎会话。
 *
 * ⚠️ 引擎这一层**可能失败**：密钥未到位、演示快照模式、当日额度 429。
 *    建不出引擎会话不等于「不能建对话」—— 对话照样存进库，engineSessionId 留空，
 *    等到第一次真正提问时再懒建（见 ask.ts）。这样列表/删除/历史恢复这些功能
 *    不会被引擎的抖动一起拖下水，演示时也不会出现「新建会话直接报错」。
 *
 * @returns 引擎会话 id；建不出时返回 null（不是抛错）
 */
async function tryCreateEngineSession(title: string): Promise<string | null> {
  try {
    return await createAskSession(title)
  } catch (err) {
    const reason = err instanceof EngineError ? err.message : '引擎暂不可用'
    console.warn(`[chat] 引擎会话未建立，改为提问时懒建：${reason}`)
    return null
  }
}

// —— POST /conversations：建会话（201）——
router.post('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const title = typeof body.title === 'string' ? body.title : ''

    // 归属先定下来：这条会话从创建这一刻就属于某个人/某个匿名访客
    const owner = resolveOwner(req, res)

    // 先落库再连引擎：库里的会话是主数据，引擎只是它的「脑子」
    const created = await createConversation(ownerIdOf(owner), title)
    const engineSessionId = await tryCreateEngineSession(created.title)
    if (engineSessionId) {
      await setEngineSessionId(created.id, engineSessionId)
    }

    const conversation: ConversationSummary = {
      ...created,
      engineReady: engineSessionId !== null
    }
    res.status(201).json({ success: true, conversation })
  } catch (err) {
    next(err)
  }
})

// —— GET /conversations：会话列表 ——
router.get('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 只列本人（登录用户 or 本机匿名令牌）的会话
    const owner = resolveOwner(req, res)
    const items = await listConversations(ownerIdOf(owner))
    res.json({ success: true, items })
  } catch (err) {
    next(err)
  }
})

// —— GET /conversations/:id/messages：会话全部消息（前端恢复画面）——
router.get('/conversations/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id ?? '')
    // 先校验归属：不是本人的会话直接 403，一个字都不回
    const owner = resolveOwner(req, res)
    await assertConversationOwner(id, owner)
    const conversation = await summarize(id)
    const messages = await listMessages(id)
    res.json({ success: true, conversation, messages })
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      fail(res, 404, 'CONVERSATION_NOT_FOUND', '这个对话不存在或已被删除')
      return
    }
    if (err instanceof ConversationForbiddenError) {
      fail(res, 403, 'CONVERSATION_FORBIDDEN', '无权访问这个对话')
      return
    }
    next(err)
  }
})

// —— DELETE /conversations/:id：删会话（连带删消息）——
router.delete('/conversations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id ?? '')
    // 先校验归属：不是本人的会话直接 403，不碰它一根毫毛
    // （不存在仍然回 404，前端才能区分「删掉了」和「本来就坏的」）
    const owner = resolveOwner(req, res)
    await assertConversationOwner(id, owner)
    await deleteConversation(id)
    // 引擎侧 session 不主动删 —— 它自己会过期，留着比调接口删更稳
    res.json({ success: true })
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      fail(res, 404, 'CONVERSATION_NOT_FOUND', '这个对话不存在或已被删除')
      return
    }
    if (err instanceof ConversationForbiddenError) {
      fail(res, 403, 'CONVERSATION_FORBIDDEN', '无权访问这个对话')
      return
    }
    next(err)
  }
})

// —— 路由级兜底：异常一律 JSON，不让前端收到 HTML 错误页 ——
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : '服务器内部错误'
  console.error(`[chat] 内部错误: ${message}, requestId: ${_req.requestId || 'unknown'}`)
  res.status(500).json({ success: false, error: { code: 'CHAT_INTERNAL_ERROR', message: '聊天服务暂时不可用，请稍后再试' } })
})

export default router