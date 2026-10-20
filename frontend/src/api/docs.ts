/**
 * 资料数据层 —— 负责人：丁梓柔（B05 书架页）
 *
 * 两种实现，由下面的 USE_MOCK 开关切换：
 *   - true  ：内置假数据（后端未起时也能开发页面）
 *   - false ：调自建后端 GET /api/docs、GET /api/docs/facets
 * 返回结构两者完全一致（见 docs/接口约定.md），页面代码不用动。
 *
 * 多选传法已按 2026-10-07 定稿实现：org/year/tag 重复传参（见 toHttpParams）。
 */
import http from './http'
import type { DocItem, DocListResponse, FacetItem, FacetsResponse } from './types'

/** 接真实后端时改为 false（联调前必切，否则页面显示的是假数据） */
const USE_MOCK = false

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
  orgs?: string[]
  years?: string[]
  tags?: string[]
  q?: string
  page?: number
  pageSize?: number
  sort?: 'year_desc' | 'newest'
}

/* ---------------- 假数据 ---------------- */

const TYPE_TABS = ['政策法规', '案例工具', '研究报告', '标准规范']

const TITLE_POOL = [
  '城市生活垃圾分类制度实施方案',
  '咖啡渣堆肥家庭操作指南',
  '零废弃社区建设白皮书',
  '厨余垃圾资源化利用研究报告',
  '生活垃圾焚烧污染控制标准',
  '校园垃圾减量实践案例集',
  '再生资源回收体系建设指南',
  '塑料污染治理三年行动方案',
  '社区堆肥试点项目总结报告',
  '无废城市建设指标体系解读',
  '快递包装绿色循环案例研究',
  '大件垃圾收运处理规范',
  '写字楼垃圾分类激励机制案例',
  '农村生活垃圾治理技术导则',
  '可回收物细分目录与投放指引',
  '旧衣回收再利用产业链报告',
  '餐厨垃圾就地处理设备选型指南',
  '有害垃圾收运安全管理规范',
  '零废弃办公评估工具与模板',
  '一次性塑料制品替代方案研究',
  '园林废弃物粉碎还田技术指南',
  '城市环卫设施布局规划标准',
  '二手市集运营手册',
  '垃圾焚烧飞灰处置技术规范'
]

const ORG_POOL = [
  '零萌公益',
  '生态环境部',
  '住房和城乡建设部',
  '自然之友',
  '深圳市城市管理和综合执法局',
  '中国城市环境卫生协会'
]

const TAG_POOL = [
  '垃圾分类',
  '厨余处理',
  '循环经济',
  '塑料治理',
  '堆肥',
  '无废城市',
  '回收利用',
  '政策解读'
]

function buildMockDocs(): DocItem[] {
  const items: DocItem[] = []
  for (let i = 0; i < 72; i++) {
    items.push({
      id: `k-${i + 1}`,
      title: TITLE_POOL[i % TITLE_POOL.length],
      org: ORG_POOL[i % ORG_POOL.length],
      year: 2025 - (i % 7),
      type: TYPE_TABS[i % TYPE_TABS.length],
      tags: [TAG_POOL[i % TAG_POOL.length], TAG_POOL[(i * 3 + 1) % TAG_POOL.length]],
      // k-2 故意造一个 25MB 大文件，便于测试「超过 20MB 提示」
      size: i === 1 ? 25 * 1024 * 1024 + 12345 : 120000 + ((i * 37021) % 3800000)
    })
  }
  return items
}

const MOCK_DOCS = buildMockDocs()

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function filterDocs(docs: DocItem[], query: DocListQuery): DocItem[] {
  let result = docs
  if (query.type) {
    result = result.filter((d) => d.type === query.type)
  }
  const orgs = query.orgs ?? []
  if (orgs.length > 0) {
    result = result.filter((d) => orgs.includes(d.org))
  }
  const years = query.years ?? []
  if (years.length > 0) {
    result = result.filter((d) => years.includes(String(d.year)))
  }
  const tags = query.tags ?? []
  if (tags.length > 0) {
    result = result.filter((d) => tags.some((t) => d.tags.includes(t)))
  }
  const q = query.q?.trim()
  if (q) {
    result = result.filter((d) => d.title.includes(q) || d.org.includes(q))
  }
  return result
}

function countByValue(docs: DocItem[], pick: (d: DocItem) => string): FacetItem[] {
  const map = new Map<string, number>()
  for (const d of docs) {
    const key = pick(d)
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
}

function countByTag(docs: DocItem[]): FacetItem[] {
  const map = new Map<string, number>()
  for (const d of docs) {
    for (const t of d.tags) {
      map.set(t, (map.get(t) ?? 0) + 1)
    }
  }
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
}

/** 假数据版：资料列表（结构对齐 DocListResponse） */
async function getDocsMock(query: DocListQuery): Promise<DocListResponse> {
  await delay(400) // 模拟网络延迟，便于观察骨架屏
  const filtered = filterDocs(MOCK_DOCS, query)
  const sorted = [...filtered].sort((a, b) =>
    query.sort === 'newest' ? Number(b.id.slice(2)) - Number(a.id.slice(2)) : b.year - a.year
  )
  const page = query.page ?? 1
  const pageSize = Math.min(query.pageSize ?? 20, 100)
  const start = (page - 1) * pageSize
  return {
    total: sorted.length,
    page,
    pageSize,
    zeroResult: sorted.length === 0,
    items: sorted.slice(start, start + pageSize)
  }
}

/** 假数据版：筛选项。每个维度的计数排除该维度自身的选择（保证计数与实际筛选结果一致） */
async function getFacetsMock(query: DocListQuery): Promise<FacetsResponse> {
  await delay(200)
  const without = (dim: 'orgs' | 'years' | 'tags'): DocItem[] =>
    filterDocs(MOCK_DOCS, { ...query, [dim]: undefined })
  return {
    orgs: countByValue(without('orgs'), (d) => d.org),
    years: countByValue(without('years'), (d) => String(d.year)).sort((a, b) =>
      b.value.localeCompare(a.value)
    ),
    tags: countByTag(without('tags')),
    types: countByValue(MOCK_DOCS, (d) => d.type)
  }
}

/* ---------------- 真实接口（就绪后启用） ---------------- */

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
    org: query.orgs?.length ? query.orgs : undefined,
    year: query.years?.length ? query.years : undefined,
    tag: query.tags?.length ? query.tags : undefined,
    q: query.q?.trim() || undefined,
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort
  }
}

