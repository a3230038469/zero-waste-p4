/**
 * 健康检查 —— 不归任何人，地基自带
 * GET /health  →  {"ok":true}
 */
import { Router } from 'express'

const router = Router()

router.get('/', (_req, res) => {
  res.json({ ok: true })
})

export default router
