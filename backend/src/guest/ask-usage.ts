/**
 * 游客每日提问次数 —— T11（2026-10-14 新增）
 *
 * 落盘位置：backend/data/guest-ask-usage.json（运行时文件，已 gitignore）
 *
 * 为什么要落盘而不是放内存：
 *   「每天 N 次」必须**跨进程重启仍然成立**。放内存的话重启一次后端，
 *   额度就被清零，等于没设限 —— 这是限流最容易踩的坑。
 *
 * 「游客标识」怎么来的：请求来源（IP + User-Agent）取哈希。
 *   - 不引新依赖（node:crypto 自带）；
 *   - 存的是哈希而不是原始 IP，文件里看不到谁提过问；
 *   - 已登录用户根本不走这里（不受限）。
 *   ⚠️ 已知取舍：同一个学校/单位出口 IP 的所有人会共用一个额度。
 *     这是「防白刷」与「不引依赖、不存个人信息」之间的取舍，注释写明，别当成 bug。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Request } from 'express'

/** 与 qa-settings.ts / permissions.ts 同解法：两种布局都落到 backend/data */
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url))

function usageFile(): string {
  const override = (process.env.KB_DATA_DIR ?? '').trim()
  return join(override || DEFAULT_DATA_DIR, 'guest-ask-usage.json')
}

/** 只留最近几天（够用即可，别让文件无限长） */
const KEEP_DAYS = 3

/** 文件形状：{ "2026-10-14": { "<游客标识>": 次数 } } */
type UsageFile = Record<string, Record<string, number>>

function readUsage(): UsageFile {
  const file = usageFile()
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: UsageFile = {}
    for (const [day, counts] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof day !== 'string' || typeof counts !== 'object' || counts === null) continue
      const bucket: Record<string, number> = {}
      for (const [key, value] of Object.entries(counts as Record<string, unknown>)) {
        const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
        if (n > 0) bucket[key] = n
      }
      out[day] = bucket
    }
    return out
  } catch {
    // 文件坏了就当没用过（计数是保护措施，不能因为它把提问功能拖下水）
    return {}
  }
}

function writeUsage(usage: UsageFile): void {
  const file = usageFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(usage, null, 2)}\n`, 'utf8')
  } catch (err) {
    // 计数写不进去只打一行日志：宁可这次不计数，也不能让提问直接失败
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[guest] 游客提问次数写入失败（已忽略，不影响提问）：${detail}`)
  }
}

/** 本地时区的 YYYY-MM-DD（与 track/stats.ts 的切天口径一致：看板是给人看的） */
export function localDateKey(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 取请求来源标识（代理优先，与 Express 的 trust proxy 无关，手工读更可控） */
function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof first === 'string' && first.trim()) return first.split(',')[0].trim()
  return (req.socket.remoteAddress ?? '').trim()
}

/** 游客标识 = sha256(来源 IP + User-Agent) 前 16 位（够区分，也短） */
export function guestKeyOf(req: Request): string {
  const raw = `${clientIp(req)}|${String(req.headers['user-agent'] ?? '')}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/** 今天这个游客已经问了几次 */
export function countGuestAsk(req: Request, now = new Date()): number {
  const usage = readUsage()
  return usage[localDateKey(now)]?.[guestKeyOf(req)] ?? 0
}

/**
 * 记一次游客提问，返回记完之后的次数。
 *
 * ⚠️ 调用点必须在**放行开流之前**：被拒绝的请求不该消耗额度，
 *    已经放行的请求即使后来引擎报错也算用掉（限流防的是刷，不是补偿失败）。
 */
export function bumpGuestAsk(req: Request, now = new Date()): number {
  const day = localDateKey(now)
  const key = guestKeyOf(req)
  const usage = readUsage()
  const bucket = usage[day] ?? {}
  const next = (bucket[key] ?? 0) + 1
  bucket[key] = next
  usage[day] = bucket

  // 只留最近 KEEP_DAYS 天
  const days = Object.keys(usage).sort().reverse().slice(0, KEEP_DAYS)
  const kept: UsageFile = {}
  for (const d of days) kept[d] = usage[d] ?? {}
  writeUsage(kept)

  return next
}