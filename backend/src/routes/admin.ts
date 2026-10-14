/**
 * 管理接口 —— 老师用的后台（2026-10-08 本地演示版新增）
 *
 *   GET /api/admin/knowledge   列出知识库里的全部资料（管理视角，含解析状态）
 *   GET|PUT /api/admin/qa-settings   问答设置（模型 / 回答方式 / 思考强度）
 *   GET|PUT /api/admin/agent   智能体设置（T7：网站问答的「大脑」就是引擎里那个智能体）
 *   POST /api/admin/knowledge/:id/reupload   解析失败 → 删旧重传（T6）
 *
 * 鉴权：请求头 X-Admin-Token，值 = backend/.env 的 ADMIN_STATS_TOKEN（fail closed，
 *       与统计看板 GET /api/track/stats 同一套口径）。
 * 口径：所有操作都由后端代理 WeKnora 引擎，前端永不直连引擎（铁律 2）；
 *       本文件不改 docs.ts / auth.ts / track.ts 的任何既有行为。
 *
 * 已实现：列出资料、上传资料、删除资料、查看注册用户（T1 三项已补齐）、
 *         问答设置 GET/PUT /qa-settings（T3，2026-10-10）、
 *         解析失败一键重新上传（T6，2026-10-12）、
 *         智能体设置 GET/PUT /agent（T7，2026-10-13）、
 *         游客权限 GET/PUT /guest-permissions + 使用明细 GET /usage-detail（T11，2026-10-14）。
 */
import { PrismaClient } from '@prisma/client'
import express, { Router, type NextFunction, type Request, type Response } from 'express'

import { invalidateEngineListCache, listQaModels, type QaModelOption } from '../weknora/index.js'
import {
  FALLBACK_STRATEGIES,
  getAgentConfig,
  updateAgentConfig,
  type AgentConfigPatch,
  type AgentConfigView
} from '../weknora/agent-config.js'
import {
  SELFCHECK_ENGINE_TIMEOUT_MS,
  checkParserConfig,
  getParserConfigView,
  listParserEngines,
  updateParserConfig,
  type ParserConfigPatch
} from '../weknora/parser-config.js'
import { EngineError } from '../weknora/types.js'
import { baseNameOf, unzipFirstEntry } from '../weknora/zip.js'
import { localDateKey } from '../guest/ask-usage.js'
import {
  guestPermissionsPayload,
  parseGuestPermissionPatch,
  saveGuestPermissions,
  type GuestPermissionPatch
} from '../guest/permissions.js'
import {
  buildUsageDetail,
  isValidDateKey,
  type UserDirectory
} from '../guest/usage-detail.js'
import { readEvents } from '../track/store.js'
import {
  QA_STYLES,
  REASONING_EFFORTS,
  REASONING_LABELS,
  STYLE_HINTS,
  STYLE_LABELS,
  loadQaSettings,
  saveQaSettings,
  type MaybeEffort,
  type QaSettings,
  type QaStyle,
  type ReasoningEffort
} from '../weknora/qa-settings.js'

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

/* ------------------------------------------------------------------ *
 * 解析失败 → 重新上传（T6：删旧 + 重传，不走引擎的「重新解析」）
 * ------------------------------------------------------------------ */

/**
 * 「重新上传」链路的单步超时（毫秒）。
 *
 * 这一步要把大文件从引擎下载回来、再原样传回去，几十兆的 PDF 很正常，
 * 所以上限给得比别的接口宽；但必须有上限 —— 否则老师点一下可能转好几分钟。
 */
const REUPLOAD_TIMEOUT_MS = 120_000

/**
 * fetch 的原生 Response 类型。
 *
 * ⚠️ 本文件顶部 `import ... { type Response } from 'express'` 把全局的 `Response`
 * 抢走了（Express 的响应对象），直接写 `Response` 会绑到它身上，typecheck 报一片错。
 * 所以这里从 fetch 的返回值反推出原生类型。
 */
type FetchResponse = Awaited<ReturnType<typeof fetch>>

/**
 * 引擎一次调用（带 X-API-Key 与超时）。
 *
 * ⚠️ 只把「连不上 / 超时」统一抛成 Error，**HTTP 状态码由路由层按每一步自己判**
 * —— 因为同样一个 !ok，在取原件那步是 502，在取详情那步可能是 404（记录已不在）。
 * 沿用本文件既有的 fetch 风格（不新造 HTTP 层，与上传/删除同一套）。
 */
async function engineCall(url: string, init: RequestInit): Promise<FetchResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REUPLOAD_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new Error(aborted ? '请求超时' : '连不上引擎地址')
  } finally {
    clearTimeout(timer)
  }
}

