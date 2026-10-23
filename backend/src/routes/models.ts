/**
 * 管理台「模型管理」接口 —— 2026-10-22 新增
 *
 *   GET    /api/admin/models              列表（按类型分组所需字段 + 厂商目录 + 在用标记）
 *   POST   /api/admin/models              新建（对话 / 视觉 / 重排）
 *   PUT    /api/admin/models/:id          改展示名 / 地址
 *   PUT    /api/admin/models/:id/key      只换 API Key
 *   POST   /api/admin/models/:id/test     模型测试（真发一句话，会消耗一次厂商额度）
 *   DELETE /api/admin/models/:id          删除（在用 / 内置 / 向量模型一律拒绝）
 *
 * 全部要求管理员身份；引擎的 API Key 只在服务端使用，任何响应都不回显密钥。
 * 契约见 docs/接口约定.md 第三节「模型管理」。
 */
import { Router, type Request, type Response } from 'express'

import { requireAdminGuard } from '../admin/guard.js'
import { errorEnvelope } from '../errors/types.js'
import { EngineError } from '../weknora/types.js'
import {
  createEngineModel,
  deleteEngineModel,
  getModelAdminView,
  testEngineModel,
  updateEngineModel,
  updateEngineModelKey
} from '../weknora/model-admin.js'

const router = Router()

/** 统一的失败出口：引擎错误按它自己的状态码回，其余一律 500（内部细节只进日志） */
function fail(res: Response, err: unknown, req: Request, fallback: string): void {
  if (err instanceof EngineError) {
    res.status(err.status).json({ success: false, error: { code: err.code, message: err.message } })
    return
  }
  console.error(`[models] ${fallback}：`, err instanceof Error ? err.stack ?? err.message : err)
  res.status(500).json(errorEnvelope('MODEL_ADMIN_FAILED', fallback, req))
}

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body as unknown
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}

function strField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value : ''
}

function numField(body: Record<string, unknown>, key: string): number {
  const value = body[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** GET /api/admin/models */
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireAdminGuard(req, res))) return
    const view = await getModelAdminView()
    res.json({ success: true, ...view })
  } catch (err) {
    fail(res, err, req, '模型列表读取失败，请稍后再试')
  }
})

/** POST /api/admin/models */
router.post('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireAdminGuard(req, res))) return
    const body = bodyOf(req)
    const id = await createEngineModel({
      group: strField(body, 'group'),
      name: strField(body, 'name'),
      displayName: strField(body, 'displayName'),
      provider: strField(body, 'provider'),
      baseUrl: strField(body, 'baseUrl'),
      apiKey: strField(body, 'apiKey'),
      contextWindow: numField(body, 'contextWindow')
    })
    res.status(201).json({ success: true, id })
  } catch (err) {
    fail(res, err, req, '新建模型失败，请稍后再试')
  }
})

/** PUT /api/admin/models/:id */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await requireAdminGuard(req, res))) return
    const body = bodyOf(req)
    await updateEngineModel(req.params.id ?? '', {
      ...(typeof body['displayName'] === 'string' ? { displayName: body['displayName'] } : {}),
      ...(typeof body['baseUrl'] === 'string' ? { baseUrl: body['baseUrl'] } : {})
    })
    res.json({ success: true })
  } catch (err) {
    fail(res, err, req, '修改模型失败，请稍后再试')
  }
})

/** PUT /api/admin/models/:id/key */
router.put('/:id/key', async (req: Request, res: Response) => {
  try {
    if (!(await requireAdminGuard(req, res))) return
    await updateEngineModelKey(req.params.id ?? '', strField(bodyOf(req), 'apiKey'))
    res.json({ success: true })
  } catch (err) {
    fail(res, err, req, '更新密钥失败，请稍后再试')
  }
})

/** POST /api/admin/models/:id/test */
router.post('/:id/test', async (req: Request, res: Response) => {
  try {
    if (!(await requireAdminGuard(req, res))) return
    const result = await testEngineModel(req.params.id ?? '', strField(bodyOf(req), 'input'))
    res.json({ success: true, ...result })
  } catch (err) {
    fail(res, err, req, '模型测试失败，请稍后再试')
  }
})

/** DELETE /api/admin/models/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await requireAdminGuard(req, res))) return
    await deleteEngineModel(req.params.id ?? '')
    res.json({ success: true })
  } catch (err) {
    fail(res, err, req, '删除模型失败，请稍后再试')
  }
})

export default router
