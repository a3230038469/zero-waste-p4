/**
 * 用户接口 —— 负责人：月月（B02 用户板块）
 *
 * 提供的接口（字段名照 docs/接口约定.md）：
 *   POST  /api/auth/register   注册（五字段：姓名/机构/职业/关注议题/电话 + 密码）
 *   POST  /api/auth/login      登录，返回 { token }
 *   POST  /api/auth/logout     退出登录（2026-10-21 新增）：清掉 zwp_token 登录 cookie
 *                              —— 只清前端 localStorage 不够，cookie 还在就仍算「已登录」
 *   GET   /api/auth/me         当前用户（需带 Authorization: Bearer <token>）
 *   PATCH /api/auth/me         修改当前用户的资料（2026-10-19 新增，配合导航栏账号菜单）
 *                              —— 只接受请求里出现的字段：姓名/机构/职业/关注议题/电话；
 *                              手机号是登录凭证，改了就用新号登录（要求格式合法且没被别人占用）。
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

/** 资料字段长度上限（PATCH /me 用）：防止把超长字符串塞进库里
 *  —— 发布机构那一栏最长见过 118 个字，所以机构上限给得比姓名宽。 */
const NAME_MAX = 40
const ORG_MAX = 120
const OCCUPATION_MAX = 40
/** 关注议题：最多 20 项、每项最多 20 字（注册页允许手动输入自定义议题） */
const TOPICS_MAX = 20
const TOPIC_ITEM_MAX = 20

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
  // 2026-10-23：补 success:false 与 code，和全站错误信封一致；
  // 前端仍从 error.message 读取，兼容旧调用方。
  res.status(status).json({
    success: false,
    error: { code: code ?? 'AUTH_FAILED', message }
  })
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

/** 修改资料的入参：**只包含请求里真正出现的字段**（部分更新） */
interface ProfilePatch {
  name?: string
  org?: string
  occupation?: string
  topics?: string[]
  phone?: string
}

/**
 * 校验「修改资料」入参（PATCH /me）。
 * 与注册不同：这里允许只提交要改的那几项，所以判空只在字段**出现**时做；
 * 一个字段都没出现 = 空更新，直接拒（避免误发一个空 body 也返回 200）。
 */
function validateProfilePatch(body: unknown): { data: ProfilePatch | null; errors: string[] } {
  const errors: string[] = []
  const b = (body ?? {}) as Record<string, unknown>
  const data: ProfilePatch = {}

  if ('name' in b) {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) errors.push('姓名不能为空')
    else if (name.length > NAME_MAX) errors.push(`姓名最多 ${NAME_MAX} 个字`)
    else data.name = name
  }

  if ('org' in b) {
    const org = typeof b.org === 'string' ? b.org.trim() : ''
    if (!org) errors.push('机构不能为空')
    else if (org.length > ORG_MAX) errors.push(`机构最多 ${ORG_MAX} 个字`)
    else data.org = org
  }

  if ('occupation' in b) {
    const occupation = typeof b.occupation === 'string' ? b.occupation.trim() : ''
    if (!occupation) errors.push('职业不能为空')
    else if (occupation.length > OCCUPATION_MAX) errors.push(`职业最多 ${OCCUPATION_MAX} 个字`)
    else data.occupation = occupation
  }

  if ('phone' in b) {
    const phone = typeof b.phone === 'string' ? b.phone.trim() : ''
    if (!phone) errors.push('电话不能为空')
    else if (!PHONE_RE.test(phone)) errors.push('手机号格式不正确（应为 1 开头的 11 位数字）')
    else data.phone = phone
  }

  if ('topics' in b) {
    // 与注册同款容错：契约要求数组，单个字符串也接受
    let topics: string[] = []
    if (Array.isArray(b.topics)) {
      topics = b.topics
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    } else if (typeof b.topics === 'string' && b.topics.trim().length > 0) {
      topics = [b.topics.trim()]
    }
    if (topics.length === 0) errors.push('关注议题至少选择一项')
    else if (topics.length > TOPICS_MAX) errors.push(`关注议题最多 ${TOPICS_MAX} 项`)
    else if (topics.some((t) => t.length > TOPIC_ITEM_MAX)) {
      errors.push(`单个议题最多 ${TOPIC_ITEM_MAX} 个字`)
    } else data.topics = topics
  }

  if (errors.length === 0 && Object.keys(data).length === 0) {
    errors.push('没有需要修改的内容')
  }

  if (errors.length > 0) return { data: null, errors }
  return { data, errors: [] }
}