/** 重新上传链路用到的引擎地址与密钥 */
interface EngineCtx {
  base: string
  apiKey: string
  kbId: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 等一份资料真正从库里退场。
 *
 * ⚠️ 引擎的删除是**异步**的：DELETE 只是先把记录标成 `deleting`，真正消失还有几秒
 * （`docs/接口约定.md` 里那条「删除后有几秒延迟」说的就是它）。
 * 这期间把同一个文件传回去，引擎会判成 `duplicate_file`(409) —— 2026-10-12 真机实测。
 *
 * 判定标准（二者之一即可）：
 *   - GET 单条接口已经取不到（404）
 *   - parse_status 已经是 `deleting`（引擎自己的退场中标记，对外列表已不返回它）
 *
 * 顺带实测到的引擎判定规则：重复文件按**内容 hash** 判，不是按文件名 ——
 * 同名不同内容能传进去，改名同内容会 409。所以这里等的是「旧记录退场」，
 * 不需要去改名绕。
 */
async function waitRecordGone(ctx: EngineCtx, id: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let gone = false
    try {
      const res = await engineCall(`${ctx.base}/api/v1/knowledge/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: { 'X-API-Key': ctx.apiKey }
      })
      if (res.status === 404) {
        gone = true
      } else if (res.ok) {
        const raw: unknown = await res.json()
        const rec = isRecordLike(raw) && isRecordLike(raw['data']) ? raw['data'] : raw
        gone = isRecordLike(rec) && str(rec['parse_status']) === 'deleting'
      }
    } catch {
      // 引擎抖一下不算「已退场」，继续等；到点还没退干净由调用方决定怎么办
    }
    if (gone) return true
    await sleep(500)
  }
  return false
}

/**
 * 引擎的 custom_metadata 只接受**字符串 / 数字 / 布尔**（数组、对象会被拒），
 * 这里逐项挑能写的，原样带回；挑不出来的直接丢 —— 宁可少写一项，也别整份 PUT 失败。
 */
function sanitizeCustomMeta(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (!isRecordLike(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim()) continue
    if (typeof value === 'string') {
      const text = value.trim()
      if (text) out[key] = text
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    } else if (typeof value === 'boolean') {
      out[key] = value
    }
    // 数组 / 对象 / null → 引擎会拒，跳过
  }
  return out
}

/**
 * POST /api/admin/knowledge/:id/reupload —— 解析失败的一键「重新上传」
 *
 * 链路（每步都有独立错误映射，别让老师看到一句没头没尾的报错）：
 *   1. POST batch-download {ids:[id]}  → zip 字节 → zip.ts 拆出原件
 *   2. GET  /api/v1/knowledge/:id       → 旧记录的 custom_metadata 与原文件名
 *   3. DELETE /api/v1/knowledge/:id     → 删掉解析失败的那份
 *   4. POST batch 的 knowledge/file     → FormData 把原件原样传回去
 *   5. PUT  /api/v1/knowledge/:newId    → 把 custom_metadata 原样写回
 *   6. invalidateEngineListCache()      → 书架别再拿旧缓存
 *
 * 为什么不用引擎的「重新解析」：那条路是异步任务，状态要轮询、失败原因难读；
 * 本需求要的是**确定性的**「换一份重传」，老师点完就能看到状态变回处理中。
 * 老师本地不需要留原件 —— 原件全程只在引擎与本进程内存里过一遍。
 *
 * ⚠️ 本接口**没有请求体**，鉴权用 requireAdmin 中间件排在最前（与上传同一考量）。
 */
router.post('/knowledge/:id/reupload', requireAdmin, async (req: Request, res: Response) => {
  const base = (env('WEKNORA_BASE_URL') || 'http://localhost:8080').replace(/\/+$/, '')
  const apiKey = env('WEKNORA_API_KEY')
  const kbId = env('WEKNORA_KB_ID')
  if (!apiKey || !kbId) {
    res.status(503).json({
      success: false,
      error: {
        code: 'ENGINE_NOT_CONFIGURED',
        message: '还没配 WEKNORA_API_KEY / WEKNORA_KB_ID，重新上传不了'
      }
    })
    return
  }

  const id = String(req.params.id ?? '').trim()
  if (!id) {
    res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: '没给要重新上传哪一份（缺资料编号）' }
    })
    return
  }

  const authed = { 'X-API-Key': apiKey }

  try {
    /* 步骤 1：把原件从引擎取回来 ---------------------------------------- */
    const dl = await engineCall(
      `${base}/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/knowledge/batch-download`,
      {
        method: 'POST',
        headers: { ...authed, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] })
      }
    )
    if (dl.status === 404) {
      res.status(404).json({
        success: false,
        error: { code: 'KNOWLEDGE_NOT_FOUND', message: '这份资料已经不在库里了' }
      })
      return
    }
    if (!dl.ok) {
      res.status(502).json({
        success: false,
        error: {
          code: 'ENGINE_UNREACHABLE',
          message: `引擎暂时连不上（取原件时返回 HTTP ${dl.status}），稍后再试一次`
        }
      })
      return
    }

    // zip 拆不出文件时不立刻报错：先看第 2 步的记录还在不在 ——
    // 记录已经被人删掉也会拆不出文件，那该报的是 404 而不是「没取回原件」。
    let original: { name: string; data: Buffer } | null = null
    let unzipError = ''
    try {
      original = unzipFirstEntry(Buffer.from(await dl.arrayBuffer()))
    } catch (err) {
      unzipError = err instanceof Error ? err.message : '未知错误'
    }

    /* 步骤 2：读旧记录（拿元数据 + 原文件名） ---------------------------- */
    const detailRes = await engineCall(`${base}/api/v1/knowledge/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: authed
    })
    if (detailRes.status === 404) {
      res.status(404).json({
        success: false,
        error: { code: 'KNOWLEDGE_NOT_FOUND', message: '这份资料已经不在库里了' }
      })
      return
    }
    if (!detailRes.ok) {
      res.status(502).json({
        success: false,
        error: {
          code: 'ENGINE_UNREACHABLE',
          message: `引擎暂时连不上（读资料信息时返回 HTTP ${detailRes.status}），稍后再试一次`
        }
      })
      return
    }

    // ⚠️ 引擎单条接口外面包了一层 {success,data:{…}}，不解包 metadata 全是空
    // （2026-10-08 实测踩中，见 weknora/getDoc 的同一处注释）
    const detailRaw: unknown = await detailRes.json()
    const detail =
      isRecordLike(detailRaw) && isRecordLike(detailRaw['data']) ? detailRaw['data'] : detailRaw
    const detailRec: EngineKnowledge = isRecordLike(detail) ? detail : {}
    const customMeta = sanitizeCustomMeta(detailRec.custom_metadata)

    if (!original) {
      res.status(502).json({
        success: false,
        error: {
          code: 'ENGINE_BAD_PAYLOAD',
          message: '没能从引擎取回原件',
          detail: `引擎返回的下载包里没有文件条目：${unzipError}`
        }
      })
      return
    }

    /* 步骤 3：删掉解析失败的旧记录 ---------------------------------------- */
    const del = await engineCall(`${base}/api/v1/knowledge/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authed
    })
    if (del.status === 404) {
      res.status(404).json({
        success: false,
        error: { code: 'KNOWLEDGE_NOT_FOUND', message: '这份资料已经不在库里了' }
      })
      return
    }
    if (!del.ok) {
      res.status(502).json({
        success: false,
        error: {
          code: 'DELETE_FAILED',
          message: `旧记录删不掉（引擎返回 HTTP ${del.status}），没敢重传，原件还在库里`
        }
      })
      return
    }

    // 引擎删除是异步的（记录先标 deleting）。这期间重传同一个文件会被判成
    // duplicate_file(409)，所以删完必须等它真的退场，见 waitRecordGone 的实测注释。
    const ctx: EngineCtx = { base, apiKey, kbId }
    const oldGone = await waitRecordGone(ctx, id)
    if (!oldGone) {
      res.status(502).json({
        success: false,
        error: {
          code: 'ENGINE_STILL_DELETING',
          message: '引擎还在清理刚删掉的那份（没清理完之前传回去会被判成重复文件），请过十几秒再点一次「重新上传」'
        }
      })
      return
    }

    /* 步骤 4：把原件传回去 ------------------------------------------------ */
    const fileName = str(detailRec.file_name) || baseNameOf(original.name)
    const uploadUrl = `${base}/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/knowledge/file`

    // 409 再补一次：引擎那边判重复的时机与「标记 deleting」不完全同步，
    // 偶发会慢半拍。给一次有上限的等待重试，不做死循环。
    let upStatus = 0
    let upText = ''
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // FormData 是一次性的，每次重试都得重新构造
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(original.data)]), fileName)
      form.append('fileName', fileName)

      const res = await engineCall(uploadUrl, { method: 'POST', headers: authed, body: form })
      upStatus = res.status
      upText = await res.text()
      if (res.ok || res.status !== 409) break
      await waitRecordGone(ctx, id, 8000)
    }

    let upPayload: unknown = upText.slice(0, 400)
    try {
      upPayload = JSON.parse(upText)
    } catch {
      // 引擎偶尔回非 JSON，保留原文片段给老师看
    }

    if (upStatus < 200 || upStatus >= 300) {
      res.status(502).json({
        success: false,
        error: {
          code: 'UPLOAD_FAILED',
          message:
            upStatus === 409
              ? '引擎说这份文件还在库里（刚删掉的那份可能还没清干净），请过十几秒再点一次「重新上传」'
              : `引擎拒绝了这次上传（HTTP ${upStatus}）`,
          detail: upPayload
        }
      })
      return
    }

    const newId = extractCreatedId(upPayload)
    if (!newId) {
      // 文件其实已经进去了，只是引擎没回编号 —— 如实说，让老师自己看列表确认
      res.status(502).json({
        success: false,
        error: {
          code: 'ENGINE_BAD_PAYLOAD',
          message: '引擎收下了文件但没返回新条目编号，请到列表里确认一下状态',
          detail: upPayload
        }
      })
      return
    }

    /* 步骤 5：把业务元数据原样写回 ---------------------------------------- */
    let metaRestored = false
    let metaNote = ''
    if (Object.keys(customMeta).length === 0) {
      metaNote = '这份资料原本就没有机构/年份/类型标签，没什么可补的'
    } else {
      const put = await engineCall(`${base}/api/v1/knowledge/${encodeURIComponent(newId)}`, {
        method: 'PUT',
        headers: { ...authed, 'Content-Type': 'application/json' },
        body: JSON.stringify({ custom_metadata: customMeta })
      })
      metaRestored = put.ok
      if (!put.ok) metaNote = `文件已重新上传，但标签没能写回去（引擎返回 HTTP ${put.status}）`
    }

    /* 步骤 6：新资料进来了，让书架列表缓存立刻失效 -------------------------- */
    invalidateEngineListCache()

    res.json({
      success: true,
      message: metaRestored
        ? '已重新上传，机构/年份/类型标签也带回来了；引擎正在解析'
        : '已重新上传，引擎正在解析',
      metaNote,
      data: { id: newId, fileName, metaRestored }
    })
  } catch (err) {
    // 只剩「连不上 / 超时」会走到这里（其余每步各自 return 掉了）
    const reason = err instanceof Error ? err.message : '未知错误'
    res.status(502).json({
      success: false,
      error: { code: 'ENGINE_UNREACHABLE', message: `引擎暂时连不上（${reason}），稍后再试一次` }
    })
  }
})

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

/**
 * ─────────────────────────────────────────────────────────────────
 * 问答设置（T3：模型 / 回答方式 / 思考强度）
 * ─────────────────────────────────────────────────────────────────
 *
 * 口径：
 *   - **只改我们自己的设置文件**，不碰引擎数据库、不调
 *     `PUT /api/v1/initialization/config/*`（那个会清空知识库分块配置，实测踩过）
 *   - 模型列表从引擎 `GET /api/v1/models` 现拉现用（引擎**不支持** ?type= 过滤，
 *     所以由 weknora 层按 type === 'KnowledgeQA' 过滤）
 *   - 取不到模型列表时接口**仍然 200**，把原因放在 modelsError 里 ——
 *     这样老师还能看到「当前生效的是什么」，而不是一个空白页
 */

/** 组装 GET/PUT 共用的响应体（PUT 存完也要回显同一个形状，前端存完直接刷新用） */
function qaSettingsPayload(settings: QaSettings, models: QaModelOption[], modelsError: string) {
  const hit = models.find((m) => m.id === settings.modelId)
  return {
    success: true,
    currentModelId: settings.modelId,
    // 已存的模型在引擎里查不到时给空串（前端据此提示「重新选一个」），
    // 别拿 id 冒充模型名 —— 那样老师会以为自己选的是个叫 uuid 的模型
    currentModelName: hit ? hit.name : '',
    models,
    style: settings.style,
    styles: QA_STYLES.map((value) => ({
      value,
      label: STYLE_LABELS[value],
      hint: STYLE_HINTS[value]
    })),
    reasoningEffort: settings.reasoningEffort,
    efforts: REASONING_EFFORTS.map((value) => ({ value, label: REASONING_LABELS[value] })),
    modelsError,
    updatedAt: settings.updatedAt
  }
}

/** GET /api/admin/qa-settings —— 读当前设置 + 引擎可用模型 */
router.get('/qa-settings', async (req: Request, res: Response) => {
  if (!assertAdmin(req, res)) return

  if (!env('WEKNORA_API_KEY')) {
    res.status(503).json({
      success: false,
      error: {
        code: 'ENGINE_NOT_CONFIGURED',
        message: '还没配 WEKNORA_API_KEY，取不到可选模型'
      }
    })
    return
  }

  let models: QaModelOption[] = []
  let modelsError = ''
  try {
    models = await listQaModels()
  } catch (err) {
    // 降级：设置照样返回，只是模型列表空着 + 给个原因
    modelsError = err instanceof Error ? err.message : '未知错误'
  }

  res.json(qaSettingsPayload(loadQaSettings(), models, modelsError))
})

/** 请求体校验：三个字段都可选，只校验传了的那些 */
function isEffortToken(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * PUT /api/admin/qa-settings —— 保存设置
 *
 * ⚠️ 鉴权用 requireAdmin 中间件排在**读请求体之前**（与上传接口同一考量）。
 */
router.put('/qa-settings', requireAdmin, async (req: Request, res: Response) => {
  const body: unknown = req.body
  const obj: Record<string, unknown> = isRecordLike(body) ? body : {}
  const current = loadQaSettings()

  let nextModelId = current.modelId
  if ('modelId' in obj) {
    const value = obj.modelId
    if (value !== undefined && typeof value !== 'string') {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_MODEL_ID', message: 'modelId 得是字符串' }
      })
      return
    }
    nextModelId = String(value ?? '').trim()
  }

  let nextStyle: QaStyle = current.style
  if ('style' in obj) {
    const value = obj.style
    if (value !== 'quick' && value !== 'knowledge') {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STYLE',
          message: `style 只能是 quick 或 knowledge，收到：${JSON.stringify(value ?? null)}`
        }
      })
      return
    }
    nextStyle = value
  }

