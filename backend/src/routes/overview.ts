/**
 * 数据概览接口 —— 新增（2026-10-10）
 *
 *   GET /api/overview   知识库整体画像：总量 / 覆盖年份 / 机构数 / 主题分布 / 类型分布 / 最新收录
 *
 * 为什么单独开一条：
 *   对外展示站的首页与「数据概览」页要展示整库统计。若让前端拉 617 条自己算，
 *   一是慢（617 条 × 每页 20 条要翻 31 页），二是每次访问都重复算一遍。
 *   统计在服务端做一次、缓存结果，是最省事也最省流量的做法。
 *
 * 为什么单独开一个文件、不用 docs.ts：
 *   docs.ts 是「资料列表/详情/预览/下载」的归属文件，本接口与那四条职责不同，
 *   单开一个文件可以完全不动既有路由的行为（回退只需摘掉 index.ts 里的一行挂载）。
 *
 * 数据源：与资料列表同源（listFiles()），所以 local / snapshot / engine 三种模式都自动适用。
 */
import { Router, type Request, type Response } from 'express'

import { EngineError, listFiles, type FacetItem, type KbDoc, type KbDocInternal } from '../weknora/index.js'
import { duplicateOf } from '../data/duplicates.js'

const router = Router()

/** 年份桶：近 10 年逐年，更早的合并成「更早」 */
const RECENT_YEARS = 10

interface YearBucket {
  value: string
  count: number
  /** 该年资料总体积（字节），用于做「体量」而不是「份数」的对比 */
  bytes: number
}

interface OverviewResponse {
  generatedAt: string
  /** 资料总份数（含重复副本） */
  total: number
  /** 去掉重复副本后的份数 */
  uniqueTotal: number
  /** 重复内容组数 */
  duplicateGroups: number
  /** 重复副本份数 */
  duplicateCopies: number
  /** 全部文件总体积（字节） */
  totalBytes: number
  /** 发布机构去重数量 */
  orgCount: number
  /** 知识类型数量 */
  typeCount: number
  /** 主题（知识领域）数量 */
  topicCount: number
  /** 带主题标签的资料份数 */
  topicCovered: number
  /** 年份区间；全部缺年份时为 null */
  yearRange: { min: number; max: number } | null
  /** 年份缺失的份数（台账未填） */
  yearUnknown: number
  types: FacetItem[]
  topics: FacetItem[]
  years: FacetItem[]
  topOrgs: FacetItem[]
  yearBuckets: YearBucket[]
  /** 最新收录（按年份倒序取前 6 份） */
  latest: KbDoc[]
}

function countBy(docs: KbDocInternal[], values: (doc: KbDocInternal) => string[]): FacetItem[] {
  const counter = new Map<string, number>()
  for (const doc of docs) {
    for (const value of values(doc)) {
      if (!value) continue
      counter.set(value, (counter.get(value) ?? 0) + 1)
    }
  }
  return [...counter.entries()].map(([value, count]) => ({ value, count }))
}

function byCountThenValue(a: FacetItem, b: FacetItem): number {
  return b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN')
}

function byYearDesc(a: FacetItem, b: FacetItem): number {
  return Number(b.value) - Number(a.value)
}

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

