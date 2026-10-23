/**
 * 投稿与审核接口 —— B09 公众上传（2026-10-13 新增）
 *
 * 两条路由挂在同一个文件里，但**分成两个 Router**，在 index.ts 挂到不同前缀：
 *
 *   投稿人侧（挂在 /api/contributions，需登录态 JWT）
 *     POST /api/contributions            提交投稿（octet-stream + X-File-Name，元数据走查询参数）
 *     GET  /api/contributions/mine       我的投稿（按登录用户过滤，含状态与退回理由）
 *
 *   管理侧（挂在 /api/admin/contributions，需**管理员账号**登录态，见 src/admin/guard.ts）
 *     GET  /api/admin/contributions              审核队列（?status=&page=&pageSize=）
 *     GET  /api/admin/contributions/:id/file     查看/下载待审原件
 *     POST /api/admin/contributions/:id/approve  通过 → 真进知识库
 *     POST /api/admin/contributions/:id/reject   退回（必填理由）
 *
 * 传输口径照抄 admin.ts：文件原始二进制放请求体（Content-Type: application/octet-stream），
 * 文件名走 X-File-Name 头（URL 编码），**不引 multer**，前端也不用 base64。
 *
 * 「通过」为什么不直接调引擎：知识库入库的口径、标签写入、缓存失效三步都在
 * admin.ts 的 POST /api/admin/knowledge/upload 里已经写好了，这里**转发给那个接口**
 * （带管理员登录凭证）是唯一不重复实现、也不改动别人文件的做法。
 * 转发失败时状态**停在 pending**，把失败原因原样回给管理员 —— 绝不能假装通过。
 *
 * ⚠️ 本文件不改 docs.ts / auth.ts / admin.ts / track.ts 的任何既有行为。
 *    JWT 校验逻辑与 auth.ts 同源但**在本文件内自带一份**（auth.ts 没有导出该函数，
 *    而硬约束是「不重构别人的文件」）。口径完全一致：Authorization: Bearer 优先，
 *    cookie zwp_token 兜底，密钥读 JWT_SECRET。
 */
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { requireAdminGuard } from '../admin/guard.js'
import { requestIdOf } from '../errors/types.js'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

import {
  MAX_FILE_BYTES,
  addContribution,
  contributionFileExists,
  contributionFilePath,
  deleteContributionFile,
  extensionOf,
  getContribution,
  listByUser,
  listContributions,
  newContributionId,
  updateContribution,
  writeContributionFile,
  type ContributionRecord
} from '../contributions/store.js'
import { contentDisposition, getDocParseState, type ParseState } from '../weknora/index.js'

/** 投稿人侧路由（index.ts 挂到 /api/contributions） */
export const contributionsRouter = Router()
/** 管理侧路由（index.ts 挂到 /api/admin/contributions） */
export const adminContributionsRouter = Router()

const prisma = new PrismaClient()

/** 只收 PDF（2026-10-11 三件拍板之一）：引擎对 PDF 解析效果最好 */
const ALLOWED_EXTENSIONS = ['.pdf']
/** 投稿说明的字数上限 */
const NOTE_MAX = 200
/** 管理 cookie 里的凭证名（与 auth.ts 保持一致） */
const AUTH_COOKIE_NAME = 'zwp_token'
/** 请求体上限：文件本身限 50MB，这里留开销余量 */
const BODY_LIMIT = '60mb'

/**
 * 统一错误信封，形状与 admin.ts / track.ts 一致：
 *   { success: false, error: { code, message, requestId } }
 * （前端 http.ts 统一读 error.message 弹提示；requestId 由 src/index.ts 的中间件写入，
 *   报障时把这号报给管理员就能直接对日志。契约 C6）
 */
function fail(res: Response, status: number, message: string, code?: string): void {
  res.status(status).json({
    success: false,
    error: { message, ...(code ? { code } : {}), requestId: requestIdOf(res.req) }
  })
}

/**
 * 本站自己的地址 —— 投稿通过后要转发给知识库上传接口。
 *
 * 原来这里写死 http://127.0.0.1:${port}（P2-12）：换端口/换域名就自转发失败，
 * 而且这个地址会顺着错误信息漏到公网。现在走环境变量 SELF_BASE_URL / BACKEND_BASE_URL，
 * 拿不到才退回本机端口（这个值只出现在服务端拼请求的 URL 里，不进任何对外文案）。
 */
