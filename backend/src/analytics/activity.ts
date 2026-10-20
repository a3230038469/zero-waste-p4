/**
 * 行为分析 · 单账号逐条记录（GET /api/admin/user-activity 的算法）—— 2026-10-19 新增
 *
 * 输入事件数组 + 查询条件 → 输出分页后的事件列表。**纯函数**：不读文件、不查库。
 *
 * 口径约定（与 docs/接口约定.md「行为分析」一节逐条对应）：
 * - 按 `ts` **倒序**（新的在前）；`total` 是筛选后的总条数，不是本页条数
 * - `__guest__` = 存储层 `userId` 为 null 的匿名事件
 * - 未知账号 / 区间内没记录 → `total: 0` + 空数组，**不报错**
 * - `detail` 是给人看的一句话：提问原文 / 检索词 / 文件名 / 页面路径
 */
import type { StoredEvent } from '../track/types.js'
import { payloadText } from './events.js'
import { dayKeysInRange, parseEventDate } from './range.js'
import {
  ANALYTICS_GUEST_ID,
  EVENT_LABELS,
  type ActivityEventFilter,
  type ActivityItem,
  type UserActivityResponse,
  type UserProfileDirectory
} from './types.js'
import { localDateKey } from '../guest/ask-usage.js'

/** 单账号明细的查询条件（路由层已校验取值范围，这里不再重复报错） */
export interface UserActivityQuery {
  /** 账号 id；`__guest__` 表示匿名事件 */
  userId: string
  /** 事件筛选；`all` 表示不筛 */
  event: ActivityEventFilter
  /** 页码，从 1 开始 */
  page: number
  /** 每页条数（路由层已把 >100 截到 100） */
  pageSize: number
  /** 区间天数（含今天），1..365 */
  days: number
}

interface MatchedEvent {
  evt: StoredEvent
  occurredMs: number
}

/** 这一条事件是否属于该账号（`__guest__` 特指匿名事件） */
function matchesUser(evt: StoredEvent, userId: string): boolean {
  if (userId === ANALYTICS_GUEST_ID) return evt.userId === null
  return evt.userId === userId
}

/**
 * 给人看的一句话。
 * ai_ask 取提问原文（老数据可能落在 query / question / term 任一字段），
 * search 取检索词（存储层已小写化），preview / download 取文件名，page_view 取页面路径。
 */
function detailOf(evt: StoredEvent): string {
  if (evt.event === 'ai_ask') {
    return (
      payloadText(evt, 'query') ||
      payloadText(evt, 'question') ||
      payloadText(evt, 'term') ||
      evt.term
    )
  }
  if (evt.event === 'search') {
    return (
      evt.term || payloadText(evt, 'term') || payloadText(evt, 'query') || payloadText(evt, 'keyword')
    )
  }
  if (evt.event === 'preview' || evt.event === 'download') return payloadText(evt, 'fileName')
  if (evt.event === 'page_view') return evt.path
  return ''
}

function toItem(evt: StoredEvent): ActivityItem {
  return {
    ts: evt.ts,
    event: evt.event,
    label: EVENT_LABELS[evt.event],
    detail: detailOf(evt),
    docId: payloadText(evt, 'docId'),
    fileName: payloadText(evt, 'fileName'),
    noAnswer: evt.event === 'ai_ask' ? evt.noAnswer : null,
    path: evt.path
  }
}

/**
 * 汇总某个账号最近 `days` 天内的事件，按时间倒序分页。
 * @param events 全量埋点（函数内部按账号 + 事件 + 区间筛）
 * @param query 查询条件（已校验）
 * @param now 当前时刻（测试时可固定）
 * @param directory 账号档案（补 name/org；查不到留空，不影响列表）
 */
export function buildUserActivity(
  events: StoredEvent[],
  query: UserActivityQuery,
  now = new Date(),
  directory: UserProfileDirectory = new Map()
): UserActivityResponse {
  const keySet = new Set(dayKeysInRange(query.days, now))
  const matched: MatchedEvent[] = []
  for (const evt of events) {
    if (!matchesUser(evt, query.userId)) continue
    if (query.event !== 'all' && evt.event !== query.event) continue
    const occurredAt = parseEventDate(evt)
    if (occurredAt === null) continue
    if (!keySet.has(localDateKey(occurredAt))) continue
    matched.push({ evt, occurredMs: occurredAt.getTime() })
  }
  matched.sort((a, b) => b.occurredMs - a.occurredMs)

  const start = (query.page - 1) * query.pageSize
  const items = matched.slice(start, start + query.pageSize).map((entry) => toItem(entry.evt))
  const isGuest = query.userId === ANALYTICS_GUEST_ID
  const profile = isGuest ? undefined : directory.get(query.userId)

  return {
    success: true,
    userId: query.userId,
    name: isGuest ? '游客' : (profile?.name ?? ''),
    org: isGuest ? '' : (profile?.org ?? ''),
    total: matched.length,
    page: query.page,
    pageSize: query.pageSize,
    items
  }
}