  // 空串 = 交给引擎默认；非空必须是引擎认的那 8 个值之一（否则引擎会 400）
  let nextEffort: MaybeEffort = current.reasoningEffort
  if ('reasoningEffort' in obj) {
    const value = obj.reasoningEffort
    if (value === undefined || value === null || value === '') {
      nextEffort = ''
    } else if (!isEffortToken(value)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REASONING_EFFORT',
          message: `思考强度只能是 ${REASONING_EFFORTS.join(' / ')} 或留空（跟随引擎默认）`
        }
      })
      return
    } else {
      nextEffort = value
    }
  }

  // 模型必须真实存在：引擎对不存在的 summary_model_id 会**静默回退**到默认模型
  // （照样返回 200，不换模型）。不校验的话，老师选了模型却完全不知道没生效。
  if (nextModelId && !env('WEKNORA_API_KEY')) {
    res.status(503).json({
      success: false,
      error: {
        code: 'ENGINE_NOT_CONFIGURED',
        message: '还没配 WEKNORA_API_KEY，验不了模型是否可用'
      }
    })
    return
  }
  let models: QaModelOption[] = []
  if (nextModelId) {
    try {
      models = await listQaModels()
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误'
      res.status(502).json({
        success: false,
        error: { code: 'ENGINE_UNREACHABLE', message: `连不上引擎，没法验模型是否可用：${message}` }
      })
      return
    }
    if (!models.some((m) => m.id === nextModelId)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'MODEL_NOT_AVAILABLE',
          message: '引擎里没有这个模型（可能已被删除），请重新选一个'
        }
      })
      return
    }
  }

  try {
    const saved = saveQaSettings({
      modelId: nextModelId,
      style: nextStyle,
      reasoningEffort: nextEffort,
      updatedAt: ''
    })
    // PUT 不带 modelId 时不用为了回显去连引擎（省一次往返，也避免引擎挂了就存不了风格）
    res.json(qaSettingsPayload(saved, nextModelId ? models : [], ''))
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误'
    res.status(500).json({
      success: false,
      error: { code: 'SAVE_FAILED', message: `保存问答设置失败：${message}` }
    })
  }
})

