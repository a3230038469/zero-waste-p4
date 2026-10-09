/**
 * 管理接口 —— 老师用的后台（2026-10-08 本地演示版新增）
 *
 *   GET /api/admin/knowledge   列出知识库里的全部资料（管理视角，含解析状态）
 *
 * 鉴权：请求头 X-Admin-Token，值 = backend/.env 的 ADMIN_STATS_TOKEN（fail closed，
 *       与统计看板 GET /api/track/stats 同一套口径）。
 * 口径：所有操作都由后端代理 WeKnora 引擎，前端永不直连引擎（铁律 2）；
 *       本文件不改 docs.ts / auth.ts / track.ts 的任何既有行为。
 *
 * 已实现：列出资料、上传资料。
 * 待做：删除资料。
 */
import { PrismaClient } from '@prisma/client'
import express, { Router, type NextFunction, type Request, type Response } from 'express'

import { invalidateEngineListCache } from '../weknora/index.js'

const prisma = new PrismaClient()

const router = Router()

/** 读环境变量；占位符视为未配置（与 weknora 对接层同一口径） */
function env(name: string): string {
  const value = (process.env[name] ?? '').trim()
  if (!value || /^(your_|please_|change_?me|xxx|todo)/i.test(value)) return ''
  return value
}

/** 管理口令校验：与统计看板同款 fail closed */
function assertAdmin(req: Request, res: Response): boolean {
  const configured = env('ADMIN_STATS_TOKEN')
  if (!configured) {
    res.status(403).json({
      success: false,
      error: {
        code: 'ADMIN_NOT_CONFIGURED',
        message: '服务端未配置 ADMIN_STATS_TOKEN，管理接口已关闭'
      }
    })
    return false
  }
  if (String(req.header('X-Admin-Token') ?? '').trim() !== configured) {
    res.status(403).json({
      success: false,
      error: { code: 'ADMIN_FORBIDDEN', message: '口令不正确' }
    })
    return false
  }
  return true
}

interface EngineKnowledge {
  id?: unknown
  title?: unknown
  file_name?: unknown
  file_type?: unknown
  file_size?: unknown
  parse_status?: unknown
  summary_status?: unknown
  enable_status?: unknown
  created_at?: unknown
  folder_path?: unknown
  custom_metadata?: unknown
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 从上传请求的查询参数里收业务元数据（缺的就不写，不硬凑空值） */
function collectMeta(req: Request): Record<string, string> {
  const meta: Record<string, string> = {}
  for (const key of ['org', 'year', 'type', 'tags']) {
    const raw = req.query[key]
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value) meta[key] = value
  }
  return meta
}

/** 上传成功后从引擎回包里取新条目编号（引擎形状：{data:{id:…}}） */
function extractCreatedId(payload: unknown): string {
  if (!isRecordLike(payload)) return ''
  const data = payload['data']
  const candidates: unknown[] = []
  if (isRecordLike(data)) {
    candidates.push(data['id'])
    if (isRecordLike(data['data'])) candidates.push(data['data']['id'])
  }
  candidates.push(payload['id'])
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return ''
}

