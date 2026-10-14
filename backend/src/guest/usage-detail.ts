/**
 * 「使用明细」聚合 —— T11-C（2026-10-14 新增）
 *
 * 数据源：backend/data/track/events.jsonl（经 track/store.ts 的 readEvents 现读）
 * 只统计三类事件：ai_ask / preview / download，按 userId 分组。
 *
 * 🔴 为什么「游客」不存字符串：存储层仍然是 userId=null（null 才是「匿名」的唯一真相），
 *    「游客」这个词**只在展示层出现**（rows[].name），别去污染埋点数据。
 *
 * 🔴 历史数据追不回：本模块上线之前写入的事件 userId 全是 null，
 *    所以某一天的历史记录会整列落在「游客」组里 —— 这是数据事实，不是统计口径变了。
 */
import type { StoredEvent } from '../track/types.js'
import { localDateKey } from './ask-usage.js'

/** 计入「使用明细」的三类事件（其余事件不进这张表） */
export const USAGE_EVENTS = ['ai_ask', 'preview', 'download'] as const

export type UsageEvent = (typeof USAGE_EVENTS)[number]

/** 表里的一行 = 一个账号（游客单独成一组） */
export interface UsageRow {
  /** null = 游客 */
  userId: string | null
  name: string
  org: string
  ai_ask: number
  preview: number
  download: number
  total: number
}

/** GET /api/admin/usage-detail 的响应体 */
export interface UsageDetailResponse {
  success: true
  /** YYYY-MM-DD（本地时区） */
  date: string
  rows: UsageRow[]
  totals: {
    ai_ask: number
    preview: number
    download: number
  }
}

/** 账号档案（从 SQLite 的 User 表补上；查不到就留空，不报错） */
export type UserDirectory = Map<string, { name: string; org: string }>

function emptyCounts(): Record<UsageEvent, number> {
  return { ai_ask: 0, preview: 0, download: 0 }
}

/** 聚合过程中的一组（账号 id + 三项计数 + 合计） */
interface UsageGroup {
  userId: string | null
  counts: Record<UsageEvent, number>
  total: number
}

/**
 * 聚合某一天的使用明细。
 *
 * - 按事件里的 ts 切当天（**本地时区**，与看板趋势同口径）；
 * - 坏数据（ts 解析不出来）直接跳过，绝不让一行脏数据毁掉整张表；
 * - 排序：合计降序，**游客组固定排最后**（它是兜底组，不是「某个账号」）。
 */
export function buildUsageDetail(
  events: StoredEvent[],
  date: string,
  users: UserDirectory = new Map()
): UsageDetailResponse {
  const groups = new Map<string, UsageGroup>()

  for (const evt of events) {
    if (!isUsageEvent(evt.event)) continue
    const parsed = new Date(evt.ts)
    if (Number.isNaN(parsed.getTime())) continue
    if (localDateKey(parsed) !== date) continue

    // null（游客）单独用一个不可能与 userId 撞上的键
    const userId = evt.userId || null
    const key = userId ?? '__guest__'
    const group = groups.get(key) ?? { userId, counts: emptyCounts(), total: 0 }
    group.counts[evt.event] += 1
    group.total += 1
    groups.set(key, group)
  }

  const rows: UsageRow[] = [...groups.values()].map((group) => {
    const base = {
      ai_ask: group.counts.ai_ask,
      preview: group.counts.preview,
      download: group.counts.download,
      total: group.total
    }
    if (!group.userId) {
      // 「游客」这两个字只在这里出现（展示层），存储层仍然是 null
      return { userId: null, name: '游客', org: '', ...base }
    }
    const profile = users.get(group.userId)
    return { userId: group.userId, name: profile?.name ?? '', org: profile?.org ?? '', ...base }
  })

  rows.sort((a, b) => {
    if (a.userId === null) return b.userId === null ? 0 : 1
    if (b.userId === null) return -1
    return b.total - a.total || a.name.localeCompare(b.name, 'zh-Hans-CN')
  })

  const totals = emptyCounts()
  for (const row of rows) {
    totals.ai_ask += row.ai_ask
    totals.preview += row.preview
    totals.download += row.download
  }

  return { success: true, date, rows, totals }
}

function isUsageEvent(event: string): event is UsageEvent {
  return (USAGE_EVENTS as readonly string[]).includes(event)
}

/** 日期参数校验：只收 YYYY-MM-DD（非法就 400，别悄悄换成今天让人以为查的是那一天） */
export function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00`)
  return !Number.isNaN(parsed.getTime()) && localDateKey(parsed) === value
}