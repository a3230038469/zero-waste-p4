/**
 * 资料数据层 —— 负责人：丁梓柔（B05 书架页）
 *
 * 统一走自建后端：GET /api/docs、GET /api/docs/facets、GET /api/docs/:id。
 * 返回结构见 docs/接口约定.md，页面代码不用动。
 *
 * 多选传法已按 2026-10-07 定稿实现：org/year/tag 重复传参（见 toHttpParams）。
 */
import http, { publicErrorText } from './http'
import type { DocItem, DocListResponse, FacetsResponse } from './types'

/**
 * 「未分类」方向的后端哨兵值（契约 C7 / P1-8）。
 *
 * 后端把**没有方向（srcTable）**的资料归到这个桶里，
 * 页面上显示中文「未分类」，点它就按 srcTable=__uncategorized__ 去筛。
 * 前端自己不要再另算一份「未分类」的数量 —— 口径以接口返回的为准。
 */
export const UNCATEGORIZED_SRC_TABLE = '__uncategorized__'

/** 方向桶的中文名：后端给了 label 就用后端的，没给就按哨兵值兜底成「未分类」 */
export function srcTableLabel(facet: { value: string; label?: string }): string {
  if (facet.value === UNCATEGORIZED_SRC_TABLE) return '未分类'
  return facet.label ?? facet.value
}

/** 资料详情（对齐 GET /api/docs/:id「单份资料完整信息」，含正文与原始出处） */
export interface DocDetail extends DocItem {
  /**
   * 内置正文。
   * ⚠️ 本地资料模式（读索引）下详情接口**不返回**该字段 —— 知识库以原件为准，
   *    不转载正文。页面必须按「可能没有」处理，否则整页会崩。
   */
  content?: string
  /**
   * 原始出处链接。
   * 注意：目录类资料（台账未登记来源链接）里这一项是空字符串，
   * 详情页遇到空串就不显示该行，而不是显示一个空链接。
   */
  sourceUrl?: string
}

/** 书架页查询参数（对齐接口约定，多选维度用数组承载） */
export interface DocListQuery {
  type?: string
  /**
   * 【T10】机构名**包含**这个关键词（单值文本式检索）。
   * 🔴 与 `orgs`（精确多选）是两套语义：这里传的就是用户在输入框里敲的那串字，
   *    回车才发请求。空 = 不过滤。原先的机构下拉与远程搜索已整体下线。
   */
  orgLike?: string
  years?: string[]
  tags?: string[]
  /** 【T8 追加】所属方向，多选。值是数据原值（如 `知识查询（零废弃）`），不是显示名 */
  srcTables?: string[]
  q?: string
  page?: number
  pageSize?: number
  sort?: 'year_desc' | 'newest'
}

/* ---------------- 后端接口 ---------------- */

/**
 * 把页面查询参数翻译成契约要求的形式（见 docs/接口约定.md 二·资料列表查询参数）。
 *
 * 差异点（照契约，不能想当然）：
 *   - 页面内部用 orgs/years/tags 承载多值 → 接口要的是**单数参数重复传**：org/year/tag
 *   - type 是单值 tab，直接透传
 *   - 数组必须用 `arrayFormat: 'repeat'` 序列化成 `org=a&org=b`；
 *     axios 默认会发成 `org[]=a&org[]=b`，后端按重复同名参数解析会一条都筛不出来
 */
const REPEAT_ARRAY = { paramsSerializer: { indexes: null } } as const

function toHttpParams(query: DocListQuery): Record<string, unknown> {
  return {
    type: query.type || undefined,
    // T10：机构只传 orgLike（单值文本式）。精确多选的 `org` 后端仍支持，
    // 但页面上的机构筛选已改文本式，这里不再发它（留着就是没人用的死参数）。
    orgLike: query.orgLike?.trim() || undefined,
    year: query.years?.length ? query.years : undefined,
    tag: query.tags?.length ? query.tags : undefined,
    srcTable: query.srcTables?.length ? query.srcTables : undefined,
    q: query.q?.trim() || undefined,
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort
  }
}

async function getDocsHttp(query: DocListQuery): Promise<DocListResponse> {
  const res = await http.get<DocListResponse>('/docs', { params: toHttpParams(query), ...REPEAT_ARRAY })
  return res.data
}

async function getFacetsHttp(query: DocListQuery): Promise<FacetsResponse> {
  const res = await http.get<FacetsResponse>('/docs/facets', { params: toHttpParams(query), ...REPEAT_ARRAY })
  return res.data
}