/** 数据库行 → 返回给前端的用户对象（剔除 passwordHash；topics 还原为数组） */interface UserRow {
  id: string
  name: string
  org: string
  occupation: string
  topics: string
  phone: string
  /** 身份：user | admin（2026-10-19 管理台改造加）。老查询没 select 它时按 user 处理 */
  role?: string
}

/**
 * 前端公共用户对象。
 * 2026-10-19：补 `role` —— 前端据此决定要不要显示「管理台」入口
 * （真正的拦截在后端，前端这个字段只影响菜单显不显示，不构成权限）。
 */
function publicUser(u: UserRow): { id: string; name: string; org: string; occupation: string; topics: string[]; phone: string; role: string } {
  let topics: string[] = []
  try {
    const parsed: unknown = JSON.parse(u.topics)
    if (Array.isArray(parsed)) {
      topics = parsed.filter((t): t is string => typeof t === 'string')
    }
  } catch {
    topics = []
  }
  return {
    id: u.id,
    name: u.name,
    org: u.org,
    occupation: u.occupation,
    topics,
    phone: u.phone,
    role: u.role === 'admin' ? 'admin' : 'user'
  }
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
 *  这样即使反向代理剥掉了 Authorization 头，登录态也还在。
 * 生产环境 HTTPS 时请设置 COOKIE_SECURE=1，Set-Cookie 会带上 Secure 属性。 */
function setAuthCookie(res: Response, token: string): void {
  const cookieSecure = (process.env.COOKIE_SECURE ?? '').trim() === '1'
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: AUTH_COOKIE_MAX_AGE,
    path: '/',
    secure: cookieSecure
  })
}

/* ------------------------------------------------------------------ *
 * 注册 / 登录限流（2026-10-21 加 · P2-10）
 * ------------------------------------------------------------------ */

/** 限流窗口：10 分钟 */
const AUTH_RATE_WINDOW_MS = 10 * 60 * 1000
/** 窗口内同一 IP 最多尝试次数（注册与登录分开计数） */
const AUTH_RATE_MAX = 5
/** 记录条数到这个量就顺手清一遍过期项，防止这个 Map 无限涨 */
const AUTH_RATE_PRUNE_AT = 5000

/** key = '用途:IP' → 最近几次尝试的时间戳 */
const authRateHits = new Map<string, number[]>()

/** 清掉窗口外的旧记录 */
function pruneAuthRateHits(now: number): void {
  if (authRateHits.size < AUTH_RATE_PRUNE_AT) return
  for (const [key, hits] of authRateHits) {
    const kept = hits.filter((t) => now - t < AUTH_RATE_WINDOW_MS)
    if (kept.length === 0) authRateHits.delete(key)
    else authRateHits.set(key, kept)
  }
}

/**
 * 记一次注册/登录尝试，并判断要不要拦。
 *
 * 计数口径：**成功也计数**，不只数失败的 ——
 *   否则脚本可以拿一对已知正确的账号密码反复登录，把额度刷回来。
 *   代价是同一个出口 IP 的正常用户 10 分钟内超过 5 次会被拦；
 *   这是「一个出口 IP 一份额度」的取舍，和反馈接口的限流同一口径
 *   （见 backend/src/routes/feedback.ts）。
 *
 * @param scope 'register' | 'login' —— 两个用途各算各的，免得注册失败把登录也锁住
 * @returns true = 放行；false = 已超限（调用方回 429）
 */
