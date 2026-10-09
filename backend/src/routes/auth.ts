/**
 * 用户接口 —— 负责人：月月（B02 用户板块）
 *
 * 提供的接口（字段名照 docs/接口约定.md）：
 *   POST /api/auth/register   注册（五字段：姓名/机构/职业/关注议题/电话 + 密码）
 *   POST /api/auth/login      登录，返回 { token }
 *   GET  /api/auth/me         当前用户（需带 Authorization: Bearer <token>）
 *
 * 实现：
 *   - 数据库：SQLite + Prisma（User 模型见 backend/prisma/schema.prisma）
 *   - 密码：bcryptjs 哈希存储（bcrypt 算法的纯 JS 实现），绝不存明文
 *   - 登录态：JWT，30 天有效期；密钥读 backend/.env 的 JWT_SECRET，不进代码
 *   - 凭证两条通路：Authorization: Bearer <token> 优先，cookie zwp_token 兜底
 *     （云端反向代理可能剥掉请求头；cookie 由浏览器自动带，不依赖请求头透传）
 *   - topics 在 SQLite 中存为 JSON 数组字符串（SQLite 无原生数组类型）
 *
 * 注意：只改本文件，不动 docs.ts / embed.ts。
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

const router = Router()
const prisma = new PrismaClient()

/** bcrypt 加盐轮数（10 为通用安全默认值） */
const BCRYPT_ROUNDS = 10
/** JWT 有效期：30 天（刷新浏览器/重开浏览器登录态不掉） */
const JWT_EXPIRES_IN = '30d'
/** cookie 里的凭证名（与前端无关，前端仍走 localStorage，这里只是给 header 走不通时兜底） */
const AUTH_COOKIE_NAME = 'zwp_token'
/** cookie 有效期，与 JWT_EXPIRES_IN 对齐（毫秒） */
const AUTH_COOKIE_MAX_AGE = 30 * 24 * 3600 * 1000
/** 大陆手机号：1 开头、第二位 3-9、共 11 位 */
const PHONE_RE = /^1[3-9]\d{9}$/
/** 密码长度按《接口约定》：8–72 位（bcrypt 上限 72 字节） */
const PASSWORD_MIN = 8
const PASSWORD_MAX = 72

/** JWT 密钥：只从环境变量读，未配置或过短直接给出明确错误（铁律：密钥不进代码） */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 16) {
    throw new Error('JWT_SECRET 未配置或太短：请在 backend/.env 里设置一个随机长字符串（至少 16 位）')
  }
  return secret
}

/** 统一错误响应格式（前端 http.ts 统一读取 error.message 弹提示）
 *  code：仅供运维定位用的机器可读标记（如 AUTH_NO_TOKEN / AUTH_BAD_TOKEN），
 *  message 面向用户，不要往里塞内部细节。 */
function fail(res: Response, status: number, message: string, code?: string): void {
  res.status(status).json({ error: { message, ...(code ? { code } : {}) } })
}

/** 注册入参（接口字段名照契约，不许别名） */
interface RegisterInput {
  name: string
  org: string
  occupation: string
  topics: string[]
  phone: string
  password: string
}

