/**
 * 游客每日提问次数 —— T11（2026-10-14 新增）
 *
 * 落盘位置：backend/data/guest-ask-usage.json（运行时文件，已 gitignore）
 *
 * 为什么要落盘而不是放内存：
 *   「每天 N 次」必须**跨进程重启仍然成立**。放内存的话重启一次后端，
 *   额度就被清零，等于没设限 —— 这是限流最容易踩的坑。
 *
 * 「游客标识」怎么来的（T5 改造，2026-10-21）：
 *   原来是 sha256(IP + User-Agent) 两个维度，结果是：
 *     - 同一个学校/单位出口 IP 的所有人共用一份额度（办公室里互相顶额度）；
 *     - 换一个 UA 就换一份额度（同一台电脑随便改个浏览器标识就绕开限流）。
 *   现在改成三个维度：IP + User-Agent + **随机设备 cookie**：
 *     - 设备 cookie 由 src/index.ts 的中间件下发（zw_guest_id，随机 UUID，一年有效）；
 *     - 浏览器第一次访问就会拿到并自动带上，之后同一台设备算一个「人」；
 *     - 同一出口 IP 的不同设备互不干扰（各算各的额度）；
 *     - 换 UA 也不影响（cookie 还在，额度不会被重置）。
 *   仍然不引新依赖（node:crypto + 手写 cookie 解析），也不存原始 IP（只存哈希）。
 *
 * 计数写入（T5 改造，2026-10-21）：
 *   原来直接 writeFileSync 覆盖写，机器断电/进程被杀会留下半个 JSON（下次读出来是坏的）；
 *   现在改成「先写临时文件再 rename」的原子写（同 backend/src/contributions/store.ts 的做法）。
 *   读-改-写整段是**同步**的（fs 同步 API），Node 单线程里不会被打断，
 *   因此同进程内的并发请求不会互相覆盖计数。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Request } from 'express'

/** 与 qa-settings.ts / permissions.ts 同解法：两种布局都落到 backend/data */
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url))

/** 设备 cookie 名（src/index.ts 的中间件负责下发） */
export const GUEST_DEVICE_COOKIE = 'zw_guest_id'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** 设备标识：由 src/index.ts 的中间件生成（同一次请求内有效） */
      guestDeviceId?: string
    }
  }
}

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
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error('[guest] 游客提问次数文件格式不对，本次按「没用过」处理')
      return {}
    }
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
  } catch (err) {
    // 文件坏了就当没用过（计数是保护措施，不能因为它把提问功能拖下水），但要留痕
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[guest] 游客提问次数文件读不出来（本次按「没用过」处理）：${detail}`)
    return {}
  }
}

/** 原子写：先写临时文件再 rename，避免写到一半断电留下半个 JSON */
function writeUsage(usage: UsageFile): void {
  const file = usageFile()
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(usage, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
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

/** 取请求来源标识（由 Express 的 trust proxy 计算，不再手工读 XFF） */
function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || ''
}

/** 手写解析 Cookie 头（不引 cookie-parser，只取自己那一个键） */
export function cookieValue(req: Request, name: string): string {
  const raw = req.headers.cookie
  if (typeof raw !== 'string' || raw.length === 0) return ''
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return part.slice(eq + 1).trim()
    }
  }
  return ''
}

/** 生成一个新的设备标识 */
export function newGuestDeviceId(): string {
  return randomUUID().replace(/-/g, '')
}

/**
 * 设备标识：优先用本次请求里中间件挂上的（同一次请求内前后一致），
 * 其次用请求带来的 cookie；都没有就退回空串（此时退化成 IP+UA 口径）。
 */
export function guestDeviceIdOf(req: Request): string {
  if (typeof req.guestDeviceId === 'string' && req.guestDeviceId) return req.guestDeviceId
  return cookieValue(req, GUEST_DEVICE_COOKIE)
}

/**
 * 游客标识 = sha256(来源 IP + User-Agent + 设备 cookie) 前 16 位。
 * 三个维度都在，缺一不可 —— 少了设备维度，办公室共用出口 IP 就会互相顶额度。
 */
export function guestKeyOf(req: Request): string {
  const device = guestDeviceIdOf(req)
  const raw = `${clientIp(req)}|${String(req.headers['user-agent'] ?? '')}|${device}`
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
 *
 * 整段是同步的（fs 同步 API），同一进程内两个并发请求不会互相覆盖计数；
 * 落盘用「临时文件 + rename」原子写，不会写出半个 JSON。
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
