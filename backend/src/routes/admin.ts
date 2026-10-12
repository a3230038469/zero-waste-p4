/**
 * 管理接口 —— 老师用的后台（2026-10-08 本地演示版新增）
 *
 *   GET /api/admin/knowledge   列出知识库里的全部资料（管理视角，含解析状态）
 *   GET|PUT /api/admin/qa-settings   问答设置（模型 / 回答方式 / 思考强度）
 *   POST /api/admin/knowledge/:id/reupload   解析失败 → 删旧重传（T6）
 *
 * 鉴权：请求头 X-Admin-Token，值 = backend/.env 的 ADMIN_STATS_TOKEN（fail closed，
 *       与统计看板 GET /api/track/stats 同一套口径）。
 * 口径：所有操作都由后端代理 WeKnora 引擎，前端永不直连引擎（铁律 2）；
 *       本文件不改 docs.ts / auth.ts / track.ts 的任何既有行为。
 *
 * 已实现：列出资料、上传资料、删除资料、查看注册用户（T1 三项已补齐）、
 *         问答设置 GET/PUT /qa-settings（T3，2026-10-10）、
 *         解析失败一键重新上传（T6，2026-10-12）。
 */
import { PrismaClient } from '@prisma/client'
import express, { Router, type NextFunction, type Request, type Response } from 'express'

import { invalidateEngineListCache, listQaModels, type QaModelOption } from '../weknora/index.js'
import { baseNameOf, unzipFirstEntry } from '../weknora/zip.js'
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

export default router
