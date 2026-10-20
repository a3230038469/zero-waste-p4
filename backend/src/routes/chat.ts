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
 * ⚠️ 鉴权：演示阶段**故意不加**，保持开放，任何人建任何人的会话。
 *    交付前若要按用户隔离，在这里挂 userId 即可（改动点见下面 TODO 注释三处）——
 *    现在就把 userId 塞进 Conversation 模型也不合适：注册模块是别人的文件，
 *    且演示期根本没走登录。先把「一条会话 = 一段对话」这件事做干净。
 */
import { Router, type Request, type Response, type NextFunction } from 'express'

import {
  ConversationNotFoundError,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  setEngineSessionId,
  summarize,
  type ConversationSummary
} from '../chat/store.js'
import { EngineError, createAskSession } from '../weknora/index.js'

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

    // 先落库再连引擎：库里的会话是主数据，引擎只是它的「脑子」
    const created = await createConversation(title)
    const engineSessionId = await tryCreateEngineSession(created.title)
    if (engineSessionId) {
      await setEngineSessionId(created.id, engineSessionId)
    }

    // TODO(交付前按用户隔离)：给 Conversation 加 userId，这里从 req 取登录态写入
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
router.get('/conversations', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await listConversations()
    // TODO(交付前按用户隔离)：where: { userId }
    res.json({ success: true, items })
  } catch (err) {
    next(err)
  }
})

// —— GET /conversations/:id/messages：会话全部消息（前端恢复画面）——
router.get(
  '/conversations/:id/messages',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id ?? '')
      const conversation = await summarize(id)
      const messages = await listMessages(id)
      // TODO(交付前按用户隔离)：校验这条会话是不是当前用户的，不是就 403
      res.json({ success: true, conversation, messages })
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        fail(res, 404, 'CONVERSATION_NOT_FOUND', '这个对话不存在或已被删除')
        return
      }
      next(err)
    }
  }
)

// —— DELETE /conversations/:id：删会话（连带删消息）——
router.delete('/conversations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id ?? '')
    // 先确认存在：删一个不存在的会话回 404，前端才能区分「删掉了」和「本来就坏的」
    await getConversation(id)
    // TODO(交付前按用户隔离)：校验归属后再删
    await deleteConversation(id)
    // 引擎侧 session 不主动删 —— 它自己会过期，留着比调接口删更稳
    res.json({ success: true })
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      fail(res, 404, 'CONVERSATION_NOT_FOUND', '这个对话不存在或已被删除')
      return
    }
    next(err)
  }
})

// —— 路由级兜底：异常一律 JSON，不让前端收到 HTML 错误页 ——
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : '服务器内部错误'
  res.status(500).json({ success: false, error: { code: 'CHAT_INTERNAL_ERROR', message } })
})

export default router