function allowAuthAttempt(scope: 'register' | 'login', req: Request): boolean {
  const key = `${scope}:${req.ip ?? 'unknown'}`
  const now = Date.now()
  pruneAuthRateHits(now)
  const hits = (authRateHits.get(key) ?? []).filter((t) => now - t < AUTH_RATE_WINDOW_MS)
  if (hits.length >= AUTH_RATE_MAX) {
    authRateHits.set(key, hits)
    return false
  }
  hits.push(now)
  authRateHits.set(key, hits)
  return true
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

    // 限流放在查重之前：查重是查数据库，脚本狂刷注册会把库也打爆
    if (!allowAuthAttempt('register', req)) {
      fail(res, 429, '尝试太频繁了，请 10 分钟后再试', 'AUTH_RATE_LIMITED')
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

    // 限流：挡手机号爆破（挨个试密码）
    if (!allowAuthAttempt('login', req)) {
      fail(res, 429, '尝试太频繁了，请 10 分钟后再试', 'AUTH_RATE_LIMITED')
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

// —— POST /api/auth/logout：退出登录（2026-10-21 加 · C2）——
// 作用是**清掉服务端的登录 cookie**。
// 之前退出登录只清前端 localStorage，浏览器还一直带着 zwp_token cookie，
// 服务端仍认为「已登录」—— 游客的每日提问额度就这么被绕过去了（登录一次就能无限问）。
// 没登录时也回成功：退出登录必须幂等，不能因为「本来就没登录」而报错。
router.post('/logout', (_req: Request, res: Response) => {
  // clearCookie 的 path 必须和 setAuthCookie 一致，否则浏览器根本不清这条 cookie
  res.clearCookie(AUTH_COOKIE_NAME, { httpOnly: true, sameSite: 'lax', path: '/' })
  res.json({ success: true })
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

// —— PATCH /api/auth/me：修改当前用户的资料（2026-10-19）——
// 只改请求里出现的字段；手机号改动要做唯一性检查（它是登录凭证）。
// 响应体与 GET /me 同形（publicUser），前端拿到后直接覆盖本地登录态。
router.patch('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = userIdFromRequest(req)
    if (!auth.ok) {
      fail(res, 401, '未登录或登录已过期', auth.code)
      return
    }

    const { data, errors } = validateProfilePatch(req.body)
    if (!data) {
      fail(res, 400, `资料有误：${errors.join('；')}`)
      return
    }

    // 换手机号前先查有没有被别的账号占用（数据库唯一约束是第二道保险）
    if (data.phone) {
      const taken = await prisma.user.findUnique({ where: { phone: data.phone } })
      if (taken && taken.id !== auth.userId) {
        fail(res, 409, '该手机号已被其他账号使用')
        return
      }
    }

    const patch: { name?: string; org?: string; occupation?: string; topics?: string; phone?: string } = {}
    if (data.name !== undefined) patch.name = data.name
    if (data.org !== undefined) patch.org = data.org
    if (data.occupation !== undefined) patch.occupation = data.occupation
    if (data.phone !== undefined) patch.phone = data.phone
    // topics 在 SQLite 里存 JSON 字符串（与注册一致）
    if (data.topics !== undefined) patch.topics = JSON.stringify(data.topics)

    const user = await prisma.user.update({ where: { id: auth.userId }, data: patch })
    res.json(publicUser(user))
  } catch (err) {
    if (isUniqueViolation(err)) {
      fail(res, 409, '该手机号已被其他账号使用')
      return
    }
    next(err)
  }
})

// —— 路由级错误兜底：任何异常都以 JSON 返回，不让前端收到 HTML 错误页 ——
router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const requestId = (req as Request & { requestId?: string }).requestId
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`[auth] 500 ${requestId ? `requestId=${requestId} ` : ''}${detail}`)
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后再试' }
  })
})

export default router
