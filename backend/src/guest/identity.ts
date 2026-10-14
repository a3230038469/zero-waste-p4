/**
 * 登录态判定 —— T11 游客权限（2026-10-14 新增）
 *
 * 为什么单独一个文件：`routes/ask.ts`（韶茹）、`routes/docs.ts`（韶茹）、
 * `routes/contributions.ts`（B09）、`routes/track.ts`（韶茹）都要判「这个人是不是游客」，
 * 而三处都**不能改**（分工纪律：只动自己的文件）。所以这里自带一份与
 * `routes/contributions.ts` **同口径**的判定：
 *
 *   Authorization: Bearer <token> 优先 → cookie `zwp_token` 兜底 → JWT 校验 → 取 sub
 *
 * 🔴 与 `routes/contributions.ts` 的注释同一处坑：JWT 校验用 `JWT_SECRET`，
 *    没配或短于 16 位就抛错。这里**吞掉这个错误并按「未登录」处理**（fail closed）——
 *    游客权限是「关」的判定，判不出登录态时必须当游客，绝不能反过来放行。
 */
import type { Request } from 'express'
import jwt from 'jsonwebtoken'

/** 管理 cookie 里的凭证名（与 routes/auth.ts 保持一致） */
const AUTH_COOKIE_NAME = 'zwp_token'

/** 从 cookie 请求头里取 zwp_token（不引 cookie-parser，与 auth.ts 同样手工解析） */
function tokenFromCookieHeader(req: Request): string {
  const raw = req.headers.cookie
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== AUTH_COOKIE_NAME) continue
    const value = part.slice(eq + 1).trim()
    if (!value) continue
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return ''
}

/** 取 JWT 密钥；没配或太短返回 null（调用方按「未登录」处理） */
function jwtSecret(): string | null {
  const secret = (process.env.JWT_SECRET ?? '').trim()
  return secret.length >= 16 ? secret : null
}

/** 从请求里解析登录用户 id；未登录 / 凭证无效一律 null（= 游客） */
export function userIdFromRequest(req: Request): string | null {
  const header = req.headers.authorization ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  const token = bearer || tokenFromCookieHeader(req)
  if (!token) return null
  const secret = jwtSecret()
  if (!secret) return null
  try {
    const payload: unknown = jwt.verify(token, secret)
    if (typeof payload === 'object' && payload !== null) {
      const sub = (payload as { sub?: unknown }).sub
      if (typeof sub === 'string' && sub) return sub
    }
    return null
  } catch {
    return null
  }
}

/** 是不是登录用户（判游客时统一走这里，避免各处自己写一套） */
export function isLoggedIn(req: Request): boolean {
  return userIdFromRequest(req) !== null
}