async function getDocsHttp(query: DocListQuery): Promise<DocListResponse> {
  const res = await http.get<DocListResponse>('/docs', {
    params: toHttpParams(query),
    ...REPEAT_ARRAY
  })
  return res.data
}

async function getFacetsHttp(query: DocListQuery): Promise<FacetsResponse> {
  const res = await http.get<FacetsResponse>('/docs/facets', {
    params: toHttpParams(query),
    ...REPEAT_ARRAY
  })
  return res.data
}

async function getDocDetailHttp(id: string): Promise<DocDetail | null> {
  const res = await http.get<DocDetail>(`/docs/${id}`, { silent: true })
  return res.data
}

/** 假数据版：资料详情，找不到返回 null（页面显示 404） */
async function getDocDetailMock(id: string): Promise<DocDetail | null> {
  await delay(400)
  const doc = MOCK_DOCS.find((d) => d.id === id)
  if (!doc) {
    return null
  }
  return {
    ...doc,
    content: [
      `${doc.title}（${doc.org}，${doc.year}年发布）。本文档属于「${doc.type}」类别，围绕${doc.tags.join('、')}等议题展开。`,
      '零废弃理念强调从源头减少废弃物的产生，通过分类、回收与资源化利用，让物料在城市系统中循环流动，而非直接进入填埋或焚烧。',
      '本资料系统梳理了相关政策要求、实践案例与可操作的工具方法，供社区工作者、行业从业者与研究者参考使用。',
      '如需引用本资料中的数据或结论，请注明原始出处。完整内容可通过在线预览或下载原件查阅。'
    ].join('\n\n')
  }
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

/** 前端生成最小可渲染 PDF（假数据用，英文内容避免内嵌中文字体） */
function buildMockPdf(doc: DocItem): Blob {
  const esc = (s: string): string => s.replace(/([\\()])/g, '\\$1')
  const lines = [
    'Zero-Waste Knowledge Base',
    '',
    `Document ID: ${doc.id}`,
    `Year: ${doc.year}`,
    `File size: ${(doc.size / 1024 / 1024).toFixed(1)} MB`,
    '',
    'This is a mock PDF generated by the frontend.',
    'It will be replaced by GET /api/docs/:id/preview',
    'when the backend is ready.'
  ]
  const stream = `BT\n/F1 16 Tf\n${lines
    .map((l, i) => `${i === 0 ? '72 770 Td' : '0 -26 Td'} (${esc(l)}) Tj`)
    .join('\n')}\nET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefPos = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  return new Blob([pdf], { type: 'application/pdf' })
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
 * 把「blob 方式请求失败」的响应还原成后端给的中文提示。
 *
 * 为什么需要：`responseType: 'blob'` 时 axios 把错误体也当二进制，
 * 统一拦截器读 `err.response.data.error.message` 只会拿到 undefined，
 * 最后弹给用户的是 `Request failed with status code 404` 这种没法看的文案。
 * 这里把 blob 读回文本、尝试解析后端信封 `{success:false,error:{message}}`，
 * 拿不到再退回一句人话。
 */
async function describeBlobError(err: unknown, fallback: string): Promise<string> {
  const data = (err as { response?: { data?: unknown } })?.response?.data
  if (data instanceof Blob) {
    try {
      const text = await data.text()
      const parsed = JSON.parse(text) as { error?: { message?: string } }
      const message = parsed?.error?.message
      if (typeof message === 'string' && message.trim()) return message
    } catch {
      // 不是 JSON（可能真是二进制内容）——走下面的兜底
    }
  }
  return fallback
}

/** 下载原件（mock：前端生成的 PDF；真实：GET /api/docs/:id/download 文件流）
 *
 * 失败时抛 `Error`，message 是可直接展示给用户的中文；
 * `silent: true` 是为了不让统一拦截器再补一条 `Request failed with status code 404`。 */
export async function downloadDoc(doc: DocItem): Promise<void> {
  const fileName = buildDownloadFileName(doc)
  if (USE_MOCK) {
    await delay(300)
    saveBlob(buildMockPdf(doc), fileName)
    return
  }
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
 * 获取在线预览地址（mock：blob URL；真实：先取回文件再转 blob URL）。
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
  if (USE_MOCK) {
    await delay(300)
    return URL.createObjectURL(buildMockPdf(doc))
  }
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

/* ---------------- 对外出口 ---------------- */

export function getDocs(query: DocListQuery): Promise<DocListResponse> {
  return USE_MOCK ? getDocsMock(query) : getDocsHttp(query)
}

export function getFacets(query: DocListQuery): Promise<FacetsResponse> {
  return USE_MOCK ? getFacetsMock(query) : getFacetsHttp(query)
}

export function getDocDetail(id: string): Promise<DocDetail | null> {
  return USE_MOCK ? getDocDetailMock(id) : getDocDetailHttp(id)
}