/** GET /api/admin/knowledge —— 列知识库资料（管理视角） */
router.get('/knowledge', async (req: Request, res: Response) => {
  if (!assertAdmin(req, res)) return

  const base = (env('WEKNORA_BASE_URL') || 'http://localhost:8080').replace(/\/+$/, '')
  const apiKey = env('WEKNORA_API_KEY')
  const kbId = env('WEKNORA_KB_ID')
  if (!apiKey || !kbId) {
    res.status(503).json({
      success: false,
      error: {
        code: 'ENGINE_NOT_CONFIGURED',
        message: '还没配 WEKNORA_API_KEY / WEKNORA_KB_ID，管理列表取不到资料'
      }
    })
    return
  }

  try {
    const items: Array<Record<string, unknown>> = []
    let total = 0
    // 引擎按页返回（默认每页 20），这里翻页取全量；上限 10 页 × 200 = 2000 条
    for (let page = 1; page <= 10; page += 1) {
      const url =
        `${base}/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/knowledge` +
        `?page=${page}&page_size=200`
      const upstream = await fetch(url, { headers: { 'X-API-Key': apiKey } })
      if (!upstream.ok) {
        throw new Error(`引擎返回 HTTP ${upstream.status}`)
      }
      const payload = (await upstream.json()) as { data?: EngineKnowledge[]; total?: unknown }
      const rows = Array.isArray(payload.data) ? payload.data : []
      total = num(payload.total)
      for (const raw of rows) {
        const cm = isRecordLike(raw.custom_metadata) ? raw.custom_metadata : {}
        items.push({
          id: str(raw.id),
          title: str(raw.title) || str(raw.file_name),
          fileName: str(raw.file_name),
          fileType: str(raw.file_type),
          size: num(raw.file_size),
          parseStatus: str(raw.parse_status),
          summaryStatus: str(raw.summary_status),
          enabled: str(raw.enable_status) === 'enabled',
          createdAt: str(raw.created_at),
          folderPath: str(raw.folder_path),
          meta: {
            org: str(cm['org']),
            year: str(cm['year']),
            type: str(cm['type']),
            tags: str(cm['tags'])
          }
        })
      }
      if (rows.length === 0 || (total > 0 && items.length >= total)) break
    }

    res.json({ success: true, total: total || items.length, items })
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误'
    res.status(502).json({
      success: false,
      error: { code: 'ENGINE_UNREACHABLE', message: `取资料列表失败：${message}` }
    })
  }
})

/**
 * 上传前的鉴权中间件。
 * ⚠️ 必须排在 express.raw 之前：否则未带口令的匿名请求会先把整个请求体
 * 缓冲进内存（上限 300MB），拿不到数据也能白占内存和带宽。
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (assertAdmin(req, res)) next()
}

/**
 * POST /api/admin/knowledge/upload —— 上传一份资料到知识库
 *
 * 传输方式：前端把文件原始二进制放在请求体（Content-Type: application/octet-stream），
 * 文件名走 X-File-Name 头（已 URL 编码）。后端再拼成引擎要的 multipart 转发过去。
 * 这样不用在前端做 base64（体积不变大），也不用给项目新增 multer 依赖。
 */
router.post(
  '/knowledge/upload',
  requireAdmin,
  express.raw({ type: () => true, limit: '300mb' }),
  async (req: Request, res: Response) => {
    const base = (env('WEKNORA_BASE_URL') || 'http://localhost:8080').replace(/\/+$/, '')
    const apiKey = env('WEKNORA_API_KEY')
    const kbId = env('WEKNORA_KB_ID')
    if (!apiKey || !kbId) {
      res.status(503).json({
        success: false,
        error: { code: 'ENGINE_NOT_CONFIGURED', message: '还没配 WEKNORA_API_KEY / WEKNORA_KB_ID，传不了' }
      })
      return
    }

    const rawName = String(req.header('X-File-Name') ?? '').trim()
    let fileName = ''
    try {
      fileName = decodeURIComponent(rawName)
    } catch {
      fileName = rawName
    }
    const body = req.body as unknown
    if (!fileName || !Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'BAD_UPLOAD', message: '没收到文件（缺 X-File-Name 头，或文件内容为空）' }
      })
      return
    }

    try {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(body)]), fileName)
      form.append('fileName', fileName)

      const upstream = await fetch(
        `${base}/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/knowledge/file`,
        { method: 'POST', headers: { 'X-API-Key': apiKey }, body: form }
      )
      const text = await upstream.text()
      let payload: unknown = text.slice(0, 400)
      try {
        payload = JSON.parse(text)
      } catch {
        // 引擎偶尔回非 JSON，保留原文片段
      }

      if (!upstream.ok) {
        const duplicated = upstream.status === 409
        res.status(duplicated ? 409 : 502).json({
          success: false,
          error: {
            code: duplicated ? 'DUPLICATE_FILE' : 'UPLOAD_FAILED',
            message: duplicated
              ? '这份资料知识库里已经有了，没有重复上传'
              : `引擎拒绝了这次上传（HTTP ${upstream.status}）`,
            detail: payload
          }
        })
        return
      }

      // 文件传上去了，但业务元数据要单独写一次 —— 引擎上传接口的 metadata
      // 字段存的是「处理配置」，不是机构/年份这类业务标签（2026-10-08 实测确认）。
      const meta = collectMeta(req)
      const createdId = extractCreatedId(payload)
      let metaSaved = false
      let metaNote = ''

      if (Object.keys(meta).length === 0) {
        metaNote = '这次没填机构/年份/类型，这份资料暂时没有标签'
      } else if (!createdId) {
        metaNote = '文件已上传，但引擎没返回新条目编号，标签没能写上去'
      } else {
        const put = await fetch(`${base}/api/v1/knowledge/${encodeURIComponent(createdId)}`, {
          method: 'PUT',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ custom_metadata: meta })
        })
        metaSaved = put.ok
        if (!put.ok) metaNote = `文件已上传，但标签写入失败（引擎返回 ${put.status}）`
      }

      // 新资料进来了，让书架的列表缓存立刻失效，否则要等最多 60 秒才看得见
      invalidateEngineListCache()

      res.json({
        success: true,
        message: metaSaved ? '已上传，标签也写好了；引擎正在后台解析' : '已上传，引擎正在后台解析',
        metaSaved,
        metaNote,
        data: payload
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误'
      res.status(502).json({
        success: false,
        error: { code: 'ENGINE_UNREACHABLE', message: `上传失败：${message}` }
      })
    }
  }
)