/** id 形如 k-35；排序时按数字后缀走 */
function idOrder(doc: KbDocInternal): number {
  const parsed = Number(doc.id.replace(/^\D+/, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 首页「最新收录」去重用的标题键：把结尾括号里的后缀去掉。
 *
 * 起因：库里有一批「正文 + 摘要」「完整版 + 简版」的成对文件，标题只差结尾的
 * 「（摘要）」「（简版）」。它们**不是重复文件**（内容确实不同），所以不能按
 * duplicateOf 过滤；但连着出现在首页上，看起来就像同一份被列了两次。
 * 这里只在**首页挑选**时按去括号后的标题去重，数据与资料库列表完全不受影响。
 */
function titleKey(title: string): string {
  return title
    .replace(/[(（][^)）]*[)）]\s*$/, '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
}

function buildOverview(docs: KbDocInternal[]): OverviewResponse {
  const total = docs.length

  // 按精确 size (字节) 分组计算重复——不再使用 kb-duplicates.json
  const sizeGroups = new Map<number, KbDocInternal[]>()
  for (const doc of docs) {
    const sz = doc.size
    if (!sizeGroups.has(sz)) sizeGroups.set(sz, [])
    sizeGroups.get(sz)!.push(doc)
  }
  // 重复副本份数：每组里，除保留件外其余全部算作副本
  let duplicateCopies = 0
  let duplicateGroups = 0
  for (const [, group] of sizeGroups) {
    if (group.length > 1) {
      duplicateGroups += 1
      duplicateCopies += group.length - 1
    }
  }

  // 年份：0 表示「台账未填」，单列出来，不混进年份序列（否则图表上会出现一个 0 年的柱子）
  const dated = docs.filter((d) => d.year > 0)
  const years = [...new Set(dated.map((d) => d.year))].sort((a, b) => a - b)
  const yearRange = years.length > 0 ? { min: years[0] as number, max: years[years.length - 1] as number } : null

  // 年份桶：最近 RECENT_YEARS 年逐年 + 更早合并
  const buckets: YearBucket[] = []
  if (yearRange) {
    const from = Math.max(yearRange.min, yearRange.max - RECENT_YEARS + 1)
    for (let y = from; y <= yearRange.max; y += 1) {
      const ofYear = dated.filter((d) => d.year === y)
      buckets.push({
        value: String(y),
        count: ofYear.length,
        bytes: ofYear.reduce((sum, d) => sum + d.size, 0)
      })
    }
    const older = dated.filter((d) => d.year < from)
    if (older.length > 0) {
      buckets.unshift({
        value: `${from - 1} 及更早`,
        count: older.length,
        bytes: older.reduce((sum, d) => sum + d.size, 0)
      })
    }
  }

  // 最新收录：按年份倒序取前 6 份，**并去掉重复副本**。
  // 首页是用来「展示这份库有什么」的，同一份内容连着出现两次会显得库很乱；
  // 副本本身仍在资料库里可查（卡片上带标注），只是不上首页。
  // 另外按 titleKey 去重：把「正文 / 摘要」「完整版 / 简版」这类成对文件错开，
  // 免得首页上并排两张卡片看起来一模一样（它们内容其实不同，只是标题差个括号）。
  const seenTitles = new Set<string>()
  const latest: KbDocInternal[] = []
  for (const doc of [...docs].sort((a, b) => b.year - a.year || idOrder(b) - idOrder(a))) {
    if (duplicateOf(doc.id)) continue
    const key = titleKey(doc.title)
    if (seenTitles.has(key)) continue
    seenTitles.add(key)
    latest.push(doc)
    if (latest.length >= 6) break
  }

  return {
    generatedAt: new Date().toISOString(),
    total,
    uniqueTotal: Math.max(0, total - duplicateCopies),
    duplicateGroups,
    duplicateCopies,
    totalBytes: docs.reduce((sum, d) => sum + d.size, 0),
    orgCount: new Set(docs.map((d) => d.org)).size,
    typeCount: new Set(docs.map((d) => d.type)).size,
    topicCount: new Set(docs.flatMap((d) => d.tags)).size,
    topicCovered: docs.filter((d) => d.tags.length > 0).length,
    yearRange,
    yearUnknown: total - dated.length,
    types: countBy(docs, (d) => [d.type]).sort(byCountThenValue),
    topics: countBy(docs, (d) => d.tags).sort(byCountThenValue),
    years: countBy(docs, (d) => [String(d.year)]).sort(byYearDesc),
    topOrgs: countBy(docs, (d) => [d.org]).sort(byCountThenValue).slice(0, 10),
    yearBuckets: buckets,
    latest: latest.map(toPublicDoc)
  }
}

/* ------------------------------------------------------------------ *
 * 统一错误出口（与 docs.ts 同一信封，前端拦截器只需认一种形状）
 * ------------------------------------------------------------------ */

function sendError(res: Response, err: unknown, req?: { requestId?: string }): void {
  if (err instanceof EngineError) {
    res.status(err.status).json({ success: false, error: { code: err.code, message: err.message } })
    return
  }
  const message = err instanceof Error ? err.message : '服务器内部错误'
  console.error(`[overview] 内部错误: ${message}, requestId: ${req?.requestId || 'unknown'}`)
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: '资料统计暂时不可用，请稍后再试' } })
}

router.get('/', (_req: Request, res: Response) => {
  void (async () => {
    try {
      const docs = await listFiles()
      res.json(buildOverview(docs))
    } catch (err) {
      sendError(res, err, _req)
    }
  })()
})

export default router