function selfBaseUrl(): string {
  const configured = (process.env.SELF_BASE_URL ?? process.env.BACKEND_BASE_URL ?? '').trim()
  if (configured) return configured.replace(/\/+$/, '')
  const port = Number(process.env.PORT ?? 4000)
  return `http://127.0.0.1:${port}`
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 16) {
    throw new Error('JWT_SECRET 未配置或太短：请在 backend/.env 里设置一个随机长字符串（至少 16 位）')
  }
  return secret
}

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

/** 解析登录态 → 用户 id；未登录 / 凭证无效返回 null */
function userIdFromRequest(req: Request): string | null {
  const header = req.headers.authorization ?? ''
  let token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  if (!token) token = tokenFromCookieHeader(req)
  if (!token) return null
  try {
    const payload = jwt.verify(token, getJwtSecret())
    if (typeof payload === 'object' && payload !== null && typeof payload.sub === 'string') {
      return payload.sub
    }
    return null
  } catch {
    return null
  }
}

/** 登录门槛：投稿必须登录（拍板结论），未登录直接 401 */
function requireUser(req: Request, res: Response, next: NextFunction): void {
  const userId = userIdFromRequest(req)
  if (!userId) {
    fail(res, 401, '投稿需要先登录，请登录后再提交', 'AUTH_REQUIRED')
    return
  }
  res.locals.userId = userId
  next()
}

