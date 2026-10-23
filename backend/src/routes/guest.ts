/**
 * 游客权限 · 公开只读接口 —— T11（2026-10-14 新增）
 *
 *   GET /api/guest/permissions   读当前开关值（**不需要管理员身份**）
 *   GET /api/guest/ask-usage     读今日剩余提问次数（契约 C4，2026-10-21 新增）
 *
 * 为什么需要这条「公开」接口：
 *   设置页（老师后台）走 GET /api/admin/guest-permissions（要管理员账号登录态），
 *   但**公众页面也要按开关置灰**（详情页的预览/下载/分享、页脚的意见反馈）。
 *   公众页面本来就不该带任何管理凭证，所以另开一条只读的口径。
 *
 * ⚠️ 这里只返回开关本身与次数，没有任何密钥、口令、用户数据 —— 公开是安全的。
 * 🔴 前端置灰只是体验；真正的拦截在后端（routes/ask.ts / docs.ts / track.ts）。
 *    绕过前端直接调接口，后端照样按同一份配置拒绝。
 */
import { Router, type Request, type Response } from 'express'

import { countGuestAsk } from '../guest/ask-usage.js'
import { guestPermissionsPayload, loadGuestPermissionsWithState } from '../guest/permissions.js'
import { errorEnvelope } from '../errors/types.js'

const router = Router()

/** GET /api/guest/permissions —— 开关清单 + 当前值（前端拿来决定要不要置灰按钮） */
router.get('/permissions', (_req: Request, res: Response) => {
  const state = loadGuestPermissionsWithState()
  if (state.source === 'fallback') {
    // 配置文件坏了：已降级为「全部关闭」的安全默认，并写了服务端日志。
    // 公开口径里带上 degraded，前端/验收能看出「这不是管理员设的真实值」。
    console.error(`[guest] 游客权限配置不可用（已降级为全部关闭）：${state.error ?? '未知原因'}`)
  }
  res.json(guestPermissionsPayload(state.permissions, { source: state.source }))
})

/**
 * GET /api/guest/ask-usage —— 今日剩余提问次数（契约 C4）
 * 公开只读，返回 { limit, used, remaining }：
 *   limit     今日允许的提问次数（管理员设的开关值）
 *   used      今天已经用掉的次数
 *   remaining 还剩几次（不会变成负数）
 */
router.get('/ask-usage', (req: Request, res: Response) => {
  try {
    const permissions = loadGuestPermissionsWithState().permissions
    const limit = permissions.aiAsk ? permissions.aiAskDailyLimit : 0
    const used = countGuestAsk(req)
    const remaining = Math.max(0, limit - used)
    res.json({ limit, used, remaining })
  } catch (err) {
    const detail = err instanceof Error ? err.message : '未知错误'
    console.error(`[guest] 读游客提问次数失败：${detail}`)
    res.status(500).json(errorEnvelope('INTERNAL_ERROR', '提问次数暂时读不出来，请稍后重试', req))
  }
})

export default router