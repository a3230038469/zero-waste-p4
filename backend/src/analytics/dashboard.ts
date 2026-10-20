/**
 * 行为分析 · 区间聚合（GET /api/admin/analytics 的算法）—— 2026-10-19 新增
 *
 * 输入事件数组 → 输出看板要的全部结构。**纯函数**：不读文件、不查库、不打引擎，
 * 所以「口径对不对」可以脱开服务器单独验证。
 *
 * 口径约定（与 docs/接口约定.md「行为分析」一节逐条对应）：
 * - 切天按**本地时区**，区间 = 今天往前 `days - 1` 天（含今天）
 * - `uv` = 按 `userId ?? sessionId` 去重；两个都空的匿名事件不计入 uv（但仍计入 events）
 * - `hourly` / `weekday` 按事件发生时刻的本地小时 / 星期几归类
 * - `asks` 直接调用 track/stats.ts 的 `toAsksSummary`，与 GET /api/track/stats 零漂移
 */
import { localDateKey } from '../guest/ask-usage.js'
import { toAsksSummary } from '../track/stats.js'
import type {
  DownloadTopItem,
  SearchTermCount,
  StoredEvent,
  TrackEvent
} from '../track/types.js'
import { payloadText, rateOf, sortByCount, visitorKeyOf } from './events.js'
import { dayKeysInRange, isWithinDays, parseEventDate } from './range.js'
import {
  ANALYTICS_TOP_LIMIT,
  ANALYTICS_USERS_LIMIT,
  WEEKDAY_LABELS,
  type AnalyticsDayPoint,
  type AnalyticsResponse,
  type AnalyticsTotals,
  type CounterSet,
  type GuestSummary,
  type HourlyPoint,
  type UserAnalyticsRow,
  type UserProfileDirectory,
  type WeekdayPoint
} from './types.js'

/** 按日桶：六项计数 + 当天访客集合 */
interface DayBucket extends CounterSet {
  date: string
  visitors: Set<string>
}

/** 按账号桶：六项计数 + 最后一次出现时刻 */
interface UserBucket extends CounterSet {
  userId: string
  lastSeenMs: number
  lastSeen: string
}

function emptyCounters(): CounterSet {
  return { events: 0, pv: 0, searches: 0, previews: 0, downloads: 0, asks: 0 }
}

/** 把一条事件记进某个六项计数器（总量 / 某天 / 某账号 / 游客组共用） */
function countEvent(target: CounterSet, event: TrackEvent): void {
  target.events += 1
  if (event === 'page_view') target.pv += 1
  else if (event === 'search') target.searches += 1
  else if (event === 'preview') target.previews += 1
  else if (event === 'download') target.downloads += 1
  else if (event === 'ai_ask') target.asks += 1
}

/** 检索词 Top（最多 10 条，空词不进榜） */
function topTerms(counter: Map<string, number>): SearchTermCount[] {
  return sortByCount(counter)
    .slice(0, ANALYTICS_TOP_LIMIT)
    .map(([term, count]) => ({ term, count }))
}

/** 下载排行（最多 10 条；文件名取该资料最后一次出现的那条，与 stats.ts 一致） */
function topDownloads(
  counter: Map<string, number>,
  names: Map<string, string>
): DownloadTopItem[] {
  return sortByCount(counter)
    .slice(0, ANALYTICS_TOP_LIMIT)
    .map(([docId, count]) => ({ docId, fileName: names.get(docId) ?? '', count }))
}

/**
 * 区间内出现过的登录账号 id（路由层拿它一次查库补 name/org，避免逐账号查库）。
 */
export function collectActiveUserIds(
  events: StoredEvent[],
  days: number,
  now = new Date()
): string[] {
  const keySet = new Set(dayKeysInRange(days, now))
  const ids = new Set<string>()
  for (const evt of events) {
    if (evt.userId === null) continue
    if (!isWithinDays(evt, keySet)) continue
    ids.add(evt.userId)
  }
  return [...ids]
}

/**
 * 汇总最近 `days` 天的行为看板。
 * @param events 全量埋点（函数内部按区间筛，调用方不用先过滤）
 * @param days 区间天数（调用方保证 1..365）
 * @param now 当前时刻（测试时可固定，便于对账）
 * @param directory 账号档案（补 name/org；查不到就留空，不影响计数）
 */
