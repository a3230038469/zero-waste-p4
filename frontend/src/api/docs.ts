/**
 * 资料数据层 —— 负责人：丁梓柔（B05 书架页）
 * 当前为假数据实现（后端接口未就绪），返回结构与
 * GET /api/docs、GET /api/docs/facets 完全一致（见 docs/接口约定.md）。
 * 后端就绪后：把下面 USE_MOCK 改为 false 即接入真实接口，页面代码不用动。
 *
 * ⚠️ 未决问题：本页「机构/年份/主题」是多选，接口约定里目前只有单数
 *    `tag` 参数。切真实接口前需和韶茹确认多选参数的传法
 *    （如 tag=a&tag=b 重复传参），并同步更新 docs/接口约定.md。
 */
import http from './http'
import type { DocItem, DocListResponse, FacetItem, FacetsResponse } from './types'

/** 后端接口就绪后改为 false */
const USE_MOCK = true

/** 资料详情（对齐 GET /api/docs/:id「单份资料完整信息」，含正文） */
export interface DocDetail extends DocItem {
  content: string
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

const ORG_POOL = ['零萌公益', '生态环境部', '住房和城乡建设部', '自然之友', '深圳市城市管理和综合执法局', '中国城市环境卫生协会']

const TAG_POOL = ['垃圾分类', '厨余处理', '循环经济', '塑料治理', '堆肥', '无废城市', '回收利用', '政策解读']

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
  return [...map.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)
}

function countByTag(docs: DocItem[]): FacetItem[] {
  const map = new Map<string, number>()
  for (const d of docs) {
    for (const t of d.tags) {
      map.set(t, (map.get(t) ?? 0) + 1)
    }
  }
  return [...map.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)
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
    years: countByValue(without('years'), (d) => String(d.year)).sort((a, b) => b.value.localeCompare(a.value)),
    tags: countByTag(without('tags')),
    types: countByValue(MOCK_DOCS, (d) => d.type)
  }
}

/* ---------------- 真实接口（就绪后启用） ---------------- */

async function getDocsHttp(query: DocListQuery): Promise<DocListResponse> {
  const res = await http.get<DocListResponse>('/docs', { params: query })
  return res.data
}

async function getFacetsHttp(query: DocListQuery): Promise<FacetsResponse> {
  const res = await http.get<FacetsResponse>('/docs/facets', { params: query })
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

/** 下载文件名：年份-机构-标题（接口约定） */
export function buildDownloadFileName(doc: DocItem): string {
  return sanitizeFileName(`${doc.year}-${doc.org}-${doc.title}`)
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

/** 下载原件（mock：前端生成的 PDF；真实：GET /api/docs/:id/download 文件流） */
export async function downloadDoc(doc: DocItem): Promise<void> {
  const fileName = `${buildDownloadFileName(doc)}.pdf`
  if (USE_MOCK) {
    await delay(300)
    saveBlob(buildMockPdf(doc), fileName)
    return
  }
  // 真实接口可能要求 Authorization，用 blob 方式下载以携带请求头
  const res = await http.get<Blob>(`/docs/${doc.id}/download`, { responseType: 'blob' })
  saveBlob(res.data, fileName)
}

/**
 * 获取在线预览地址（mock：blob URL；真实：后端预览接口）。
 * ⚠️ 未决问题：iframe 无法携带 Authorization 头，真实接口需支持
 *    query 传 token 或匿名预览，需与韶茹确认后调整。
 * 调用方负责 revokeObjectURL（对非 blob URL 调用无副作用）。
 */
export async function getPreviewUrl(doc: DocItem): Promise<string> {
  if (USE_MOCK) {
    await delay(300)
    return URL.createObjectURL(buildMockPdf(doc))
  }
  return `${http.defaults.baseURL}/docs/${doc.id}/preview`
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