/* ------------------------------------------------------------------ *
 * 【T10 已删除】机构下拉的远程搜索
 * ------------------------------------------------------------------ *
 * 原先有 `searchOrgs()`（走 `/docs/facets?orgSearch=`）给机构下拉做远程搜索。
 * 机构的筛选已改成**文本式输入框**（输完按回车，按机构名包含匹配筛），
 * 这个函数全局确认已无调用方，随之下线 —— 留着就是死代码。
 * 后端的 `?orgSearch=` 参数**保留未删**（老接口，别的调用方可能还在用）。
 */

async function getDocDetailHttp(id: string): Promise<DocDetail | null> {
  const res = await http.get<DocDetail>(`/docs/${id}`, { silent: true })
  return res.data
}

/* ---------------- 预览 / 下载（B06） ---------------- */

/** 「文件较大」阈值：20MB */
export const LARGE_FILE_LIMIT = 20 * 1024 * 1024

/** 文件名非法字符清洗（Windows / macOS / Linux 通用） */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

/**
 * 下载文件名：年份-机构-标题（接口约定）。
 *
 * ⚠️ 扩展名只在**标题自身没有**时才补 `.pdf`。
 * 引擎来源的标题本身就是带扩展名的文件名（如 `13-优先控制化学品名录….pdf`），
 * 无条件拼 `.pdf` 会得到 `2020-机构-xxx.pdf.pdf`（后端 `buildDownloadName()`
 * 已修过同一个坑，这里与之保持同一口径，否则 `a.download` 会覆盖服务端给的名字）。
 */
export function buildDownloadFileName(doc: DocItem): string {
  const year = doc.year > 0 ? String(doc.year) : '年份待补'
  const source = sanitizeFileName(doc.title || '未命名')
  const dot = source.lastIndexOf('.')
  const stem = dot > 0 ? source.slice(0, dot) : source
  const ext = dot > 0 ? source.slice(dot) : '.pdf'
  return sanitizeFileName(`${year}-${doc.org || '机构待补'}-${stem}${ext}`)
}

/** 触发浏览器下载一个 Blob */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * 把「blob 方式请求失败」的响应翻译成**给用户看的中文**。
 *
 * 为什么需要：`responseType: 'blob'` 时 axios 把错误体也当二进制，
 * 统一拦截器读 `err.response.data.error.message` 只会拿到 undefined，
 * 最后弹给用户的是 `Request failed with status code 404` 这种没法看的文案。
 * 这里把 blob 读回文本、取出后端信封里的错误码与文案。
 *
 * ⚠️ 2026-10-21（task-20）：后端原文**不再**直接返回给用户 ——
 *    原文里可能带内部引擎地址、英文堆栈。原文只进 console.warn；
 *    展示给用户的是 publicErrorText（本地固定中文：错误码 → 状态码 → 兜底），
 *    必要的后端原因只取 publicErrorDetail（已过清洗：无 URL / IP / 端口 / 英文堆栈）。
 */
async function describeBlobError(err: unknown, fallback: string): Promise<string> {
  const response = (err as { response?: { status?: number; data?: unknown } })?.response
  const status = typeof response?.status === 'number' ? response.status : 0
  let code = ''
  let message = ''
  const data = response?.data
  if (data instanceof Blob) {
    try {
      const text = await data.text()
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
      code = typeof parsed?.error?.code === 'string' ? parsed.error.code : ''
      message = typeof parsed?.error?.message === 'string' ? parsed.error.message : ''
    } catch {
      // 不是 JSON（可能真是二进制内容）——走下面的兜底
    }
  }
  if (message) console.warn('[docs] blob 请求失败：', status || '-', code || '-', message)
  // 拼成 axios 形状，交给统一文案表翻译（后端原文只用来查错误码）
  const shaped = { response: { status, data: { error: { code, message } } } }
  // 面向公众：一律前端本地固定中文（后端原文只留在 console 里）
  return publicErrorText(shaped, fallback)
}

/** 下载原件（GET /api/docs/:id/download 文件流）
 *
 * 失败时抛 `Error`，message 是可直接展示给用户的中文；
 * `silent: true` 是为了不让统一拦截器再补一条 `Request failed with status code 404`。 */
export async function downloadDoc(doc: DocItem): Promise<void> {
  const fileName = buildDownloadFileName(doc)
  try {
    // 下载接口可能要求 Authorization，用 blob 方式下载以携带请求头
    const res = await http.get<Blob>(`/docs/${doc.id}/download`, {
      responseType: 'blob',
      silent: true
    })
    saveBlob(res.data, fileName)
  } catch (err) {
    throw new Error(await describeBlobError(err, '下载失败，请稍后再试或直接联系管理员'))
  }
}

/**
 * 获取在线预览地址（先取回文件再转 blob URL）。
 *
 * 为什么不是直接把接口地址丢给 iframe：iframe 拿不到 HTTP 状态码，
 * 接口报错时用户看到的是**框里一段 JSON**（云端演示版没有资料原件，
 * 预览必然 404），没有任何提示。这里先请求一次，失败就抛出中文原因，
 * 成功则转成 blob URL 交给 iframe。预览本身已由 LARGE_FILE_LIMIT 卡在 20MB 内，
 * 整份读进内存是可接受的。
 *
 * 调用方负责 revokeObjectURL（对非 blob URL 调用无副作用）。
 */
