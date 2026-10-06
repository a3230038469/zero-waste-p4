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
      size: 120000 + ((i * 37021) % 3800000)
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