/** 取查询参数里的字符串（空串视为没填） */
function queryStr(req: Request, key: string): string {
  const raw = req.query[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 请求头里的文件名（URL 解码；解不开就用原值） */
function headerFileName(req: Request): string {
  const raw = String(req.header('X-File-Name') ?? '').trim()
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/* ------------------------------------------------------------------ *
 * 对外投影：投稿人不能看到别人的信息，管理端才看得到投稿人身份
 * ------------------------------------------------------------------ */

/** 投稿人视角的一条投稿（**不含 phone**） */
function toMyItem(record: ContributionRecord): Record<string, unknown> {
  return {
    id: record.id,
    title: record.title,
    fileName: record.fileName,
    org: record.org,
    year: record.year,
    type: record.type,
    tags: record.tags,
    note: record.note,
    status: record.status,
    reason: record.reason,
    createdAt: record.createdAt,
    reviewedAt: record.reviewedAt
  }
}

/** 管理端视角的一条投稿（含投稿人身份与原件信息） */
function toAdminItem(record: ContributionRecord): Record<string, unknown> {
  return {
    id: record.id,
    title: record.title,
    org: record.org,
    year: record.year,
    type: record.type,
    tags: record.tags,
    note: record.note,
    fileName: record.fileName,
    size: record.size,
    status: record.status,
    reason: record.reason,
    docId: record.docId,
    createdAt: record.createdAt,
    reviewedAt: record.reviewedAt,
    // 投稿人信息：管理员核对身份 / 联系投稿人用
    userId: record.userId,
    userName: record.userName,
    userOrg: record.userOrg,
    userPhone: record.userPhone
  }
}

/**
 * 这条投稿当前的解析进度（2026-10-21 新增）。
 *
 * 只有「已通过且有 docId」才有意义：待审/退回的还没进知识库；已通过但数据源
 * 切在 local / snapshot 时查不到引擎进度，一律 unknown（前端遇到 unknown 不编进度）。
 * 查询失败也已经在上游吞成 unknown —— 进度是附加信息，不能拖垮整个列表。
 */
async function parseStateOf(record: ContributionRecord): Promise<ParseState> {
  if (record.status !== 'approved' || !record.docId) return 'unknown'
  return getDocParseState(record.docId)
}

/** 投稿人视角 + 解析进度 */
async function toMyItemWithState(record: ContributionRecord): Promise<Record<string, unknown>> {
  return { ...toMyItem(record), parseState: await parseStateOf(record) }
}

/** 管理端视角 + 解析进度 */
async function toAdminItemWithState(record: ContributionRecord): Promise<Record<string, unknown>> {
  return { ...toAdminItem(record), parseState: await parseStateOf(record) }
}

/** 待审原件的绝对路径（管理端「查看原件」用） */
export function filePathOf(record: ContributionRecord): string {
  return contributionFilePath(record.storedName)
}

/** 从引擎回包里取新建条目编号（形状与 admin.ts 的 extractCreatedId 同口径） */
function extractCreatedId(payload: Record<string, unknown>): string {
  const idOf = (value: unknown): string =>
    typeof value === 'object' && value !== null ? String((value as { id?: unknown }).id ?? '') : ''
  const data = payload.data
  const nested = typeof data === 'object' && data !== null ? (data as { data?: unknown }).data : undefined
  return idOf(data) || idOf(nested) || idOf(payload) || ''
}

/* ------------------------------------------------------------------ *
 * 投稿人侧
 * ------------------------------------------------------------------ */

/**
 * POST /api/contributions —— 提交一份投稿
 *
 * 查询参数：title / org / year / type / tags（均必填）、note（选填）
 * 请求体：PDF 原始二进制；文件名走 X-File-Name 头
 */
contributionsRouter.post(
  '/',
  requireUser,
  express.raw({ type: () => true, limit: BODY_LIMIT }),
  async (req: Request, res: Response) => {
    const userId = String(res.locals.userId ?? '')
    const title = queryStr(req, 'title')
    const org = queryStr(req, 'org')
    const year = queryStr(req, 'year')
    const type = queryStr(req, 'type')
    const tags = queryStr(req, 'tags')
    const note = queryStr(req, 'note').slice(0, NOTE_MAX)
    const fileName = headerFileName(req)

    if (!title) {
      fail(res, 400, '请填写资料标题', 'MISSING_TITLE')
      return
    }
    if (!org || !year || !type || !tags) {
      fail(res, 400, '机构 / 年份 / 类型 / 主题都要选（下拉里的选项来自现有资料库）', 'MISSING_META')
      return
    }
    if (!fileName) {
      fail(res, 400, '没收到文件（缺 X-File-Name 头）', 'BAD_UPLOAD')
      return
    }

    const ext = extensionOf(fileName)
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      fail(res, 400, '目前只接收 PDF 文件，请先把其他格式导出成 PDF 再投稿', 'BAD_FILE_TYPE')
      return
    }

    const body = req.body as unknown
    if (!Buffer.isBuffer(body) || body.length === 0) {
      fail(res, 400, '文件内容为空，请重新选择文件', 'EMPTY_FILE')
      return
    }
    if (body.length > MAX_FILE_BYTES) {
      fail(res, 413, `文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB，请压缩后再投稿`, 'FILE_TOO_LARGE')
      return
    }

    // 投稿人身份从库里取（不信任前端 POST 上来的姓名 / 电话）
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, org: true, phone: true }
    })
    if (!user) {
      fail(res, 401, '登录用户不存在，请重新登录后再投稿', 'USER_NOT_FOUND')
      return
    }

    const id = newContributionId()
    let storedName = ''
    try {
      storedName = writeContributionFile(id, ext, body)
    } catch {
      fail(res, 500, '文件保存失败，请稍后重试', 'STORE_FAILED')
      return
    }

    const record: ContributionRecord = {
      id,
      userId,
      userName: user.name,
      userOrg: user.org,
      userPhone: user.phone,
      title,
      org,
      year,
      type,
      tags,
      note,
      fileName,
      storedName,
      size: body.length,
      status: 'pending',
      reason: '',
      docId: '',
      createdAt: new Date().toISOString(),
      reviewedAt: ''
    }

    try {
      await addContribution(record)
    } catch {
      // 元数据没写进去，原件留在盘上就是垃圾，顺手清掉
      deleteContributionFile(storedName)
      fail(res, 500, '投稿登记失败，请稍后重试', 'STORE_FAILED')
      return
    }

    res.json({
      success: true,
      message: '投稿已提交，等待管理员审核。通过后会自动进入资料库',
      data: toMyItem(record)
    })
  }
)