/** 手机号脱敏：中间四位打码（138 0000 8888 → 138****8888） */
function maskPhone(phone: string): string {
  const digits = String(phone ?? '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length < 7) return `${digits.slice(0, 2)}****`
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/** topics 在库里存的是 JSON 数组字符串（SQLite 无数组类型），这里还原成数组 */
function parseTopics(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/**
 * DELETE /api/admin/knowledge/:id —— 删除一份资料
 *
 * 口径：由后端代理引擎（铁律 2）；删完**立刻让书架列表缓存失效**，
 * 否则书架最长 60 秒还显示已删掉的资料，老师会以为没删掉。
 * ⚠️ 本接口**没有请求体**，不要加 express.raw。
 */
router.delete('/knowledge/:id', async (req: Request, res: Response) => {
  if (!assertAdmin(req, res)) return

  const base = (env('WEKNORA_BASE_URL') || 'http://localhost:8080').replace(/\/+$/, '')
  const apiKey = env('WEKNORA_API_KEY')
  if (!apiKey) {
    res.status(503).json({
      success: false,
      error: { code: 'ENGINE_NOT_CONFIGURED', message: '还没配 WEKNORA_API_KEY，删不了' }
    })
    return
  }

  const id = String(req.params.id ?? '').trim()
  if (!id) {
    res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: '没给要删哪一份（缺资料编号）' }
    })
    return
  }

  try {
    const upstream = await fetch(`${base}/api/v1/knowledge/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': apiKey }
    })

    // 404 说明它本来就不在了 —— 对使用者来说「已经删掉了」，别报成故障
    if (upstream.status === 404) {
      invalidateEngineListCache()
      res.status(404).json({
        success: false,
        error: { code: 'KNOWLEDGE_NOT_FOUND', message: '这份资料已经不在库里了' }
      })
      return
    }
    if (!upstream.ok) {
      res.status(502).json({
        success: false,
        error: {
          code: 'DELETE_FAILED',
          message: `引擎拒绝了这次删除（HTTP ${upstream.status}）`
        }
      })
      return
    }

    invalidateEngineListCache()
    res.json({ success: true, message: '已删除' })
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误'
    res.status(502).json({
      success: false,
      error: { code: 'ENGINE_UNREACHABLE', message: `删除失败：${message}` }
    })
  }
})

/**
 * GET /api/admin/users —— 看注册用户（管理视角）
 *
 * ⚠️ 手机号**必须脱敏**：这是给机构看的能力，避免完整手机号外泄。
 */
router.get('/users', async (req: Request, res: Response) => {
  if (!assertAdmin(req, res)) return

  try {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } })
    const items = users.map((user) => ({
      id: user.id,
      name: user.name,
      org: user.org,
      occupation: user.occupation,
      topics: parseTopics(user.topics),
      phone: maskPhone(user.phone),
      createdAt: user.createdAt.toISOString()
    }))
    res.json({ success: true, total: items.length, items })
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误'
    res.status(500).json({
      success: false,
      error: { code: 'USERS_QUERY_FAILED', message: `读用户列表失败：${message}` }
    })
  }
})

export default router
