/**
 * 埋点统计 · 聚合 —— 负责人：韶茹
 *
 * 口径唯一出处：docs/接口约定.md 第二节「行为埋点与统计」。
 * 只读本地落库（backend/data/track/events.jsonl），**不打引擎**（与书架层同一条纪律）。
 */
import {
  TRACK_EVENTS,
  type AsksSummary,
  type DailyPoint,
  type DownloadTopItem,
  type SearchTermCount,
  type StatsSummaryResponse,
  type StoredEvent,
  type TrackEvent
} from './types.js'

/** Top 榜长度 */
export const STATS_TOP_LIMIT = 10

/** 趋势默认看最近多少天 */
export const STATS_DAILY_DAYS = 14

/** 全量统计摘要（看板一次拉完；量级千行，无需分页/缓存） */
export function buildStatsSummary(events: StoredEvent[], now = new Date()): StatsSummaryResponse {
  const counts = emptyEventCounts()
  for (const evt of events) counts[evt.event] += 1

  return {
    success: true,
    generatedAt: now.toISOString(),
    totals: {
      events: events.length,
      pv: counts.page_view,
      uv: countVisitors(events)
    },
    events: counts,
    topSearchTerms: topTerms(events, false),
    zeroResultSearchTerms: topTerms(events, true),
    topDownloads: topDownloads(events),
    downloads: {
      server: events.filter((e) => e.event === 'download' && e.source === 'server').length,
      events: counts.download
    },
    asks: toAsksSummary(events),
    daily: buildDaily(events, now)
  }
}

/** 七类事件计数补齐：没发生的给 0，前端不必判空 */
export function emptyEventCounts(): Record<TrackEvent, number> {
  return {
    page_view: 0,
    search: 0,
    preview: 0,
    download: 0,
    ai_ask: 0,
    register: 0,
    feedback_submit: 0
  }
}

/** UV = 按 userId ?? sessionId 去重；两个都空的不算访客 */
function countVisitors(events: StoredEvent[]): number {
  const seen = new Set<string>()
  for (const evt of events) {
    const visitor = evt.userId || evt.sessionId
    if (visitor) seen.add(visitor)
  }
  return seen.size
}

/** 检索词 Top：数量多的在前，同数量按字面序（保证每次返回顺序稳定） */
function topTerms(events: StoredEvent[], onlyZeroResult: boolean): SearchTermCount[] {
  const counter = new Map<string, number>()
  for (const evt of events) {
    if (evt.event !== 'search') continue
    if (!evt.term) continue
    if (onlyZeroResult && !evt.zeroResult) continue
    counter.set(evt.term, (counter.get(evt.term) ?? 0) + 1)
  }
  return sortByCount(counter)
    .slice(0, STATS_TOP_LIMIT)
    .map(([term, count]) => ({ term, count }))
}

/** 下载 Top：只认服务端记的那条（权威口径），fileName 取最近一次 */
function topDownloads(events: StoredEvent[]): DownloadTopItem[] {
  const counter = new Map<string, number>()
  const names = new Map<string, string>()
  for (const evt of events) {
    if (evt.event !== 'download' || evt.source !== 'server') continue
    const docId = readPayloadString(evt, 'docId')
    if (!docId) continue
    counter.set(docId, (counter.get(docId) ?? 0) + 1)
    const fileName = readPayloadString(evt, 'fileName')
    if (fileName) names.set(docId, fileName)
  }
  return sortByCount(counter)
    .slice(0, STATS_TOP_LIMIT)
    .map(([docId, count]) => ({ docId, fileName: names.get(docId) ?? '', count }))
}

/** 无答案率 = noAnswer / judged（judged=0 给 0，保留 4 位小数） */
export function toAsksSummary(events: StoredEvent[]): AsksSummary {
  const asks = events.filter((e) => e.event === 'ai_ask')
  const judged = asks.filter((e) => e.noAnswer !== null).length
  const noAnswer = asks.filter((e) => e.noAnswer === true).length
  return {
    total: asks.length,
    judged,
    noAnswer,
    unjudged: Math.max(asks.length - judged, 0),
    noAnswerRate: judged > 0 ? round4(noAnswer / judged) : 0
  }
}

/**
 * 按日趋势（含今天，共 STATS_DAILY_DAYS 天）。
 * 用本地时区切天——看板是给人看的，跨时区偏移到「昨天」反而费解。
 */
function buildDaily(events: StoredEvent[], now: Date): DailyPoint[] {
  const keys: string[] = []
  const byDay = new Map<string, DailyPoint>()
  for (let i = STATS_DAILY_DAYS - 1; i >= 0; i -= 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = localDateKey(day)
    keys.push(key)
    byDay.set(key, { date: key, events: 0, pv: 0, download: 0, ai_ask: 0, preview: 0, search: 0 })
  }
  for (const evt of events) {
    const parsed = new Date(evt.ts)
    if (Number.isNaN(parsed.getTime())) continue
    const point = byDay.get(localDateKey(parsed))
    if (!point) continue
    point.events += 1
    if ((TRACK_EVENTS as readonly string[]).includes(evt.event)) {
      // 六类里除 register / feedback_submit 外都在 DailyPoint 上
      if (evt.event === 'page_view') point.pv += 1
      else if (evt.event === 'download') point.download += 1
      else if (evt.event === 'ai_ask') point.ai_ask += 1
      else if (evt.event === 'preview') point.preview += 1
      else if (evt.event === 'search') point.search += 1
    }
  }
  return keys.map((key) => byDay.get(key) as DailyPoint)
}

function localDateKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 计数从多到少；数量相同按字面序 */
function sortByCount(counter: Map<string, number>): [string, number][] {
  return [...counter.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
}

function readPayloadString(evt: StoredEvent, key: string): string {
  const value = evt.payload[key]
  return typeof value === 'string' ? value : ''
}

/** 比率保留 4 位小数（看板够用，且 JSON 里不出现一长串浮点尾巴） */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