/** GET /api/contributions/mine —— 我的投稿（新→旧，含状态、退回理由与解析进度） */
contributionsRouter.get('/mine', requireUser, async (_req: Request, res: Response) => {
  const userId = String(res.locals.userId ?? '')
  const items = await listByUser(userId)
  const projected = await Promise.all(items.map(toMyItemWithState))
  res.json({ success: true, total: projected.length, items: projected })
})

/* ------------------------------------------------------------------ *
 * 管理侧
 * ------------------------------------------------------------------ */

/** GET /api/admin/contributions —— 审核队列 */
adminContributionsRouter.get('/', async (req: Request, res: Response) => {
  if (!(await requireAdminGuard(req, res))) return

  const all = await listContributions()
  const counts = {
    pending: all.filter((x) => x.status === 'pending').length,
    approved: all.filter((x) => x.status === 'approved').length,
    rejected: all.filter((x) => x.status === 'rejected').length
  }

  const statusFilter = queryStr(req, 'status')
  const statusMatched = statusFilter ? all.filter((x) => x.status === statusFilter) : all

  // 标题/机构/文件名/投稿人检索（大小写不敏感）。队列长了以后管理员基本靠这一栏找稿子，
  // 与老师后台「资料管理」的搜索栏同一口径。
  const keyword = queryStr(req, 'keyword').toLowerCase()
  const filtered = keyword
    ? statusMatched.filter((x) =>
        [x.title, x.org, x.fileName, x.userName, x.userOrg]
          .some((field) => String(field ?? '').toLowerCase().includes(keyword))
      )
    : statusMatched

  const pageSize = Math.min(Math.max(Number(queryStr(req, 'pageSize')) || 20, 1), 100)
  const page = Math.max(Number(queryStr(req, 'page')) || 1, 1)
  const start = (page - 1) * pageSize

  // 只给本页的记录查解析进度（最多 100 条，不会把引擎打爆）
  const items = await Promise.all(filtered.slice(start, start + pageSize).map(toAdminItemWithState))

  res.json({
    success: true,
    total: filtered.length,
    page,
    pageSize,
    counts,
    items
  })
})

/** GET /api/admin/contributions/:id/file —— 查看 / 下载待审原件（PDF 内联推流） */
adminContributionsRouter.get('/:id/file', async (req: Request, res: Response) => {
  if (!(await requireAdminGuard(req, res))) return
  const record = await getContribution(req.params.id)
  if (!record) {
    fail(res, 404, '找不到这条投稿', 'NOT_FOUND')
    return
  }
  if (!contributionFileExists(record.storedName)) {
    fail(res, 410, '这份投稿的原件已不在服务器上（可能被清理过）', 'FILE_GONE')
    return
  }
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', contentDisposition(record.fileName, 'inline'))
  createReadStream(filePathOf(record)).pipe(res)
})

/**
 * POST /api/admin/contributions/:id/approve —— 通过
 *
 * 真入库：把原件转发给已有的 POST /api/admin/knowledge/upload（转发调用方的登录凭证），
 * 成功才改状态；失败保持 pending 并把引擎的原因回给管理员。
 */
