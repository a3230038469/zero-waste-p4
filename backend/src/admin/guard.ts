/**
 * 管理台鉴权 —— 2026-10-19 从「共用口令」换成「管理员账号」
 *
 * 旧做法：请求头 `X-Admin-Token` = backend/.env 的 `ADMIN_STATS_TOKEN`。
 *   问题：口令全站共用一把、换浏览器就要重贴、谁改的查不到、也没法单独停某个人。
 * 新做法：认登录凭证（`Authorization: Bearer <JWT>`，cookie `zwp_token` 兜底，
 *   与 guest/identity.ts 同一口径），再查这个用户的 `role` 是不是 `admin`。
 *
 * 三点刻意设计：
 *   1. **角色每次都查库，不做缓存**：撤掉某人的管理员身份要立刻生效，
 *      不能等 30 天的 JWT 过期（本地 SQLite 一次查询的开销可以忽略）。
 *   2. **旧口令保留但默认停用**：万一管理员账号丢了，把
 *      `ADMIN_LEGACY_TOKEN_ENABLED=1` 写进 backend/.env 重启即可救急；
 *      平时它就是不存在的代码路径，不会因为「口令没配」把管理台整个关掉。
 *   3. **fail closed**：认不出身份 = 游客 = 拒绝，绝不反过来放行。
 */
import { PrismaClient } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'
import { userIdFromRequest } from '../guest/identity.js'

const prisma = new PrismaClient()

/** 旧口令兜底：只有显式打开开关才认（返回空串 = 这条路不通） */
function legacyToken(): string {
  const flag = (process.env.ADMIN_LEGACY_TOKEN_ENABLED ?? '').trim().toLowerCase()
  if (flag !== '1' && flag !== 'true') return ''
  const token = (process.env.ADMIN_STATS_TOKEN ?? '').trim()
  return token.length >= 8 ? token : ''
}

/** 这个用户是不是管理员（查库，不缓存） */
export async function isAdminUser(userId: string | null): Promise<boolean> {
  if (!userId) return false
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
  return user?.role === 'admin'
}

/** 当前请求的管理员 id；不是管理员返回 null */
export async function adminUserIdFromRequest(req: Request): Promise<string | null> {
  const userId = userIdFromRequest(req)
  if (await isAdminUser(userId)) return userId
  const legacy = legacyToken()
  if (legacy && String(req.header('X-Admin-Token') ?? '').trim() === legacy) return 'legacy-token'
  return null
}

/**
 * 管理接口的统一放行判断。
 * ⚠️ 是 **async**：所有调用点都必须 `await`（函数名从 assertAdmin 改到
 * requireAdminGuard 就是为了让漏改的调用点编译不过，而不是静默放行）。
 */
export async function requireAdminGuard(req: Request, res: Response): Promise<boolean> {
  const adminId = await adminUserIdFromRequest(req)
  if (adminId) return true
  const loggedIn = userIdFromRequest(req) !== null
  res.status(403).json({
    success: false,
    error: {
      code: loggedIn ? 'ADMIN_FORBIDDEN' : 'ADMIN_LOGIN_REQUIRED',
      message: loggedIn ? '当前账号不是管理员' : '请先用管理员账号登录'
    }
  })
  return false
}

/** 需要管理员的写操作中间件（express 版） */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (await requireAdminGuard(req, res)) next()
}