export async function getPreviewUrl(doc: DocItem): Promise<string> {
  try {
    const res = await http.get<Blob>(`/docs/${doc.id}/preview`, {
      responseType: 'blob',
      silent: true
    })
    return URL.createObjectURL(res.data)
  } catch (err) {
    throw new Error(await describeBlobError(err, '预览失败，请稍后再试或改用下载原件'))
  }
}

/* ---------------- 文件类型判断（T3 · 公-4） ---------------- */

/**
 * 从资料标题里取文件扩展名（小写，不含点）。
 * 资料标题本身就是文件名（引擎来源），所以扩展名只能从标题末尾取。
 */
export function docFileExtension(title: string): string {
  const raw = (title || '').trim()
  const dot = raw.lastIndexOf('.')
  if (dot < 0) return ''
  const ext = raw.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : ''
}

/**
 * 这份资料是不是 PDF —— 只有 PDF 能在线预览。
 * 2026-10-21（T3 · 公-4）：以前只按体积判断，.docx / .txt 也给「预览」按钮，
 * 点进去是一片空白，或 pdf.js 甩一句英文报错。现在按扩展名判断。
 */
export function isPdfTitle(title: string): boolean {
  return docFileExtension(title) === 'pdf'
}

/* ---------------- 详情读取失败的分流（T3 · P1-11） ---------------- */

/** 详情读取失败的几种情况 —— 页面上要给不同的说法，不能一律说「资料不存在」 */
export type DocDetailErrorKind = 'not-found' | 'forbidden' | 'server' | 'network' | 'unknown'

export interface DocDetailError {
  kind: DocDetailErrorKind
  message: string
}

/**
 * 把详情接口的报错翻译成「读者看得懂的一句话」。
 *
 * 为什么要分这么细：以前 404 与 502 都说成「资料不存在」，
 * 服务器明明坏了，读者却以为是自己链接错了，跑去一个个换链接试。
 * 现在 404 说「资料不存在」、5xx 说「服务器暂时出了点问题」、断网说「连不上服务器」。
 */
export function describeDocDetailError(err: unknown): DocDetailError {
  const response = (err as { response?: { status?: number; data?: { error?: { code?: string; message?: string } } } })
    ?.response
  const status = response?.status
  const code = response?.data?.error?.code
  const backendMessage = response?.data?.error?.message

  if (status === 404 || code === 'DOC_NOT_FOUND') {
    return { kind: 'not-found', message: '这份资料不存在，可能已下架，或者链接有误。' }
  }
  if (status === 403) {
    return { kind: 'forbidden', message: '你没有权限查看这份资料。' }
  }
  // 2026-10-21（T3 · P1-11）：后端目前把「引擎查无此资料」（引擎 404）统一包成 502 回给前端，
  // 错误码是 ENGINE_BAD_STATUS。今天先在前端认出来，别让读者以为服务器坏了。
  // 后端把引擎 404 映射成 404 / DOC_NOT_FOUND 之后，这段自动失效（走上面的 not-found 分支）。
  if (code === 'ENGINE_BAD_STATUS' && typeof backendMessage === 'string' && backendMessage.includes('404')) {
    return { kind: 'not-found', message: '这份资料不存在，可能已下架，或者链接有误。' }
  }
  if (typeof status === 'number' && status >= 500) {
    // 后端给的原文可能带内部引擎地址（例：「引擎返回 404：http://localhost:8080/api/v1/knowledge/xxx」），
    // 那是给开发看的，不能摆到公众页面上 —— 只在控制台留痕，页面上给一句通用中文。
    if (backendMessage) console.warn('[docs] 详情读取失败：', status, code, backendMessage)
    return {
      kind: 'server',
      message: '服务器暂时出了点问题，这份资料没能读出来。请稍后再试，或直接下载原件。'
    }
  }
  if (!status) {
    return { kind: 'network', message: '连不上服务器，请检查网络后重试。' }
  }
  if (backendMessage) console.warn('[docs] 详情读取失败：', status, code, backendMessage)
  return { kind: 'unknown', message: '资料没能读出来，请稍后再试。' }
}

/* ---------------- 对外出口 ---------------- */

export function getDocs(query: DocListQuery): Promise<DocListResponse> {
  return getDocsHttp(query)
}

export function getFacets(query: DocListQuery): Promise<FacetsResponse> {
  return getFacetsHttp(query)
}

export function getDocDetail(id: string): Promise<DocDetail | null> {
  return getDocDetailHttp(id)
}