/** 校验注册入参：返回干净数据或逐条错误说明 */
function validateRegister(body: unknown): { data: RegisterInput | null; errors: string[] } {
  const errors: string[] = []
  const b = (body ?? {}) as Record<string, unknown>

  const name = typeof b.name === 'string' ? b.name.trim() : ''
  const org = typeof b.org === 'string' ? b.org.trim() : ''
  const occupation = typeof b.occupation === 'string' ? b.occupation.trim() : ''
  const phone = typeof b.phone === 'string' ? b.phone.trim() : ''
  const password = typeof b.password === 'string' ? b.password : ''

  // topics：契约要求数组（可多选）；容错接受单个字符串
  let topics: string[] = []
  if (Array.isArray(b.topics)) {
    topics = b.topics
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  } else if (typeof b.topics === 'string' && b.topics.trim().length > 0) {
    topics = [b.topics.trim()]
  }

  if (!name) errors.push('姓名不能为空')
  if (!org) errors.push('机构不能为空')
  if (!occupation) errors.push('职业不能为空')
  if (topics.length === 0) errors.push('关注议题至少选择一项')
  if (!phone) {
    errors.push('电话不能为空')
  } else if (!PHONE_RE.test(phone)) {
    errors.push('手机号格式不正确（应为 1 开头的 11 位数字）')
  }
  if (!password) {
    errors.push('密码不能为空')
  } else if (password.length < PASSWORD_MIN) {
    errors.push(`密码太短，至少 ${PASSWORD_MIN} 位`)
  } else if (password.length > PASSWORD_MAX) {
    errors.push(`密码太长，最多 ${PASSWORD_MAX} 位`)
  }

  if (errors.length > 0) return { data: null, errors }
  return { data: { name, org, occupation, topics, phone, password }, errors: [] }
}

/** 数据库行 → 返回给前端的用户对象（剔除 passwordHash；topics 还原为数组） */
interface UserRow {
  id: string
  name: string
  org: string
  occupation: string
  topics: string
  phone: string
}

function publicUser(u: UserRow): { id: string; name: string; org: string; occupation: string; topics: string[]; phone: string } {
  let topics: string[] = []
  try {
    const parsed: unknown = JSON.parse(u.topics)
    if (Array.isArray(parsed)) {
      topics = parsed.filter((t): t is string => typeof t === 'string')
    }
  } catch {
    topics = []
  }
  return { id: u.id, name: u.name, org: u.org, occupation: u.occupation, topics, phone: u.phone }
}

/** 取凭证的结果：拿到字符串 / 没拿到（区分两种失败原因） */
type TokenResult = { ok: true; token: string } | { ok: false; code: 'AUTH_NO_TOKEN' | 'AUTH_BAD_TOKEN' }

/** 手动解析 cookie 请求头，取出 zwp_token。
 *  不引 cookie-parser（硬约束：不许加依赖），按 ';' 切分后手工 decode。 */
function tokenFromCookieHeader(req: Request): string {
  const raw = req.headers.cookie
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (name !== AUTH_COOKIE_NAME) continue
    const value = part.slice(eq + 1).trim()
    if (!value) continue
    try {
      return decodeURIComponent(value)
    } catch {
      return value // 值不是合法百分号编码时按原样用，交给 jwt.verify 去判无效
    }
  }
  return ''
}

/** 取 JWT 凭证：请求头优先，cookie 兜底（云端反向代理可能剥掉 Authorization 头）。
 *  只负责「取到字符串」，不校验签名；签名校验在 userIdFromRequest。 */
function tokenFromRequest(req: Request): TokenResult {
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim()
    if (token) return { ok: true, token }
  }
  const cookieToken = tokenFromCookieHeader(req)
  if (cookieToken) return { ok: true, token: cookieToken }
  return { ok: false, code: 'AUTH_NO_TOKEN' }
}

/** 解析请求里的登录凭证并校验 → 用户 id。
 *  凭证两条通路：Authorization: Bearer <token> 优先，cookie zwp_token 兜底
 *  （云端反向代理可能剥掉 Authorization 头，cookie 由同源浏览器自动带上）。
 *  失败时带 code：没带凭证 = AUTH_NO_TOKEN，带了但验签不过 = AUTH_BAD_TOKEN。 */
function userIdFromRequest(
  req: Request
): { ok: true; userId: string } | { ok: false; code: 'AUTH_NO_TOKEN' | 'AUTH_BAD_TOKEN' } {
  const got = tokenFromRequest(req)
  if (!got.ok) return got
  try {
    const payload = jwt.verify(got.token, getJwtSecret())
    if (typeof payload === 'object' && payload !== null && typeof payload.sub === 'string') {
      return { ok: true, userId: payload.sub }
    }
    return { ok: false, code: 'AUTH_BAD_TOKEN' }
  } catch {
    return { ok: false, code: 'AUTH_BAD_TOKEN' }
  }
}

