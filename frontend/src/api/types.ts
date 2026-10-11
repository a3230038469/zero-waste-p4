/**
 * 前端类型定义 —— 字段名照 docs/接口约定.md，不许改
 */

export interface DocItem {
  id: string
  title: string
  org: string
  year: number
  type: string
  tags: string[]
  size: number
  /** 可选：这份与另一份内容完全相同（SHA-256 一致）时，给出建议保留的那一份的 id */
  duplicateOf?: string
}

export interface DocListResponse {
  total: number
  page: number
  pageSize: number
  zeroResult: boolean
  items: DocItem[]
}

export interface FacetItem {
  value: string
  count: number
}

export interface FacetsResponse {
  types: FacetItem[]
  orgs: FacetItem[]
  years: FacetItem[]
  tags: FacetItem[]
}

export interface CurrentUser {
  id: string
  name: string
  org: string
  occupation: string
  topics: string[]
  phone: string
}

/* ---------------- 整库概览（GET /api/overview） ---------------- */

export interface YearBucket {
  value: string
  count: number
  bytes: number
}

export interface DocOverview {
  generatedAt: string
  /** 资料总份数（含重复副本） */
  total: number
  /** 去重后的份数 */
  uniqueTotal: number
  duplicateGroups: number
  duplicateCopies: number
  totalBytes: number
  orgCount: number
  typeCount: number
  topicCount: number
  /** 带主题标签的份数 */
  topicCovered: number
  yearRange: { min: number; max: number } | null
  /** 年份缺失的份数 */
  yearUnknown: number
  types: FacetItem[]
  topics: FacetItem[]
  years: FacetItem[]
  topOrgs: FacetItem[]
  yearBuckets: YearBucket[]
  latest: DocItem[]
}
