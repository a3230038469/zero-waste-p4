/**
 * 用户接口 —— 负责人：月月
 *
 * 本文件要提供的接口（详见 docs/接口约定.md）：
 *   POST /api/auth/register   注册（五字段：姓名/机构/职业/关注议题/电话 + 密码）
 *   POST /api/auth/login      登录，返回 { token }
 *   GET  /api/auth/me         当前用户（需带 token）
 *
 * 要求：密码不可明文存；手机号唯一；登录态用 JWT（30 天）
 * 注意：只改本文件，不要动 docs.ts / embed.ts
 */
import { Router } from 'express'

const router = Router()

// TODO(月月): 实现上面 3 个接口

export default router