/* ------------------------------------------------------------------ *
 * 智能体设置（T7：问答走智能体 + 智能体设置上网页）
 * ------------------------------------------------------------------ *
 *
 * 口径（与 /qa-settings 有本质区别，务必看清）：
 *   - /qa-settings 改的是**我们自己的设置文件**，不碰引擎数据库；
 *   - /agent 改的是**引擎里那个智能体本体** —— 问答的提示词、模型、长度上限、兜底文案都在那儿。
 *     老师在这里改一行，网站问答立刻换一套脑子。
 *
 * 🔴 为什么写入必须走 agent-config.ts 的 updateAgentConfig：
 *   引擎 `PUT /api/v1/agents/{id}` 是**整体替换**（`existingAgent.Config = agent.Config`），
 *   漏传一个字段就归零（提示词清空 / 长度上限回落 1024 / 兜底变成模型自由发挥）。
 *   所以那条链路被写死成「GET 全量 → 只改表单字段 → PUT 完整 config → 回读校验四项」，
 *   本文件只负责鉴权、校验请求体、翻译错误码，**不碰**那套顺序。
 *
 * 🔴 `kb_selection_mode` 恒为 selected：引擎里 now 有 7 个库（含 123 份「AI系统学习」），
 *   设成 all 会把不相干的资料一起拉进检索。agent-config.ts 在写入前与回读后各卡一道。
 */

