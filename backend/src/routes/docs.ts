/**
 * 资料接口 —— 负责人：韶茹
 *
 *   GET /api/docs              资料列表（四维筛选 + 搜索 + 分页 + 排序）
 *   GET /api/docs/facets       筛选项（各维度值 + 数量）
 *   GET /api/docs/:id          资料详情
 *   GET /api/docs/:id/preview  在线预览
 *   GET /api/docs/:id/download 下载原件（文件名「年份-机构-标题」）
 *
 * 依赖：../weknora 对接层（自己写）
 * 注意：只改本文件，不要动 auth.ts / embed.ts
 */
import { Router, type Request, type Response } from 'express'

import {
  EngineError,
  buildDownloadName,
  contentDisposition,
  getDoc,
  getFileStream,
  listFiles,
  type DocsPage,
  type DocsQuery,
  type FacetItem,
  type KbDoc,
  type KbDocInternal,
  type KbFacets,
  type SortMode
} from '../weknora/index.js'
import { recordEvent } from '../track/store.js'

const router = Router()

/** 每页默认条数，契约固定 20 */
const DEFAULT_PAGE_SIZE = 20
/** 每页上限，契约封顶 100 */
const MAX_PAGE_SIZE = 100

type Dim = 'type' | 'org' | 'year' | 'tag'

/* ------------------------------------------------------------------ *
 * 查询参数解析
 * ------------------------------------------------------------------ */

/**
 * 把 query 值归一成字符串数组。
 *
 * ⚠️ 只认「重复同名参数」表达多值（`?tag=a&tag=b`），**不按逗号切分**。
 * 原因：真实数据里机构名自带逗号，例如「环境保护部,国家质量监督检验检疫总局」，
 * 一旦按逗号切，这个筛选项就会永远筛出 0 条（已实测踩中）。
 */
function toStringArray(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed) out.push(trimmed)
  }
  return [...new Set(out)]
}

function toInt(value: unknown, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

function parseQuery(req: Request): DocsQuery {
  const sortRaw = req.query.sort
  const sort: SortMode = sortRaw === 'newest' ? 'newest' : 'year_desc'

  // page=0 / 负数 / 乱填 一律回落第 1 页（验收要求）
  const page = Math.max(1, toInt(req.query.page, 1))
  const pageSizeRaw = toInt(req.query.pageSize, DEFAULT_PAGE_SIZE)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, pageSizeRaw || DEFAULT_PAGE_SIZE))

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

  return {
    type: toStringArray(req.query.type),
    org: toStringArray(req.query.org),
    year: toStringArray(req.query.year),
    tag: toStringArray(req.query.tag),
    q,
    page,
    pageSize,
    sort
  }
}

/* ------------------------------------------------------------------ *
 * 筛选 / 排序 / 分页 / 计数
 * ------------------------------------------------------------------ */

function dimValues(query: DocsQuery, dim: Dim): string[] {
  return query[dim]
}

function matchesKeyword(doc: KbDocInternal, keyword: string): boolean {
  if (!keyword) return true
  const lower = keyword.toLowerCase()
  // 契约：q 匹配「标题 / 文件名」
  return doc.title.toLowerCase().includes(lower) || doc.fileName.toLowerCase().includes(lower)
}

/**
 * 按条件筛选。
 *
 * skipDim 用于算筛选项数量：算某个维度的下拉数量时，**不带该维度自己的条件**，
 * 这样「下拉标的数字」和「选中后筛出来的条数」必然一致。
 */
function filterDocs(docs: KbDocInternal[], query: DocsQuery, skipDim?: Dim): KbDocInternal[] {
  return docs.filter((doc) => {
    if (!matchesKeyword(doc, query.q)) return false
    if (skipDim !== 'type' && dimValues(query, 'type').length && !query.type.includes(doc.type)) {
      return false
    }
    if (skipDim !== 'org' && dimValues(query, 'org').length && !query.org.includes(doc.org)) {
      return false
    }
    if (
      skipDim !== 'year' &&
      dimValues(query, 'year').length &&
      !query.year.includes(String(doc.year))
    ) {
      return false
    }
    if (skipDim !== 'tag' && dimValues(query, 'tag').length) {
      if (!doc.tags.some((tag) => query.tag.includes(tag))) return false
    }
    return true
  })
}

