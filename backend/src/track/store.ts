/**
 * 埋点统计 · 落库与读取 —— 负责人：韶茹
 *
 * 存储选择：**JSONL 追加文件**（backend/data/track/events.jsonl，每行一条 JSON）。
 *   - 零新依赖、零迁移，demo 阶段最省事；
 *   - 量级是千行级，读全量做聚合毫无压力；
 *   - 将来要换 SQLite/Prisma，只改本文件，上层（routes/track.ts、stats.ts）不用动。
 *
 * 纪律：埋点是**旁路**。写入失败只打一行日志，绝不抛给调用方——
 *       预览/下载/提问绝不能因为统计写不进去而失败。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TRACK_EVENTS,
  TRACK_MAX_PATH_CHARS,
  TRACK_MAX_PAYLOAD_CHARS,
  TRACK_MAX_SESSION_ID_CHARS,
  TRACK_MAX_TERM_CHARS,
  TRACK_MAX_USER_ID_CHARS,
  type StoredEvent,
  type TrackEvent,
  type TrackIssue,
  type TrackSource
} from './types.js'

/** 默认落库位置：backend/data/track/events.jsonl（src 与 dist 两种布局都落到同一处） */
const DEFAULT_TRACK_FILE = fileURLToPath(new URL('../../data/track/events.jsonl', import.meta.url))

function trackFile(): string {
  const override = (process.env.TRACK_FILE ?? '').trim()
  return override ? resolve(override) : DEFAULT_TRACK_FILE
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/** 一条待落库事件的原始输入（服务端内部调用与前端上报共用） */
export interface RecordInput {
  event: TrackEvent
  sessionId?: string
  userId?: string | null
  path?: string
  payload?: Record<string, unknown>
  /** 缺省 client；后端接口自动记的传 server */
  source?: TrackSource
  /** 覆盖发生时刻（补记场景用），缺省取当前时间 */
  ts?: string
}

/**
 * 把一条输入归一化成可落库的记录。
 * @returns [记录, null] 成功；[null, issue] 被拒（原因码给调用方拼响应体）
 */
export function normalizeEvent(raw: unknown, index: number): [StoredEvent | null, TrackIssue | null] {
  if (!isRecord(raw)) {
    return [null, { index, code: 'INVALID_ITEM', message: `第 ${index} 条不是对象` }]
  }
  const name = readString(raw, 'event')
  if (!(TRACK_EVENTS as readonly string[]).includes(name)) {
    return [
      null,
      {
        index,
        code: 'UNKNOWN_EVENT',
        message: `第 ${index} 条事件名不在白名单：${name || '(空)'}`
      }
    ]
  }

  const payloadRaw = raw['payload']
  let payload: Record<string, unknown> = {}
  if (payloadRaw !== undefined && payloadRaw !== null) {
    if (!isRecord(payloadRaw)) {
      return [null, { index, code: 'INVALID_ITEM', message: `第 ${index} 条 payload 必须是对象` }]
    }
    if (JSON.stringify(payloadRaw).length > TRACK_MAX_PAYLOAD_CHARS) {
      return [
        null,
        {
          index,
          code: 'PAYLOAD_TOO_LARGE',
          message: `第 ${index} 条 payload 超过 ${TRACK_MAX_PAYLOAD_CHARS} 字符`
        }
      ]
    }
    payload = payloadRaw
  }

  const tsRaw = readString(raw, 'ts')
  const ts = Number.isNaN(Date.parse(tsRaw)) ? new Date().toISOString() : new Date(tsRaw).toISOString()

  return [buildEvent({ event: name as TrackEvent, ts, payload, source: 'client', raw }), null]
}

/** 组装落库记录：长度截断 + 派生列 */
export function buildEvent(input: RecordInput & { raw?: Record<string, unknown> }): StoredEvent {
  const raw = input.raw ?? {}
  const payload = input.payload ?? {}
  const userIdRaw =
    input.userId !== undefined ? input.userId : readString(raw, 'userId') || null

  const termSource =
    readString(payload, 'term') || readString(payload, 'query') || readString(payload, 'keyword')
  const zeroResult = payload['zeroResult'] === true
  const noAnswer = payload['noAnswer'] === true ? true : payload['noAnswer'] === false ? false : null

  return {
    ts: input.ts ?? new Date().toISOString(),
    event: input.event,
    userId: userIdRaw ? truncate(String(userIdRaw), TRACK_MAX_USER_ID_CHARS) : null,
    sessionId: truncate(input.sessionId ?? readString(raw, 'sessionId'), TRACK_MAX_SESSION_ID_CHARS),
    path: truncate(input.path ?? readString(raw, 'path'), TRACK_MAX_PATH_CHARS),
    payload,
    source: input.source ?? 'client',
    term: truncate(termSource.trim().toLowerCase(), TRACK_MAX_TERM_CHARS),
    zeroResult,
    noAnswer: input.event === 'ai_ask' ? noAnswer : null
  }
}

/** 批量追加落库。**永不抛**：失败只打日志，返回实际写入行数。 */
export function appendEvents(events: StoredEvent[]): number {
  if (events.length === 0) return 0
  const file = trackFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    cachedEvents = null // 下次读取重新加载
    return events.length
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[track] 埋点写入失败（已忽略，不影响主流程）：${detail}`)
    return 0
  }
}

/** 便捷入口：内部某处记一条（预览/下载/提问用）。**永不抛**。 */
export function recordEvent(input: RecordInput): void {
  try {
    appendEvents([buildEvent(input)])
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[track] 埋点记录失败（已忽略）：${detail}`)
  }
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

let cachedEvents: StoredEvent[] | null = null
let cachedStamp = ''

/** 文件指纹：大小 + 修改时间。变了就重读，避免每次统计都全量解析。 */
function fileStamp(file: string): string {
  try {
    const stat = statSync(file)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return ''
  }
}

/** 读全量事件。文件不存在返回空数组（全新环境不算错）。 */
export function readEvents(): StoredEvent[] {
  const file = trackFile()
  if (!existsSync(file)) return []

  const stamp = fileStamp(file)
  if (cachedEvents !== null && stamp === cachedStamp) return cachedEvents

  const parsed: StoredEvent[] = []
  let broken = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const value: unknown = JSON.parse(text)
      if (isRecord(value) && (TRACK_EVENTS as readonly string[]).includes(String(value.event))) {
        parsed.push(value as unknown as StoredEvent)
      } else {
        broken += 1
      }
    } catch {
      broken += 1 // 只跳过这一行，不让一行坏数据毁掉整个看板
    }
  }
  if (broken > 0) console.warn(`[track] 跳过 ${broken} 行无法解析的事件记录：${file}`)

  cachedEvents = parsed
  cachedStamp = stamp
  return parsed
}

/** 当前落库文件路径（看板/排障展示用） */
export function trackFilePath(): string {
  return trackFile()
}
