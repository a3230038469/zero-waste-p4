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
import { userIdFromRequest } from '../guest/identity.js'
import { loadGuestPermissions } from '../guest/permissions.js'
import { errorEnvelope, toPublicError } from '../errors/types.js' // T5：统一错误信封（契约 C6）

const router = Router()

/** 每页默认条数，契约固定 20 */
const DEFAULT_PAGE_SIZE = 20
/** 每页上限，契约封顶 100 */
const MAX_PAGE_SIZE = 100

type Dim = 'type' | 'org' | 'year' | 'tag' | 'srcTable'

/**
 * 「未分类」方向的哨兵值（T5 修复验收项 P1-8）
 *
 * 为什么要它：以前 buildFacets 只按 srcTable 分桶，**没有 srcTable 的资料被直接丢掉**，
 * 于是「全部」的方向合计（603）比接口给的总数（604）少 1，页面上同时出现两个对不上的数。
 *
 * 现在把没有 srcTable 的资料归进一个「未分类」方向：
 *   - value 用哨兵值（不是空串），这样前端「全部」（value 为空）不会和它混在一起；
 *   - filterDocs 也认这个哨兵值，点「未分类」能真的筛出这些资料（否则点了是空列表）。
 */
const UNCATEGORIZED_SRC_TABLE = '__uncategorized__'
/** 对外显示名 */
const UNCATEGORIZED_LABEL = '未分类'

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
    if (skipDim !== 'srcTable' && dimValues(query, 'srcTable').length) {
      // T5：srcTable 为空的资料归到「未分类」哨兵值，点它能筛出来
      const wanted = dimValues(query, 'srcTable')
      const hit = wanted.some(
        (value) => value === doc.srcTable || (value === UNCATEGORIZED_SRC_TABLE && !doc.srcTable)
      )
      if (!hit) return false
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
    // T5（P1-8）：**没有 srcTable 的资料也要进桶**，统一归到「未分类」方向 ——
    // 以前这些资料被直接丢掉，导致「方向合计」比接口总数少，页面上两个数对不上。
    // 数据源里一条资料都没有时这里仍然是空数组，前端据此不渲染该筛选项。
    srcTables: countBy(forSrcTable, (d) => [d.srcTable || UNCATEGORIZED_SRC_TABLE])
      .map((item) => ({
        ...item,
        label: item.value === UNCATEGORIZED_SRC_TABLE ? UNCATEGORIZED_LABEL : srcTableLabel(item.value)
      }))
      .sort(byCountThenValue)
  }
}

/** 只把契约字段交给前端，内部字段（fileName / filePath / sourceUrl / srcTable…）不外泄 */
function toPublicDoc(doc: KbDocInternal): KbDoc {
  const keepId = duplicateOf(doc.id)
  // T12：方向只吐**中文显示名**（`零废弃` / `化学品与健康`）；原始 srcTable 值仍只在内部用
  //（筛选参数传的还是原值，前端别拿 direction 去筛）。
  const direction = srcTableLabel(doc.srcTable)
  return {
    id: doc.id,
    title: doc.title,
    org: doc.org,
    year: doc.year,
    type: doc.type,
    tags: doc.tags,
    size: doc.size,
    // 方向：数据源没这一项时不挂字段（同 duplicateOf 的写法，不给全库挂空值）
    ...(direction ? { direction } : {}),
    // 副本标记：只有确实是副本时才出现该字段（避免给 605 份正常资料都挂一个 undefined 字段）
    ...(keepId ? { duplicateOf: keepId } : {})
  }
}

/* ------------------------------------------------------------------ *
 * 统一错误出口（地基的 error 中间件未挂载，这里按同一信封自己兜）
 * ------------------------------------------------------------------ */

/**
 * 错误出口（T5，契约 C6）
 *
 * 内部细节（异常原文、堆栈、引擎地址）一律不外发：
 *   - 资料不存在 → 404 + DOC_NOT_FOUND
 *   - 引擎故障 → 502 + ENGINE_UNAVAILABLE（message 里没有内部 URL / 英文堆栈）
 *   - 其它 → 500 + INTERNAL_ERROR
 * requestId 同时写进响应体和响应头，报障时直接报这个号。
 */
function sendError(req: Request, res: Response, err: unknown): void {
  const pub = toPublicError(err)
  if (pub.status >= 500) {
    console.error(`[docs] ${pub.detail}`)
  }
  res.status(pub.status).json(errorEnvelope(pub.code, pub.message, req))
}

type Handler = (req: Request, res: Response) => Promise<void>

/** 包一层 try/catch，保证任何异常都返回统一 JSON，不白屏 */
function guard(handler: Handler): (req: Request, res: Response) => void {
  return (req, res) => {
    handler(req, res).catch((err: unknown) => sendError(req, res, err))
  }
}

/**
 * 🔴 T11：游客权限**在后端真拦**。
 *
 * 为什么不能只在前端置灰：懂行的人直接 curl 接口照样能拿走文件。
 * 所以预览/下载在**打开文件流之前**先问一次「这个人是不是游客、这一项开不开」。
 *
 * 返回 true = 放行；false = 已经写过 403，直接 return。
 * 登录判定走 guest/identity.ts（JWT 校验通过才算登录，凭证无效按游客处理）。
 */
function allowGuest(req: Request, res: Response, feature: 'preview' | 'download'): boolean {
  const userId = userIdFromRequest(req)
  if (userId) return true
  if (loadGuestPermissions()[feature]) return true

  const label = feature === 'preview' ? '在线预览' : '下载原件'
  const code = feature === 'preview' ? 'GUEST_PREVIEW_CLOSED' : 'GUEST_DOWNLOAD_CLOSED'
  res.status(403).json(errorEnvelope(code, `${label}需要登录后使用，请先登录`, req))
  return false
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
    //
    // 🔴 T11-B：userId 一并带上（游客为 null）——看板 UV 的口径本就是
    //    「按 userId ?? sessionId 去重」，不带就等于把登录用户记成了匿名会话。
    if (query.q) {
      recordEvent({
        event: 'search',
        source: 'server',
        userId: userIdFromRequest(req),
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
 *
 * 🔴 T11：先过游客权限（默认游客可预览，关掉后未登录直接 403）；
 *    T11-B：埋点带上 userId（游客为 null），数据面板的「使用明细」才分得出账号。
 */
router.get(
  '/:id/preview',
  guard(async (req, res) => {
    if (!allowGuest(req, res, 'preview')) return
    const userId = userIdFromRequest(req)
    const file = await getFileStream(req.params.id, 'inline')
    recordEvent({
      event: 'preview',
      source: 'server',
      userId,
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

/**
 * 下载原件：文件名按契约「年份-机构-标题」；顺带埋一条 download（权威计数口径）。
 *
 * 🔴 T11：游客权限默认为**关**（下载是「拿走」，要留痕引导注册），未登录直接 403；
 *    T11-B：埋点带上 userId。
 */
router.get(
  '/:id/download',
  guard(async (req, res) => {
    if (!allowGuest(req, res, 'download')) return
    const userId = userIdFromRequest(req)
    const doc = await getDoc(req.params.id)
    const file = await getFileStream(req.params.id, 'attachment')
    const downloadName = buildDownloadName(doc)
    recordEvent({
      event: 'download',
      source: 'server',
      userId,
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
