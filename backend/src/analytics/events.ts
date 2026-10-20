/**
 * 行为分析 · 小工具 —— 2026-10-19 新增
 *
 * 只放「两条以上分析都要用」的最小工具，纯函数、无副作用。
 * 口径对齐 track/stats.ts：`sortByCount` 同规则（次数降序、同次数按中文字面序）。
 */
import type { StoredEvent } from '../track/types.js'

/** 从 `payload` 里安全取一个字符串字段；不是字符串（含缺失）一律给空字符串 */
export function payloadText(evt: StoredEvent, key: string): string {
  const value = evt.payload[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 访客去重键：登录用户按 `userId`，匿名按 `sessionId`。
 * 两个都空（事件没带会话）返回空字符串，调用方应跳过、不计入 uv。
 */
export function visitorKeyOf(evt: StoredEvent): string {
  return evt.userId !== null ? evt.userId : evt.sessionId
}

/** 计数器按次数降序排好（同次数按中文字面序，保证两次请求顺序一致） */
export function sortByCount(counter: Map<string, number>): Array<[string, number]> {
  return [...counter.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN')
  )
}

/** 保留 4 位小数（与 track/stats.ts 的比率口径一致） */
export function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** 比率；分母为 0 给 0（不产生 NaN / Infinity，前端不用再判） */
export function rateOf(part: number, whole: number): number {
  return whole > 0 ? round4(part / whole) : 0
}