/** 模型下拉的选项（复用 listQaModels，与 /qa-settings 同一份；取不到就给原因，不给空白页） */
async function agentModels(): Promise<{ models: AgentConfigView['models']; modelsError: string }> {
  try {
    const rows: QaModelOption[] = await listQaModels()
    return { models: rows.map((m) => ({ id: m.id, name: m.name, status: m.status })), modelsError: '' }
  } catch (err) {
    return { models: [], modelsError: err instanceof Error ? err.message : '未知错误' }
  }
}

/** 把引擎侧的失败翻译成本项目的错误信封（code 一律沿用 EngineError 带来的） */
function sendEngineFailure(res: Response, err: unknown, prefix: string): void {
  if (err instanceof EngineError) {
    res.status(err.status).json({
      success: false,
      error: { code: err.code, message: `${prefix}：${err.message}` }
    })
    return
  }
  const message = err instanceof Error ? err.message : '未知错误'
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: `${prefix}：${message}` } })
}

/** GET /api/admin/agent —— 读智能体关键配置（6 个可改 + 4 组只读） */
router.get('/agent', async (req: Request, res: Response) => {
  if (!assertAdmin(req, res)) return

  const { models, modelsError } = await agentModels()
  try {
    res.json(await getAgentConfig(models, modelsError))
  } catch (err) {
    sendEngineFailure(res, err, '读智能体配置失败')
  }
})

/** 请求体校验：每个字段都可选，只校验传了的那些；类型不对一律 400（不猜、不兜底改写） */
function parseAgentPatch(raw: unknown): AgentConfigPatch {
  const obj: Record<string, unknown> = isRecordLike(raw) ? raw : {}

  const strField = (key: 'system_prompt' | 'model_id' | 'fallback_strategy' | 'fallback_response') => {
    if (!(key in obj)) return
    const value = obj[key]
    if (value === null) {
      // null = 「这一项没传」，直接不带走
      delete obj[key]
      return
    }
    if (typeof value !== 'string') {
      throw new EngineError('INVALID_AGENT_FIELD', `${key} 得是字符串`, 400)
    }
    // ⚠️ 空串**原样带下去**，不在这里丢掉：agent-config 收到后会把它记进 `ignored`，
    //    前端据此提示「这几项填的是空值，已保持原样没改」——
    //    在这里悄悄删掉的话，老师以为自己清空了，其实没改，界面还什么都不说。
    //    （真正「不写」这件事由 agent-config 负责，见 updateAgentConfig 的 applyString。）
  }
  const numField = (key: 'temperature' | 'max_completion_tokens') => {
    if (!(key in obj)) return
    const value = obj[key]
    if (value === null || value === undefined) {
      // 「这一项没传」
      delete obj[key]
      return
    }
    // 空串与字符串字段同一口径：「不改这一项」（清空输入框不该变成 400）
    if (typeof value === 'string' && value.trim() === '') {
      delete obj[key]
      return
    }
    if (typeof value === 'string' && !Number.isNaN(Number(value))) {
      obj[key] = Number(value)
    }
    if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key] as number)) {
      throw new EngineError('INVALID_AGENT_FIELD', `${key} 得是数字`, 400)
    }
  }

  strField('system_prompt')
  strField('model_id')
  strField('fallback_strategy')
  strField('fallback_response')
  numField('temperature')
  numField('max_completion_tokens')

  if ('temperature' in obj) {
    const t = obj['temperature'] as number
    // 0–1 是本项目的推荐区间；1–2 放行（引擎容得下），负数与 >2 一律拒
    if (t < 0 || t > 2) {
      throw new EngineError('INVALID_AGENT_FIELD', 'temperature 要在 0 到 2 之间（推荐 0 到 1）', 400)
    }
  }
  if ('max_completion_tokens' in obj) {
    const n = obj['max_completion_tokens'] as number
    if (n < 1 || !Number.isInteger(n)) {
      throw new EngineError('INVALID_AGENT_FIELD', 'max_completion_tokens 得是正整数', 400)
    }
  }
  if ('fallback_strategy' in obj) {
    const v = obj['fallback_strategy']
    // 空串 = 「不改这一项」，不算非法值（真正的判定在 agent-config，那里会记进 ignored）
    if (typeof v === 'string' && v.trim() === '') {
      // 放行
    } else if (!(FALLBACK_STRATEGIES as readonly string[]).includes(v as string)) {
      throw new EngineError(
        'INVALID_AGENT_FIELD',
        `fallback_strategy 只能是 ${FALLBACK_STRATEGIES.join(' 或 ')}（fixed = 用固定文案，model = 交给模型自由发挥）`,
        400
      )
    }
  }
  // 🔴 白名单之外的一律丢掉：kb_selection_mode / knowledge_bases / agent_mode /
  //    intent_prompts / agent_mode 等**绝不接受前端提交**（它们只能原样透传）
  const allowed = new Set([
    'system_prompt',
    'model_id',
    'temperature',
    'max_completion_tokens',
    'fallback_strategy',
    'fallback_response'
  ])
  const patch: AgentConfigPatch = {}
  for (const key of allowed) {
    if (key in obj) {
      // 上面已把每个键的类型收窄，这里逐个搬运（不用 as any，AGENTS.md 禁 any）
      switch (key) {
        case 'system_prompt':
          patch.system_prompt = obj['system_prompt'] as string
          break
        case 'model_id':
          patch.model_id = obj['model_id'] as string
          break
        case 'fallback_strategy':
          patch.fallback_strategy = obj['fallback_strategy'] as string
          break
        case 'fallback_response':
          patch.fallback_response = obj['fallback_response'] as string
          break
        case 'temperature':
          patch.temperature = obj['temperature'] as number
          break
        default:
          patch.max_completion_tokens = obj['max_completion_tokens'] as number
      }
    }
  }
  return patch
}

