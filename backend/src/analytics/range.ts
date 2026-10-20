/**
 * 行为分析 · 区间与时间工具 —— 2026-10-19 新增
 *
 * 切天口径**刻意与 track/stats.ts 一致：按本地时区**。看板是给人看的，
 * 按 UTC 切天会让「昨天晚上 8 点」掉进前一天，老师对不上数。
 * 本地日键复用 guest/ask-usage.ts 的 `localDateKey`（admin.ts 的 /usage-detail 也用它）。
 */
import { localDateKey } from '../guest/ask-usage.js'
import type { StoredEvent } from '../track/types.js'

/**
 * 最近 `days` 天（含今天）的本地日键，按日期升序。
 * @param days 1..365（越界由路由层拦成 400，这里只做防御性兜底）
 */
export function dayKeysInRange(days: number, now = new Date()): string[] {
  const count = Math.max(1, Math.trunc(days))
  const keys: string[] = []
  for (let i = count - 1; i >= 0; i -= 1) {
    keys.push(localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)))
  }
  return keys
}

/** 解析事件发生时刻；坏数据（ts 解析不出来）返回 null，调用方跳过这一行 */
export function parseEventDate(evt: StoredEvent): Date | null {
  const parsed = new Date(evt.ts)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** 事件是否落在给定日键集合内（坏 ts 一律不算在内） */
export function isWithinDays(evt: StoredEvent, keySet: Set<string>): boolean {
  const date = parseEventDate(evt)
  if (date === null) return false
  return keySet.has(localDateKey(date))
}
