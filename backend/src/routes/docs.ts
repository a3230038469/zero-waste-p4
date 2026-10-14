/**
 * 资料接口 —— 负责人：韶茹
 *
 *   GET /api/docs              资料列表（四维筛选 + 搜索 + 分页 + 排序）
 *   GET /api/docs/facets       筛选项（各维度值 + 数量）
 *   GET /api/docs/:id          资料详情
 *   GET /api/docs/:id/preview  在线预览
 *   GET /api/docs/:id/download 下载原件（文件名「年份-机构-标题」）
 *
 * T10：列表与筛选项都支持 `?orgLike=关键词`（机构名包含匹配，单值文本式检索）。
 *      `?orgSearch=` 仍保留 —— 它只作用于 `facets` 的机构**下拉选项**（老接口，不删）。
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
import { duplicateOf } from '../data/duplicates.js'
import {
  JOINT_ORG_VALUE,
  buildOrgFacets,
  isJointOrg,
  matchesOrgLike,
  orgKey,
  searchOrgFacets,
  srcTableLabel
} from '../data/orgs.js'
import { recordEvent } from '../track/store.js'

const router = Router()

/** 每页默认条数，契约固定 20 */
const DEFAULT_PAGE_SIZE = 20
/** 每页上限，契约封顶 100 */
const MAX_PAGE_SIZE = 100

type Dim = 'type' | 'org' | 'year' | 'tag' | 'srcTable'

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
    // T8：机构值过一遍归一（别名 → 主名，联合发文串整体当一个键），
    // 与筛选器算出来的键、资料侧的键落在同一套上，否则「选的」和「筛的」对不上。
    org: toStringArray(req.query.org).map(orgKey).filter(Boolean),
    year: toStringArray(req.query.year),
    tag: toStringArray(req.query.tag),
    // T8：所属方向（传数据原值，不动显示名）
    srcTable: toStringArray(req.query.srcTable),
    // T10：机构文本式检索（单值）。原始串原样带下去，比对时的空白归一与小写
    // 都在 matchesOrgLike 里做（那里两侧对称处理，避免这里单边归一）。
    orgLike: typeof req.query.orgLike === 'string' ? req.query.orgLike.trim() : '',
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
 * 机构维度是否命中。
 *
 * T8 起机构不再是「原始串全等」，而是**归一键全等**（见 data/orgs.ts）：
 *   · 单机构值 → 主名比对（选「联合国环境规划署」能筛到写作 `UNEP` 的资料）；
 *   · 联合发文 → 整体当作一个键（选中它只筛**恰好这几家**联合署名的资料），
 *     与下拉里标的数字严格一致；
 *   · `__joint__` → 「联合发文」汇总项，筛所有多家机构署名的资料。
 */
function matchesOrg(doc: KbDocInternal, selected: string[]): boolean {
  if (selected.length === 0) return true
  const joint = isJointOrg(doc.org)
  const key = orgKey(doc.org)
  return selected.some((value) => (value === JOINT_ORG_VALUE ? joint : key === value))
}

/**
 * 机构**文本式**筛选（T10）：机构名里含这个关键词就算命中。
 *
 * 🔴 与上面 `matchesOrg` 是两套语义，可共存、同时满足（AND）：
 *   前端书架的「机构」从下拉多选改成了输入框 + 回车，`?orgLike=太平洋`
 *   要把「发布机构名称里含『太平洋』」的资料全列出来（可能命中多家不同机构）。
 *   `org` 精确多选**保留**（接口约定里的老参数，别的调用方还在用）。
 *
 * 归一（`\xa0` / `\u3000` → 普通空格 + 转小写）与命中判定都在 data/orgs.ts 的
 * `matchesOrgLike` 里，两侧对称处理 —— 只归一一边会出现「用户敲普通空格搜不到」。
 */

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
    if (skipDim !== 'org' && !matchesOrg(doc, query.org)) return false
    // T10：orgLike 属于机构这一维，所以算「机构」的筛选项数量时同样不带它
    // （否则下拉/计数会与实际筛选结果对不上）。
    if (skipDim !== 'org' && !matchesOrgLike(doc.org, query.orgLike)) return false
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
    if (
      skipDim !== 'srcTable' &&
      dimValues(query, 'srcTable').length &&
      !query.srcTable.includes(doc.srcTable)
    ) {
      return false
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
    // newest：按入库时间倒序。引擎来源有 createdAt；本地索引没有时间戳，
    // 回落到 id 数字后缀（k-35 → 35）。
    sorted.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || idOrder(b) - idOrder(a))
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
  const forSrcTable = filterDocs(docs, query, 'srcTable')

  return {
    types: countBy(forType, (d) => [d.type]).sort(byCountThenValue),
    // T8：机构下拉只列**单机构且出现 ≥2 次**的（老库实测 41 个），
    // 另加一条「联合发文」汇总 —— 长串不单独列，只显示短标签。
    // 其余（含 296 个只出现一次的机构）仍可搜到：见下面 facets 路由的 orgSearch 分支。
    orgs: buildOrgFacets(forOrg),
    // 年份 0 = 台账未填。它不是「0 年」，放进下拉会让用户看到一个没有意义的「0」选项，
    // 且选中它等于筛「年份缺失」这种内部口径。对外展示站直接不列，详情页按「年份不详」显示。
    years: countBy(forYear, (d) => (d.year > 0 ? [String(d.year)] : [])).sort(byYearDesc),
    tags: countBy(forTag, (d) => d.tags).sort(byCountThenValue),
    // T8：所属方向。value 用数据原值（保证筛得准），label 给对外中文名。
    // 数据源里没有方向时这里是空数组 —— 前端据此不渲染该筛选项，而不是摆一个筛不中的假选项。
    srcTables: countBy(forSrcTable, (d) => (d.srcTable ? [d.srcTable] : []))
      .map((item) => ({ ...item, label: srcTableLabel(item.value) }))
      .sort(byCountThenValue)
  }
}

/** 只把契约七字段交给前端，内部字段（fileName / filePath / sourceUrl…）不外泄 */
function toPublicDoc(doc: KbDocInternal): KbDoc {
  const keepId = duplicateOf(doc.id)
  return {
    id: doc.id,
    title: doc.title,
    org: doc.org,
    year: doc.year,
    type: doc.type,
    tags: doc.tags,
    size: doc.size,
    // 副本标记：只有确实是副本时才出现该字段（避免给 605 份正常资料都挂一个 undefined 字段）
    ...(keepId ? { duplicateOf: keepId } : {})
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
    const facets = buildFacets(docs, query)

    /**
     * T8：机构搜索（`?orgSearch=关键字`）。
     *
     * 为什么要有它：默认下拉只列出现 ≥2 次的**单机构**（老库实测 41 项），而老库里
     * 有 296 个机构值只出现一次、另有 186 个联合发文长串 —— 用户仍要能搜到它们，
     * 否则等于「把三百多个选项藏起来」。
     *
     * 只在**机构这一维**上换成搜索命中（上限 20 条），其余维度照常返回，
     * 所以响应形状与不加这个参数时完全一致（既有调用方零改动）。
     */
    const orgSearch = typeof req.query.orgSearch === 'string' ? req.query.orgSearch.trim() : ''
    if (orgSearch) {
      // 搜索池用**按其余条件筛过的**资料（与下拉数字同口径：不含机构维度自己的选择）
      facets.orgs = searchOrgFacets(filterDocs(docs, query, 'org'), orgSearch)
    }

    res.json(facets)
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