/**
 * PUT /api/admin/agent —— 改智能体配置（写引擎本体）
 *
 * ⚠️ 鉴权用 requireAdmin 中间件排在读请求体之前（与上传/qa-settings 同一考量）。
 * ⚠️ 模型必须真实存在：引擎对不存在的 model_id 是**静默回退**到默认模型（照样 200），
 *    不校验的话老师选了却完全不知道没生效 —— 与 /qa-settings 同一教训。
 */
router.put('/agent', requireAdmin, async (req: Request, res: Response) => {
  let patch: AgentConfigPatch
  try {
    patch = parseAgentPatch(req.body)
  } catch (err) {
    sendEngineFailure(res, err, '参数不合法')
    return
  }

  if (patch.model_id) {
    const { models, modelsError } = await agentModels()
    if (modelsError) {
      res.status(502).json({
        success: false,
        error: { code: 'ENGINE_UNREACHABLE', message: `连不上引擎，没法验模型是否可用：${modelsError}` }
      })
      return
    }
    if (!models.some((m) => m.id === patch.model_id)) {
      res.status(400).json({
        success: false,
        error: { code: 'MODEL_NOT_AVAILABLE', message: '引擎里没有这个模型（可能已被删除），请重新选一个' }
      })
      return
    }
  }

  const { models, modelsError } = await agentModels()
  try {
    const result = await updateAgentConfig(patch, models)
    res.json({ ...result, models, modelsError })
  } catch (err) {
    sendEngineFailure(res, err, '保存智能体设置失败')
  }
})

/* ------------------------------------------------------------------ *
 * 设置页（T10：解析引擎设置 + 一键自检）
 * ------------------------------------------------------------------ *
 *
 *   GET  /api/admin/parser-config        读解析引擎配置（密钥只回「已配置 / 未配置」）
 *   POST /api/admin/parser-config/check  测试连接（只测不存）
 *   PUT  /api/admin/parser-config        保存（读全量 → 合并 → 整份写回 → 回读校验）
 *   POST /api/admin/selfcheck            一键自检（引擎 / 数据库 / 向量 / MinerU 四项）
 *
 * 🔴 引擎那份配置的 PUT 是**整体替换**：只提交一部分字段，其余会被清零
 *    （主控 2026-10-14 实测：提交 1 个字段，18 个被清掉 15 个）。
 *    所以写入顺序与密钥的三条规则都写死在 weknora/parser-config.ts 里，
 *    本节只做鉴权与错误信封翻译，**不要在这里拼 body**。
 */

/** 解析引擎配置的请求体（只放非密钥的基本类型字段） */
function parserPatchBody(body: unknown): ParserConfigPatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new EngineError('INVALID_PARSER_FIELD', '请求体得是一个对象', 400)
  }
  // 这里只做「是个对象 + 值是基本类型」的粗筛，字段名与类型的严格校验
  // 交给 parser-config.parseParserPatch（它要先读到引擎当前配置才知道该长什么样）
  const out: ParserConfigPatch = {}
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
      continue
    }
    throw new EngineError('INVALID_PARSER_FIELD', `${key} 只能是文本、开关或数字`, 400)
  }
  return out
}

/** GET /api/admin/parser-config —— 读配置 + 各解析引擎可用性（密钥不回显真值） */
router.get('/parser-config', async (req: Request, res: Response) => {
  if (!assertAdmin(req, res)) return

  try {
    res.json(await getParserConfigView())
  } catch (err) {
    sendEngineFailure(res, err, '读解析引擎设置失败')
  }
})

/**
 * POST /api/admin/parser-config/check —— 测试连接，**不保存**。
 *
 * ⚠️ 鉴权用 requireAdmin 中间件排在读请求体之前（与上传/qa-settings 同一考量）。
 */
router.post('/parser-config/check', requireAdmin, async (req: Request, res: Response) => {
  try {
    const patch = parserPatchBody(req.body)
    res.json(await checkParserConfig(patch))
  } catch (err) {
    sendEngineFailure(res, err, '测试连接失败')
  }
})

/**
 * PUT /api/admin/parser-config —— 保存解析引擎设置（写引擎本体）。
 *
 * ⚠️ 校验没过**照样 200**（配置已经写进去了，抛错会让老师以为没保存）：
 *    响应里 `success:false` + `checks[]` 逐项写清「期望什么、实际什么」。
 */