/** id 形如 k-35；排序时按数字后缀走，避免 k-9 排在 k-10 后面 */
function idOrder(doc: KbDocInternal): number {
  const parsed = Number(doc.id.replace(/^\D+/, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function sortDocs(docs: KbDocInternal[], sort: SortMode): KbDocInternal[] {
  const sorted = [...docs]
  if (sort === 'newest') {
    // newest：按录入顺序倒序（新入库的排前面）
    sorted.sort((a, b) => idOrder(b) - idOrder(a))
  } else {
    // year_desc（默认）：年份新的在前，同年按录入顺序正序
    sorted.sort((a, b) => b.year - a.year || idOrder(a) - idOrder(b))
  }
  return sorted
}

function countBy(docs: KbDocInternal[], values: (doc: KbDocInternal) => string[]): FacetItem[] {
  const counter = new Map<string, number>()
  for (const doc of docs) {
    for (const value of values(doc)) {
      counter.set(value, (counter.get(value) ?? 0) + 1)
    }
  }
  return [...counter.entries()].map(([value, count]) => ({ value, count }))
}

/** 数量从多到少；数量相同按字面序，保证每次返回顺序稳定 */
function byCountThenValue(a: FacetItem, b: FacetItem): number {
  return b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN')
}

/** 年份按新的在前 */
function byYearDesc(a: FacetItem, b: FacetItem): number {
  return Number(b.value) - Number(a.value)
}

function buildFacets(docs: KbDocInternal[], query: DocsQuery): KbFacets {
  const forType = filterDocs(docs, query, 'type')
  const forOrg = filterDocs(docs, query, 'org')
  const forYear = filterDocs(docs, query, 'year')
  const forTag = filterDocs(docs, query, 'tag')

  return {
    types: countBy(forType, (d) => [d.type]).sort(byCountThenValue),
    orgs: countBy(forOrg, (d) => [d.org]).sort(byCountThenValue),
    years: countBy(forYear, (d) => [String(d.year)]).sort(byYearDesc),
    tags: countBy(forTag, (d) => d.tags).sort(byCountThenValue)
  }
}

/** 只把契约七字段交给前端，内部字段（fileName / filePath / sourceUrl…）不外泄 */
function toPublicDoc(doc: KbDocInternal): KbDoc {
  return {
    id: doc.id,
    title: doc.title,
    org: doc.org,
    year: doc.year,
    type: doc.type,
    tags: doc.tags,
    size: doc.size
  }
}

/* ------------------------------------------------------------------ *
 * 统一错误出口（地基的 error 中间件未挂载，这里按同一信封自己兜）
 * ------------------------------------------------------------------ */

function sendError(res: Response, err: unknown): void {
  if (err instanceof EngineError) {
    res.status(err.status).json({ success: false, error: { code: err.code, message: err.message } })
    return
  }
  const message = err instanceof Error ? err.message : '服务器内部错误'
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } })
}

type Handler = (req: Request, res: Response) => Promise<void>

/** 包一层 try/catch，保证任何异常都返回统一 JSON，不白屏 */
function guard(handler: Handler): (req: Request, res: Response) => void {
  return (req, res) => {
    handler(req, res).catch((err: unknown) => sendError(res, err))
  }
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

/** 筛选项 —— 必须声明在 /:id 之前，否则会被当成 id */
router.get(
  '/facets',
  guard(async (req, res) => {
    const query = parseQuery(req)
    const docs = await listFiles()
    res.json(buildFacets(docs, query))
  })
)

/** 资料列表 */
router.get(
  '/',
  guard(async (req, res) => {
    const query = parseQuery(req)
    const all = await listFiles()
    const matched = sortDocs(filterDocs(all, query), query.sort)

    const total = matched.length
    const start = (query.page - 1) * query.pageSize
    const items = matched.slice(start, start + query.pageSize).map(toPublicDoc)

    // 埋点：带 q 的列表请求就是一次搜索。放服务端记比让前端记得更准
    // （前端漏报、被绕过都算得出来），且零结果率可直接用于「该补什么资料」。
    if (query.q) {
      recordEvent({
        event: 'search',
        source: 'server',
        path: '/api/docs',
        payload: { term: query.q, zeroResult: total === 0, hits: total }
      })
    }

    const page: DocsPage = {
      total,
      page: query.page,
      pageSize: query.pageSize,
      // 按契约：一条都没筛出来就是「没找到」，前端据此显示「试试问 AI」
      zeroResult: total === 0,
      items
    }
    res.json(page)
  })
)

/** 资料详情 */
router.get(
  '/:id',
  guard(async (req, res) => {
    const doc = await getDoc(req.params.id)
    res.json({ ...toPublicDoc(doc), sourceUrl: doc.sourceUrl })
  })
)

/**
 * 在线预览：inline 推 PDF，前端用 iframe / object 直接渲染。
 *
 * 顺带埋一条 preview（source: 'server'）——预览是「打开就发生」的动作，
 * 放服务端记比让前端记得更准（前端漏报、被绕过都算得出来）。埋点写在
 * recordEvent 内部已吞掉所有异常，绝不影响文件流。
 */
router.get(
  '/:id/preview',
  guard(async (req, res) => {
    const file = await getFileStream(req.params.id, 'inline')
    recordEvent({
      event: 'preview',
      source: 'server',
      path: '/api/docs/:id/preview',
      payload: { docId: req.params.id, fileName: file.fileName, size: file.size }
    })
    res.setHeader('Content-Type', file.contentType)
    res.setHeader('Content-Disposition', contentDisposition(file.fileName, 'inline'))
    if (file.size > 0) res.setHeader('Content-Length', String(file.size))
    file.stream.on('error', () => res.destroy())
    file.stream.pipe(res)
  })
)

/** 下载原件：文件名按契约「年份-机构-标题」；顺带埋一条 download（权威计数口径） */
router.get(
  '/:id/download',
  guard(async (req, res) => {
    const doc = await getDoc(req.params.id)
    const file = await getFileStream(req.params.id, 'attachment')
    const downloadName = buildDownloadName(doc)
    recordEvent({
      event: 'download',
      source: 'server',
      path: '/api/docs/:id/download',
      payload: { docId: doc.id, fileName: downloadName, size: file.size }
    })
    res.setHeader('Content-Type', file.contentType || 'application/octet-stream')
    res.setHeader('Content-Disposition', contentDisposition(downloadName, 'attachment'))
    if (file.size > 0) res.setHeader('Content-Length', String(file.size))
    file.stream.on('error', () => res.destroy())
    file.stream.pipe(res)
  })
)

export default router
