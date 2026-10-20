/**
 * 游客权限 · 公开只读接口 —— T11（2026-10-14 新增）
 *
 *   GET /api/guest/permissions   读当前开关值（**不需要管理员身份**）
 *
 * 为什么需要这条「公开」接口：
 *   设置页（老师后台）走 GET /api/admin/guest-permissions（要管理员账号登录态），
 *   但**公众页面也要按开关置灰**（详情页的预览/下载/分享、页脚的意见反馈）。
 *   公众页面本来就不该带任何管理凭证，所以另开一条只读的口径。
 *
 * ⚠️ 这里只返回开关本身，没有任何密钥、口令、用户数据 —— 公开是安全的。
 * 🔴 前端置灰只是体验；真正的拦截在后端（routes/ask.ts / docs.ts / track.ts）。
 *    绕过前端直接调接口，后端照样按同一份配置拒绝。
 */
import { Router, type Request, type Response } from 'express'

import { guestPermissionsPayload } from '../guest/permissions.js'

const router = Router()

/** GET /api/guest/permissions —— 开关清单 + 当前值（前端拿来决定要不要置灰按钮） */
router.get('/permissions', (_req: Request, res: Response) => {
  try {
    res.json(guestPermissionsPayload())
  } catch (err) {
    // 配置读不出来时返回默认口径（loadGuestPermissions 本身已吞异常，
    // 这里兜的是 payload 组装这类意外）—— 宁可退回默认值，也不能让公众页面报错
    const detail = err instanceof Error ? err.message : '未知错误'
    console.error(`[guest] 读游客权限失败（已忽略，按默认值继续）：${detail}`)
    res.status(200).json(guestPermissionsPayload())
  }
})

export default router