router.put('/parser-config', requireAdmin, async (req: Request, res: Response) => {
  try {
    const patch = parserPatchBody(req.body)
    res.json(await updateParserConfig(patch))
  } catch (err) {
    sendEngineFailure(res, err, '保存解析引擎设置失败')
  }
})

/* ------------------------------------------------------------------ *
 * 一键自检
 * ------------------------------------------------------------------ */

/** 自检的一项（都是人话，不甩英文报错原文；原文放 detail 里给排障用） */
interface SelfcheckItem {
  key: string
  label: string
  ok: boolean
  message: string
  /** 这一项花了多久（毫秒） */
  ms: number
  /** 排障用的原始原因（前端不展示，只在失败时打印） */
  detail: string
}

/** 一项检查的超时上限（毫秒） */
const SELFCHECK_TIMEOUT_MS = 5_000

/** 给任意 Promise 加个超时上限，避免某一项卡住把整个自检拖死 */
async function withSelfcheckTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}s）`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 引擎给的原因 → 一句人话（2026-10-14 实测引擎原话是英文，前端不能直接甩给老师） */
function mineruHumanReason(reason: string): string {
  if (/api key/i.test(reason)) return 'API Key 没配或已失效，请在「设置」页的 MinerU 一栏填一下'
  if (/token/i.test(reason)) return '云端 Token 没配，请在「设置」页的 MinerU 一栏填一下'
  if (/endpoint|address|service not configured/i.test(reason)) return '服务地址没配，请在「设置」页的 MinerU 一栏填一下'
  return '请到「设置」页检查 MinerU 的地址与密钥'
}

/**
 * POST /api/admin/selfcheck —— 一次返回四项结果。
 *
 * 🔴 容错是硬要求：**任何一项失败都不能让整个接口 500**，一律返回 200 + `{ok:false}`，
 *    失败项给一句人话（如「向量服务没启动：请先运行 Ollama」）。这个接口是给人看状态的，
 *    一项挂了却弹「服务器错误」，等于让人没法排障。
 */
router.post('/selfcheck', requireAdmin, async (_req: Request, res: Response) => {
  const items: SelfcheckItem[] = []

  /* 1. 知识库引擎 ------------------------------------------------------- */
  {
    const started = Date.now()
    let engines: Awaited<ReturnType<typeof listParserEngines>> = []
    try {
      engines = await withSelfcheckTimeout(
        listParserEngines(SELFCHECK_ENGINE_TIMEOUT_MS),
        SELFCHECK_ENGINE_TIMEOUT_MS + 500,
        '探测知识库引擎'
      )
      items.push({
        key: 'engine',
        label: '知识库引擎',
        ok: true,
        message: `引擎正常，已识别 ${engines.length} 个解析引擎`,
        ms: Date.now() - started,
        detail: ''
      })
    } catch (err) {
      items.push({
        key: 'engine',
        label: '知识库引擎',
        ok: false,
        message: '连不上知识库引擎，请确认 WeKnora 服务已经启动',
        ms: Date.now() - started,
        detail: err instanceof Error ? err.message : '未知错误'
      })
    }

    /* 4. MinerU 云解析：直接复用上面那份引擎清单（不额外发请求） ------ */
    const mineruStarted = Date.now()
    const mineru = engines.find((e) => e.name === 'mineru_cloud')
    if (!mineru) {
      items.push({
        key: 'mineru',
        label: 'MinerU 云解析',
        ok: false,
        message: '引擎没返回 MinerU 云解析这一项，请到「设置」页查看',
        ms: Date.now() - mineruStarted,
        detail: 'parser-engines 里没有 mineru_cloud'
      })
    } else if (mineru.available) {
      items.push({
        key: 'mineru',
        label: 'MinerU 云解析',
        ok: true,
        message: 'MinerU 云解析可用，新上传的 PDF 走的就是它',
        ms: Date.now() - mineruStarted,
        detail: ''
      })
    } else {
      items.push({
        key: 'mineru',
        label: 'MinerU 云解析',
        ok: false,
        message: `MinerU 云解析不可用：${mineruHumanReason(mineru.unavailableReason)}`,
        ms: Date.now() - mineruStarted,
        detail: mineru.unavailableReason
      })
    }
  }

  /* 2. 数据库 ------------------------------------------------------------ */
  {
    const started = Date.now()
    try {
      const count = await withSelfcheckTimeout(prisma.user.count(), SELFCHECK_TIMEOUT_MS, '读数据库')
      items.push({
        key: 'database',
        label: '数据库',
        ok: true,
        message: `数据库正常，已登记 ${count} 位注册用户`,
        ms: Date.now() - started,
        detail: ''
      })
    } catch (err) {
      items.push({
        key: 'database',
        label: '数据库',
        ok: false,
        message: '数据库读不出来，请确认 backend/data 下的 SQLite 文件还在',
        ms: Date.now() - started,
        detail: err instanceof Error ? err.message : '未知错误'
      })
    }
  }

  /* 3. 向量服务（Ollama）-------------------------------------------------- */
  {
    const started = Date.now()
    const base = (env('OLLAMA_BASE_URL') || 'http://127.0.0.1:11434').replace(/\/+$/, '')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const upstream = await fetch(`${base}/api/version`, { signal: controller.signal })
      if (!upstream.ok) {
        throw new Error(`HTTP ${upstream.status}`)
      }
      const raw: unknown = await upstream.json().catch(() => null)
      const version =
        typeof raw === 'object' && raw !== null && 'version' in raw
          ? String((raw as { version?: unknown }).version ?? '')
          : ''
      items.push({
        key: 'vector',
        label: '向量服务',
        ok: true,
        message: version ? `向量服务正常（Ollama ${version}）` : '向量服务正常',
        ms: Date.now() - started,
        detail: ''
      })
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      items.push({
        key: 'vector',
        label: '向量服务',
        ok: false,
        message: `向量服务没启动：请先运行 Ollama（默认地址 127.0.0.1:11434）；AI 问答会暂时不可用`,
        ms: Date.now() - started,
        detail: aborted ? '超时' : err instanceof Error ? err.message : '未知错误'
      })
    } finally {
      clearTimeout(timer)
    }
  }

  res.json({
    success: true,
    ok: items.every((item) => item.ok),
    generatedAt: new Date().toISOString(),
    items
  })
})

/* ------------------------------------------------------------------ *
 * 游客权限（T11：设置页第 4 块）
 * ------------------------------------------------------------------ *
 *
 *   GET /api/admin/guest-permissions   开关清单（含默认值 + 说明）+ 当前值
 *   PUT /api/admin/guest-permissions   只改传了的项；写完**回读校验**再返回
 *
 * 开关清单与顺序是**后端的真相**（guest/permissions.ts 的 GUEST_SWITCHES），
 * 前端照 `switches[]` 的顺序渲染，不自己抄一份 —— 两处各抄一份早晚漂。
 *
 * 🔴 真正的拦截在路由层（routes/ask.ts / docs.ts / track.ts），本接口只管配置值。
 *    `browse` 是只读项：提交了也忽略（最低门槛入口，不能关）。
 */
router.get('/guest-permissions', async (req: Request, res: Response) => {
  if (!assertAdmin(req, res)) return
  try {
    res.json(guestPermissionsPayload())
  } catch (err) {
    sendEngineFailure(res, err, '读游客权限失败')
  }
})

router.put('/guest-permissions', requireAdmin, async (req: Request, res: Response) => {
  let patch: GuestPermissionPatch
  let ignored: string[]
  try {
    const parsed = parseGuestPermissionPatch(req.body)
    patch = parsed.patch
    ignored = parsed.ignored
  } catch (err) {
    // 参数不合法：400 + 一句人话（不猜、不兜底改写 —— 存了个错的却以为存上了更糟）
    const message = err instanceof Error ? err.message : '参数不合法'
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_GUEST_PERMISSION', message: `游客权限参数不合法：${message}` }
    })
    return
  }

  try {
    const result = saveGuestPermissions(patch)
    const failed = result.checks.filter((c) => !c.ok)
    res.json({
      success: failed.length === 0,
      message:
        failed.length === 0
          ? `已保存并生效（改了 ${result.changed.length} 项：${
              result.changed.length > 0 ? result.changed.join('、') : '无变化'
            }），回读校验全过`
          : '已写入，但回读校验没过，请看下面的逐项结果',
      changed: result.changed,
      ignored,
      checks: result.checks,
      config: guestPermissionsPayload(result.settings)
    })
  } catch (err) {
    sendEngineFailure(res, err, '保存游客权限失败')
  }
})

/* ------------------------------------------------------------------ *
 * 使用明细（T11-C：数据面板末尾那一块）
 * ------------------------------------------------------------------ *
 *
 *   GET /api/admin/usage-detail?date=YYYY-MM-DD   省略 date = 今天
 *
 * 数据源只有本地埋点文件（track/store.ts 的 readEvents），**不打引擎**。
 * 只统计 ai_ask / preview / download 三类，按账号分组；`userId=null` 归到「游客」组、
 * 固定排在最后。name/org 去 SQLite 的 User 表补上，**查不到就留空，不报错**。
 *
 * 🔴 文件不存在/为空/坏行 → 返回空表，**绝不能 500**（看板是用来看的）。
 * 🔴 本接口不改 /api/track/stats 的任何口径：韶茹那块统计逻辑一个字都没动。
 */
router.get('/usage-detail', async (req: Request, res: Response) => {
  if (!assertAdmin(req, res)) return

  const rawDate = typeof req.query.date === 'string' ? req.query.date.trim() : ''
  const date = rawDate || localDateKey()
  if (!isValidDateKey(date)) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_DATE', message: `日期格式应为 YYYY-MM-DD，收到：${rawDate}` }
    })
    return
  }

  try {
    const events = readEvents()
    const detail = buildUsageDetail(events, date)

    // 账号档案：只有真的出现在表里的 id 才去查（查不到留空，绝不因为库读不出来就 500）
    const ids = detail.rows.map((row) => row.userId).filter((id): id is string => id !== null)
    if (ids.length > 0) {
      try {
        const users = await prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, org: true }
        })
        const directory: UserDirectory = new Map(
          users.map((u) => [u.id, { name: u.name, org: u.org }])
        )
        res.json(buildUsageDetail(events, date, directory))
        return
      } catch (err) {
        // 用户表读不出来（如尚未 db:push）→ 照常返回表，只是姓名/机构留空
        const message = err instanceof Error ? err.message : '未知错误'
        console.warn(`[admin] 读用户档案失败（姓名/机构留空，不影响明细）：${message}`)
      }
    }

    res.json(detail)
  } catch (err) {
    // 埋点文件坏到连读都读不了：给一句人话 + 空表，别让看板整页报错
    const message = err instanceof Error ? err.message : '未知错误'
    console.error(`[admin] 读使用明细失败（已忽略，返回空表）：${message}`)
    res.json({ success: true, date, rows: [], totals: { ai_ask: 0, preview: 0, download: 0 } })
  }
})

export default router
