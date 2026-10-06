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
