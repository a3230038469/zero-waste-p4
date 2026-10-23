/**
 * 会话归属 —— T1 账号与会话安全（2026-10-21 新增）
 *
 * 修的是什么：会话接口（`/api/chat/*`）以前**零鉴权** ——
 *   任何人拿到别人的会话 id 就能读走全部问答内容，还能把别人的会话删掉
 *   （库里 31 条历史会话互相全可见）。这是 P0-3。
 *
 * 归属怎么定（契约 C1.1，2026-10-21 冻结）：
 *   - 已登录（Authorization: Bearer 或 cookie `zwp_token` 里的 JWT 验得过）→ 归属 = 该用户的 userId；
 *   - 匿名访客 → 归属 = 服务端随机生成、不可猜的令牌
 *     （请求头 `X-Chat-Owner` 或 httpOnly cookie `zwp_chat_owner`）。
 *
 * 库里存的是什么：`ownerId = 'u:' + userId` 或 `'t:' + 令牌`。
 *   **前缀是必须的**：用户 id 与匿名令牌分属两个命名空间，
 *   否则一个游客只要把请求头填成别人的 userId 就能进别人的会话。
 *
 * 匿名令牌怎么在浏览器里活下来（两条腿走路，互为兜底）：
 *   1. 响应头 `X-Chat-Owner`：前端收到就存 localStorage，下次原样带回（跨域部署也能用）；
 *   2. httpOnly cookie `zwp_chat_owner`：浏览器自动带（同一站点部署时用）。
 *   两条都拿不到时，服务端随机生成一枚并下发 —— 游客第一次访问也照样能建自己的会话。
 *
 * ⚠️ 令牌本身就是凭证（谁拿到谁就能看那些匿名会话），所以：
 *   - 只用 crypto.randomBytes 生成，不含时间戳、不含可猜前缀；
 *   - 格式校验严格（32 位十六进制），乱填的头一律当没有；
 *   - 登录用户**完全忽略**这个头：登录态的归属只看 JWT，匿名令牌碰不到用户会话。
 */
import { randomBytes } from 'node:crypto'
import type { Request, Response } from 'express'

import { ConversationNotFoundError, prisma } from './store.js'
import { userIdFromRequest } from '../guest/identity.js'

/** 匿名归属令牌的请求头名（前端带、响应头也用它下发） */
export const OWNER_HEADER = 'x-chat-owner'
/** 匿名归属令牌的 cookie 名（httpOnly，浏览器自动带） */
export const OWNER_COOKIE = 'zwp_chat_owner'

/** 匿名令牌格式：32 位十六进制（randomBytes(16).toString('hex')） */
const TOKEN_RE = /^[0-9a-f]{32}$/
/** cookie 有效期：与登录 cookie 对齐（30 天） */
const OWNER_COOKIE_MAX_AGE = 30 * 24 * 3600 * 1000

/** 当前请求的归属：登录用户按 userId，匿名访客按随机令牌 */
export type OwnerRef = { kind: 'user'; userId: string } | { kind: 'anon'; token: string }

/**
 * 越权（会话存在但不属于本人）—— 调用方据此回 403。
 * 与「不存在」（404）分开：契约要求越权一律 403，且**绝不返回任何内容**。
 */
export class ConversationForbiddenError extends Error {
  /** HTTP 状态码，调用方直接用 */
  readonly status = 403
  /** 错误码（前端/运维按 code 定位用） */
  readonly code = 'CONVERSATION_FORBIDDEN'

  constructor(id: string) {
    super(`无权访问这个对话：${id}`)
    this.name = 'ConversationForbiddenError'
  }
}

/** 会话不存在（404）—— 直接复用 store 里的那个，路由已经在捕它 */
export { ConversationNotFoundError }

/** 生成一枚新的匿名令牌（不可猜：16 字节随机数） */
function newToken(): string {
  return randomBytes(16).toString('hex')
}

/** 从 cookie 请求头里取某个 cookie 的值（不引 cookie-parser，与 auth.ts 同样手工解析） */
function cookieValue(req: Request, name: string): string {
  const raw = req.headers.cookie
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
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

/**
 * 读请求里带的匿名归属令牌：请求头优先，cookie 兜底。
 * 格式不对一律当没有（乱填的头不能变成一个命名空间）。
 */
function tokenFromRequest(req: Request): string {
  const header = req.headers[OWNER_HEADER]
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw === 'string') {
    const value = raw.trim()
    if (TOKEN_RE.test(value)) return value
  }
  const cookie = cookieValue(req, OWNER_COOKIE)
  return TOKEN_RE.test(cookie) ? cookie : ''
}

/**
 * 让浏览器能读到响应头 X-Chat-Owner。
 *
 * ⚠️ 跨域时（前端 dev server 与后端不同端口）浏览器默认**不暴露**自定义响应头，
 *    前端就读不到服务端下发的令牌 —— 这里补一个 Access-Control-Expose-Headers。
 *    已有值就往后追加，不覆盖别人设的头。
 */
function exposeOwnerHeader(res: Response): void {
  const prev = res.getHeader('Access-Control-Expose-Headers')
  const list = prev === undefined ? [] : String(prev).split(',').map((s) => s.trim()).filter(Boolean)
  if (!list.some((h) => h.toLowerCase() === 'x-chat-owner')) list.push('X-Chat-Owner')
  res.setHeader('Access-Control-Expose-Headers', list.join(', '))
}

/**
 * 解析当前请求的归属，并把匿名令牌下发回给浏览器（没有才生成）。
 *
 * @param req 请求
 * @param res 响应（用来下发 X-Chat-Owner 头与 zwp_chat_owner cookie）
 */
export function resolveOwner(req: Request, res: Response): OwnerRef {
  // 登录优先：登录用户的归属只看 JWT，请求头里的匿名令牌一概不认
  const userId = userIdFromRequest(req)
  if (userId) return { kind: 'user', userId }

  let token = tokenFromRequest(req)
  const fresh = token === ''
  if (fresh) token = newToken()

  // 下发：响应头给前端存 localStorage，httpOnly cookie 给浏览器自动带
  exposeOwnerHeader(res)
  res.setHeader('X-Chat-Owner', token)
  if (fresh || cookieValue(req, OWNER_COOKIE) !== token) {
    res.cookie(OWNER_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: OWNER_COOKIE_MAX_AGE
    })
  }

  return { kind: 'anon', token }
}

/** 归属在库里存的值：'u:'+userId / 't:'+令牌（两个命名空间，绝不撞车） */
export function ownerIdOf(owner: OwnerRef): string {
  return owner.kind === 'user' ? `u:${owner.userId}` : `t:${owner.token}`
}

/**
 * 校验「这个会话是不是本人的」。
 *
 * - 会话不存在 → 抛 ConversationNotFoundError（路由回 404）
 * - 会话存在但不属于本人 → 抛 ConversationForbiddenError（路由回 403）
 *
 * ⚠️ 加这个字段之前的历史会话 ownerId 为空，对谁都不属于 → 一律 403：
 *    「不泄露」优先于「还能看历史」。数据本身不删（那是数据治理任务的事）。
 */
export async function assertConversationOwner(id: string, owner: OwnerRef): Promise<void> {
  const row = await prisma.conversation.findUnique({
    where: { id },
    select: { ownerId: true }
  })
  if (!row) throw new ConversationNotFoundError(id)
  if (row.ownerId !== ownerIdOf(owner)) throw new ConversationForbiddenError(id)
}