export function buildAnalytics(
  events: StoredEvent[],
  days: number,
  now = new Date(),
  directory: UserProfileDirectory = new Map()
): AnalyticsResponse {
  const dayBuckets: DayBucket[] = dayKeysInRange(days, now).map((date) => ({
    ...emptyCounters(),
    date,
    visitors: new Set<string>()
  }))
  const bucketByDate = new Map<string, DayBucket>()
  for (const bucket of dayBuckets) bucketByDate.set(bucket.date, bucket)

  const totals: AnalyticsTotals = { ...emptyCounters(), uv: 0, registers: 0, feedbacks: 0 }
  const guest: GuestSummary = emptyCounters()
  const hourly: HourlyPoint[] = Array.from({ length: 24 }, (_, hour) => ({ hour, events: 0 }))
  const weekday: WeekdayPoint[] = WEEKDAY_LABELS.map((label, index) => ({
    weekday: index,
    label,
    events: 0
  }))
  const visitors = new Set<string>()
  const users = new Map<string, UserBucket>()
  const termCounter = new Map<string, number>()
  const zeroTermCounter = new Map<string, number>()
  const downloadCounter = new Map<string, number>()
  const downloadNames = new Map<string, string>()
  /** 落在区间内的事件（供 asks 复用同一聚合函数，保证口径一致） */
  const scoped: StoredEvent[] = []
  let searchTotal = 0
  let searchZero = 0
  let serverDownloads = 0

  for (const evt of events) {
    const occurredAt = parseEventDate(evt)
    if (occurredAt === null) continue
    const day = bucketByDate.get(localDateKey(occurredAt))
    if (day === undefined) continue
    scoped.push(evt)

    countEvent(totals, evt.event)
    countEvent(day, evt.event)
    if (evt.event === 'register') totals.registers += 1
    else if (evt.event === 'feedback_submit') totals.feedbacks += 1
    hourly[occurredAt.getHours()].events += 1
    weekday[occurredAt.getDay()].events += 1

    const visitor = visitorKeyOf(evt)
    if (visitor) {
      visitors.add(visitor)
      day.visitors.add(visitor)
    }

    let userBucket: UserBucket | null = null
    if (evt.userId !== null) {
      const existing = users.get(evt.userId)
      if (existing === undefined) {
        userBucket = {
          ...emptyCounters(),
          userId: evt.userId,
          lastSeenMs: 0,
          lastSeen: ''
        }
        users.set(evt.userId, userBucket)
      } else {
        userBucket = existing
      }
      const occurredMs = occurredAt.getTime()
      if (occurredMs >= userBucket.lastSeenMs) {
        userBucket.lastSeenMs = occurredMs
        userBucket.lastSeen = occurredAt.toISOString()
      }
    }
    if (userBucket === null) countEvent(guest, evt.event)
    else countEvent(userBucket, evt.event)

    if (evt.event === 'search') {
      searchTotal += 1
      if (evt.zeroResult) {
        searchZero += 1
        if (evt.term) zeroTermCounter.set(evt.term, (zeroTermCounter.get(evt.term) ?? 0) + 1)
      }
      if (evt.term) termCounter.set(evt.term, (termCounter.get(evt.term) ?? 0) + 1)
    }

    if (evt.event === 'download' && evt.source === 'server') {
      serverDownloads += 1
      const docId = payloadText(evt, 'docId')
      if (docId) {
        downloadCounter.set(docId, (downloadCounter.get(docId) ?? 0) + 1)
        const fileName = payloadText(evt, 'fileName')
        if (fileName) downloadNames.set(docId, fileName)
      }
    }
  }

  totals.uv = visitors.size

  const daily: AnalyticsDayPoint[] = dayBuckets.map((bucket) => ({
    date: bucket.date,
    events: bucket.events,
    pv: bucket.pv,
    uv: bucket.visitors.size,
    searches: bucket.searches,
    previews: bucket.previews,
    downloads: bucket.downloads,
    asks: bucket.asks
  }))

  const userRows: UserAnalyticsRow[] = [...users.values()]
    .sort(
      (a, b) =>
        b.events - a.events || b.lastSeenMs - a.lastSeenMs || a.userId.localeCompare(b.userId)
    )
    .slice(0, ANALYTICS_USERS_LIMIT)
    .map((bucket) => {
      const profile = directory.get(bucket.userId)
      return {
        userId: bucket.userId,
        name: profile?.name ?? '',
        org: profile?.org ?? '',
        events: bucket.events,
        pv: bucket.pv,
        searches: bucket.searches,
        previews: bucket.previews,
        downloads: bucket.downloads,
        asks: bucket.asks,
        lastSeen: bucket.lastSeen
      }
    })

  return {
    success: true,
    generatedAt: now.toISOString(),
    range: {
      days: dayBuckets.length,
      from: dayBuckets[0].date,
      to: dayBuckets[dayBuckets.length - 1].date
    },
    totals,
    daily,
    hourly,
    weekday,
    funnel: {
      pv: totals.pv,
      searches: totals.searches,
      previews: totals.previews,
      downloads: totals.downloads,
      asks: totals.asks
    },
    search: {
      total: searchTotal,
      zero: searchZero,
      zeroRate: rateOf(searchZero, searchTotal),
      top: topTerms(termCounter),
      zeroTerms: topTerms(zeroTermCounter)
    },
    downloads: {
      server: serverDownloads,
      events: totals.downloads,
      top: topDownloads(downloadCounter, downloadNames)
    },
    asks: toAsksSummary(scoped),
    users: userRows,
    guest
  }
}
