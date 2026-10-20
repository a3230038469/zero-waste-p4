/**
 * 看板分析接口客户端 —— 2026-10-19 新增（数据看板重设计）
 *
 * 为什么单独一个文件、而不是塞进 api/admin.ts：
 *   这两个接口是**给看板与分析用的聚合口径**（不是资料/用户/设置那类管理 CRUD），
 *   单独一份便于看板与「使用明细」抽屉共用，也避免和 admin.ts 的既有导出混在一起。
 *
 * 后端契约见 docs/接口约定.md；两者字段名逐项对应，前端不自己造别名。
 * 鉴权走 http.ts 的拦截器（Authorization: Bearer <登录凭证>），后端查账号 role。
 */
import http from './http'

/** 一天的聚合点（区间内每一天都有，没数据的那天给 0） */
export interface AnalyticsDailyPoint {
  date: string
  events: number
  pv: number
  uv: number
  searches: number
  previews: number
  downloads: number
  asks: number
}

export interface AnalyticsTotals {
  events: number
  pv: number
  uv: number
  searches: number
  previews: number
  downloads: number
  asks: number
  registers: number
  feedbacks: number
}

/** 未登录访客的合计（userId 为空的那部分，单列不混进账号排行） */
export type AnalyticsGuestTotals = Omit<AnalyticsTotals, 'uv' | 'registers' | 'feedbacks'>

export interface AnalyticsUserRow {
  userId: string
  name: string
  org: string
  events: number
  pv: number
  searches: number
  previews: number
  downloads: number
  asks: number
  /** 最近一次事件时刻（ISO） */
  lastSeen: string
}

export interface CountItem {
  count: number
}

export interface AnalyticsPayload {
  success: true
  generatedAt: string
  range: { days: number; from: string; to: string }
  totals: AnalyticsTotals
  guest: AnalyticsGuestTotals
  daily: AnalyticsDailyPoint[]
  hourly: { hour: number; events: number }[]
  weekday: { weekday: number; events: number; label: string }[]
  funnel: { pv: number; searches: number; previews: number; downloads: number; asks: number }
  search: {
    total: number
    zero: number
    zeroRate: number
    top: { term: string; count: number }[]
    zeroTerms: { term: string; count: number }[]
  }
  downloads: { server: number; events: number; top: { docId: string; fileName: string; count: number }[] }
  asks: { total: number; judged: number; noAnswer: number; unjudged: number; noAnswerRate: number }
  users: AnalyticsUserRow[]
}

/**
 * 读最近 N 天的分析数据。
 * 想看「本期 vs 上期」，就按天数 ×2 取，再在前端切成前后两段（后端只认一个区间）。
 */
export async function fetchAnalytics(days: number): Promise<AnalyticsPayload> {
  const res = await http.get<AnalyticsPayload>('/admin/analytics', {
    params: { days },
    silent: true
  })
  return res.data
}

/** 使用明细里的一条记录（账号级） */
export interface UserActivityItem {
  ts: string
  /** page_view / search / preview / download / ai_ask / register / feedback_submit */
  event: string
  /** 中文标签（后端给，前端不再翻译一遍） */
  label: string
  /** 可读摘要：AI 提问原文 / 检索词 / 文件名 / 页面路径 */
  detail: string
  docId: string
  fileName: string
  /** 仅 ai_ask 有意义：true 答不上来、false 有答案、null 未判定 */
  noAnswer: boolean | null
  path: string
}

export interface UserActivityPayload {
  success: true
  userId: string
  name: string
  org: string
  total: number
  page: number
  pageSize: number
  items: UserActivityItem[]
}

export type ActivityEventFilter = 'all' | 'page_view' | 'search' | 'preview' | 'download' | 'ai_ask'

/** 游客那一组用这个固定值请求（后端把 userId 为空的记录归到它） */
export const GUEST_ACTIVITY_ID = '__guest__'

/**
 * 读某个账号的逐条使用记录（分页、倒序）。
 * 未知账号返回 total 0 + 空数组，不报错 —— 前端据此显示空态。
 */
export async function fetchUserActivity(params: {
  userId: string
  event?: ActivityEventFilter
  page?: number
  pageSize?: number
  days?: number
}): Promise<UserActivityPayload> {
  const res = await http.get<UserActivityPayload>('/admin/user-activity', {
    params: {
      userId: params.userId,
      ...(params.event && params.event !== 'all' ? { event: params.event } : {}),
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 20,
      ...(params.days ? { days: params.days } : {})
    },
    silent: true
  })
  return res.data
}