/** 登录态 cookie：与返回给前端的 token 同一个值。
 *  httpOnly 让 JS 读不到（防 XSS 盗用），sameSite=lax 防跨站带上，
 *  云端若前端与后端同域，浏览器会在 /auth/me 时自动带上这条 cookie，
 *  这样即使反向代理剥掉了 Authorization 头，登录态也还在。 */
function setAuthCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: AUTH_COOKIE_MAX_AGE,
    path: '/'
  })
}

/** Prisma 唯一约束冲突（并发下同手机号同时注册） */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002'
}

// —— POST /api/auth/register：注册（成功 201）——
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, errors } = validateRegister(req.body)
    if (!data) {
      fail(res, 400, `注册信息有误：${errors.join('；')}`)
      return
    }

    // 同一手机号不能注册两次（先查 + 依赖数据库唯一约束双保险）
    const existing = await prisma.user.findUnique({ where: { phone: data.phone } })
    if (existing) {
      fail(res, 409, '该手机号已注册过，请直接登录')
      return
    }

    // 密码哈希存储，绝不落明文
    const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS)
    const user = await prisma.user.create({
      data: {
        name: data.name,
        org: data.org,
        occupation: data.occupation,
        topics: JSON.stringify(data.topics),
        phone: data.phone,
        passwordHash
      }
    })

    // 登录态 cookie（第二条通路，见 setAuthCookie 注释）。
    // 响应体仍按接口约定只回 { user }，不额外塞 token，避免改动契约字段。
    setAuthCookie(res, jwt.sign({}, getJwtSecret(), { subject: user.id, expiresIn: JWT_EXPIRES_IN }))

    res.status(201).json({ user: publicUser(user) })
  } catch (err) {
    if (isUniqueViolation(err)) {
      fail(res, 409, '该手机号已注册过，请直接登录')
      return
    }
    next(err)
  }
})

// —— POST /api/auth/login：登录，返回 { token } ——
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>
    const phone = typeof b.phone === 'string' ? b.phone.trim() : ''
    const password = typeof b.password === 'string' ? b.password : ''

    if (!phone || !password) {
      fail(res, 400, '请输入手机号和密码')
      return
    }

    const user = await prisma.user.findUnique({ where: { phone } })
    // 手机号不存在与密码错误统一提示，避免向外部泄露"谁注册过"
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      fail(res, 401, '手机号或密码不正确')
      return
    }

    const token = jwt.sign({}, getJwtSecret(), { subject: user.id, expiresIn: JWT_EXPIRES_IN })
    setAuthCookie(res, token)
    res.json({ token })
  } catch (err) {
    next(err)
  }
})

// —— GET /api/auth/me：当前登录用户（需带 token：请求头或 cookie 任一即可）——
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = userIdFromRequest(req)
    if (!auth.ok) {
      // 两种 401 用 code 区分，方便运维一眼看出是「没带凭证」还是「凭证验不过」
      // （云端反向代理剥 Authorization 头 → AUTH_NO_TOKEN；多实例密钥不一致 → AUTH_BAD_TOKEN）
      fail(res, 401, '未登录或登录已过期', auth.code)
      return
    }
    const user = await prisma.user.findUnique({ where: { id: auth.userId } })
    if (!user) {
      fail(res, 401, '登录用户不存在')
      return
    }
    res.json(publicUser(user))
  } catch (err) {
    next(err)
  }
})

// —— 路由级错误兜底：任何异常都以 JSON 返回，不让前端收到 HTML 错误页 ——
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : '服务器内部错误'
  res.status(500).json({ error: { message } })
})

export default router
