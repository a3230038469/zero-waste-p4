/**
 * 站点信息接口 —— 2026-10-19 新增
 *
 *   GET /api/site-info        公开只读：首页「合作与共建」与页脚要用的对外口径
 *   PUT /api/admin/site-info  管理员填写（管理台「机构信息」）
 *
 * 为什么把「公开读」和「管理写」放在一个文件：它们读写的是同一份白名单字段
 * （backend/src/site/info.ts），摆在一起才不会出现「前端能改的字段后端不认」。
 * 挂载见 src/index.ts；契约见 docs/接口约定.md 第三节。
 */
import { Router, type Request, type Response } from 'express'

import { requireAdminGuard } from '../admin/guard.js'
import { SITE_INFO_FIELDS, readSiteInfo, writeSiteInfo } from '../site/info.js'

/** 公开路由：GET /api/site-info */
export const siteInfoRouter = Router()

/** 管理路由：PUT /api/admin/site-info */
export const adminSiteInfoRouter = Router()

/** 给前端渲染表单用：字段名、中文标签、长度上限、填写提示（不含任何真实值） */
const FIELDS = SITE_INFO_FIELDS.map((f) => ({
  key: f.key,
  label: f.label,
  max: f.max,
  hint: f.hint
}))

/**
 * GET /api/site-info —— 公开。
 * 只吐这几个字段，**空的就返回空串**：前端据此决定显示真实值还是「待补充」，
 * 后端不替基金会编任何对外口径。
 */
siteInfoRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const info = await readSiteInfo()
    res.json({ success: true, info, fields: FIELDS })
  } catch (err) {
    // Express 4 不接 async 抛错：不自己兜住的话请求会挂住、不给响应
    console.error('[site] 读取站点信息失败', err)
    res.status(500).json({
      success: false,
      error: { code: 'SITE_INFO_FAILED', message: '读取站点信息失败，请稍后重试' }
    })
  }
})

/** PUT /api/admin/site-info —— 管理员。请求体：{ contact?, email?, address?, cooperation?, copyright? } */
adminSiteInfoRouter.put('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireAdminGuard(req, res))) return

    const result = await writeSiteInfo(req.body)
    if (!result.ok) {
      res.status(400).json({
        success: false,
        error: { code: result.code, message: result.message }
      })
      return
    }

    res.json({ success: true, info: result.info, changed: result.changed })
  } catch (err) {
    console.error('[site] 保存站点信息失败', err)
    res.status(500).json({
      success: false,
      error: { code: 'SITE_INFO_FAILED', message: '保存站点信息失败，请稍后重试' }
    })
  }
})
