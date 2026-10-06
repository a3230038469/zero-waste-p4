/**
 * 问答凭证接口 —— 负责人：韶茹
 *
 * 本文件要提供的接口（详见 docs/接口约定.md）：
 *   POST /api/embed/token   前端来要临时钥匙
 *                           → 校验来源合法 → 调引擎换 30 分钟临时钥匙 → 返回
 *
 * 开关：REQUIRE_LOGIN_FOR_ASK（默认 false = 访客免登录可问）
 * 注意：长期凭证只放 .env，绝不返回给前端
 */
import { Router } from 'express'

const router = Router()

// TODO(韶茹): 实现 token 交换

export default router