adminContributionsRouter.post('/:id/approve', async (req: Request, res: Response) => {
  if (!(await requireAdminGuard(req, res))) return

  const record = await getContribution(req.params.id)
  if (!record) {
    fail(res, 404, '找不到这条投稿', 'NOT_FOUND')
    return
  }
  if (record.status !== 'pending') {
    fail(res, 409, `这条投稿已经处理过了（当前状态：${record.status}）`, 'ALREADY_REVIEWED')
    return
  }
  if (!contributionFileExists(record.storedName)) {
    fail(res, 410, '这份投稿的原件已不在服务器上，无法入库', 'FILE_GONE')
    return
  }

  const params = new URLSearchParams()
  for (const key of ['org', 'year', 'type', 'tags'] as const) {
    const value = record[key].trim()
    if (value) params.set(key, value)
  }
  // 自转发地址走环境变量（见 selfBaseUrl 的注释），不再写死 127.0.0.1
  const target = `${selfBaseUrl()}/api/admin/knowledge/upload?${params.toString()}`

  let upstreamOk = false
  let upstreamStatus = 0
  let payload: Record<string, unknown> = {}
  let failureMessage = ''
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        // 转发调用方的登录凭证：入库接口现在认「管理员账号」而不是口令
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        'X-File-Name': encodeURIComponent(record.fileName),
        'Content-Type': 'application/octet-stream'
      },
      body: new Uint8Array(await readFile(filePathOf(record))),
      signal: AbortSignal.timeout(300_000)
    })
    upstreamStatus = upstream.status
    const text = await upstream.text()
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      payload = { raw: text.slice(0, 300) }
    }
    upstreamOk = upstream.ok && payload.success !== false
  } catch (err) {
    failureMessage = err instanceof Error ? err.message : String(err)
  }

  if (!upstreamOk) {
    const rawDetail = (payload.error as { message?: string } | undefined)?.message ?? failureMessage
    // 「fetch failed / ECONNREFUSED」对老师没有意义，换成一句能照着做的话
    const detail = /fetch failed|ECONNREFUSED|ENOTFOUND|aborted|socket hang up/i.test(rawDetail)
      ? '连不上知识库引擎（WEKNORA_BASE_URL 指向的服务没响应）'
      : rawDetail
    // ⚠️ 状态**保持 pending**：入库没成就不能说通过，否则书架上永远看不到它
    fail(
      res,
      502,
      detail
        ? `入库失败，投稿状态仍是「待审核」：${detail}`
        : `入库失败（引擎返回 HTTP ${upstreamStatus || '无响应'}），投稿状态仍是「待审核」`,
      'INGEST_FAILED'
    )
    return
  }

  const docId = extractCreatedId(payload)
  const updated = await updateContribution(record.id, {
    status: 'approved',
    docId,
    reason: '',
    reviewedAt: new Date().toISOString()
  })

  res.json({
    success: true,
    message: docId
      ? '已通过并送入知识库，引擎正在后台解析（几分钟后书架可见）'
      : '已通过并送入知识库；引擎没回条目编号，书架稍后刷新看看',
    data: updated ? toAdminItem(updated) : null
  })
})

/** POST /api/admin/contributions/:id/reject —— 退回（必填理由） */
adminContributionsRouter.post('/:id/reject', async (req: Request, res: Response) => {
  if (!(await requireAdminGuard(req, res))) return

  const record = await getContribution(req.params.id)
  if (!record) {
    fail(res, 404, '找不到这条投稿', 'NOT_FOUND')
    return
  }
  if (record.status !== 'pending') {
    fail(res, 409, `这条投稿已经处理过了（当前状态：${record.status}）`, 'ALREADY_REVIEWED')
    return
  }

  const body = (req.body ?? {}) as { reason?: unknown }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : ''
  if (reason.length < 2) {
    fail(res, 400, '退回必须填写理由（至少 2 个字），投稿人会看到这段话', 'MISSING_REASON')
    return
  }

  const updated = await updateContribution(record.id, {
    status: 'rejected',
    reason,
    reviewedAt: new Date().toISOString()
  })

  res.json({
    success: true,
    message: '已退回，投稿人在「我的投稿」里能看到退回理由',
    data: updated ? toAdminItem(updated) : null
  })
})

/** 投稿人侧路由级错误兜底：任何异常都以 JSON 返回，不让前端收到 HTML 错误页 */
contributionsRouter.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : '服务器内部错误'
  // 超过 express.raw 的 limit 时是 413：说清楚比让前端看到「请求失败」有用
  const tooLarge = /entity too large|PayloadTooLarge/i.test(message)
  // ⚠️ 契约 C6：异常原文（可能带内部地址、堆栈）只进日志，对外只给中文
  console.error(`[contributions] ${requestIdOf(req)} ${req.method} ${req.originalUrl}: ${message}`)
  fail(
    res,
    tooLarge ? 413 : 500,
    tooLarge ? '文件太大了，单份请控制在 50MB 以内' : '投稿没能提交成功，请稍后重试'
  )
})

/** 管理侧路由级错误兜底：同样只回中文，内部细节只进日志 */
adminContributionsRouter.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : '服务器内部错误'
  console.error(`[admin-contributions] ${requestIdOf(req)} ${req.method} ${req.originalUrl}: ${message}`)
  fail(res, 500, '操作没能完成，请稍后重试')
})
