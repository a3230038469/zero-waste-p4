/**
 * 埋点与统计接口 —— 负责人：韶茹
 *
 *   POST /api/track        上报行为事件（匿名可传，允许部分成功）
 *   GET  /api/track/stats  看板统计摘要（需管理员账号登录态，见 src/admin/guard.ts）
 *
 * 契约见 docs/接口约定.md 第二节「行为埋点与统计」。
 * 设计与 /api/docs、/api/auth、/api/embed、/api/ask 全不重叠，路由挂载在最后即可。
 *
 * 实现要点：
 *  - 埋点是「尽力而为」的旁路：单条非法不影响同批合法条（逐条校验、部分成功）；
 *    只有信封不可用（不是对象/数组、空数组、超 100 条）或整批全非法才 400。
 *  - accepted 严格等于实际落库行数。
 *  - 看板守卫 fail closed：不是管理员一律 403（2026-10-19 从共用口令改成管理员账号）。
 *
 * 🔴 T11（2026-10-14）追加：游客权限 `feedback` 关闭时，**未登录**请求里的
 *    `feedback_submit` 一律拒收（其他事件一律照常落库，完全不受影响）。
 *    🔴 事件白名单（track/types.ts 的 TRACK_EVENTS）**一个字节都没动** ——
 *    「反馈被关」不是「非法事件名」，所以本文件用一个本地原因码回报，
 *    不去污染 track/types.ts 里的联合类型。
 */
import { Router, type Request, type Response } from 'express'
import { requireAdminGuard } from '../admin/guard.js'

import { buildStatsSummary } from '../track/stats.js'
import { appendEvents, normalizeEvent, readEvents, trackFilePath } from '../track/store.js'
import {
  TRACK_MAX_EVENTS_PER_REQUEST,
  type StatsSummaryResponse,
  type StoredEvent,
  type TrackErrorResponse,
  type TrackIssue
} from '../track/types.js'
import { isLoggedIn } from '../guest/identity.js'
import { loadGuestPermissions } from '../guest/permissions.js'

const router = Router()

/** 「反馈已对游客关闭」的原因码（只在本文件用，理由见顶部注释） */
const FEEDBACK_CLOSED_CODE = 'FEEDBACK_CLOSED'
const FEEDBACK_CLOSED_MESSAGE = '意见反馈需要登录后才能提交，请先登录'

/* ------------------------------------------------------------------ *
 * POST /api/track
 * ------------------------------------------------------------------ */

/** 拆信封：单条 / 裸数组 / { events: [...] } 三种都收 */
function parseEnvelope(body: unknown): { ok: true; items: unknown[] } | { ok: false; issue: TrackIssue } {
  if (Array.isArray(body)) {
    if (body.length === 0) return { ok: false, issue: { index: 0, code: 'EMPTY_BATCH', message: '事件数组为空' } }
    if (body.length > TRACK_MAX_EVENTS_PER_REQUEST) {
      return {
        ok: false,
        issue: {
          index: 0,
          code: 'TOO_MANY_EVENTS',
          message: `单次最多 ${TRACK_MAX_EVENTS_PER_REQUEST} 条，本批 ${body.length} 条`
        }
      }
    }
    return { ok: true, items: body }
  }

  if (typeof body !== 'object' || body === null) {
    return { ok: false, issue: { index: 0, code: 'INVALID_BODY', message: '请求体需为对象或数组' } }
  }

  const obj = body as Record<string, unknown>
  if (Array.isArray(obj.events)) {
    if (obj.events.length === 0) {
      return { ok: false, issue: { index: 0, code: 'EMPTY_BATCH', message: 'events 数组为空' } }
    }
    if (obj.events.length > TRACK_MAX_EVENTS_PER_REQUEST) {
      return {
        ok: false,
        issue: {
          index: 0,
          code: 'TOO_MANY_EVENTS',
          message: `单次最多 ${TRACK_MAX_EVENTS_PER_REQUEST} 条，本批 ${obj.events.length} 条`
        }
      }
    }
    return { ok: true, items: obj.events }
  }

  // 单条事件对象
  if (typeof obj.event === 'string') return { ok: true, items: [obj] }

  return {
    ok: false,
    issue: { index: 0, code: 'INVALID_BODY', message: '请求体需含 event 字段，或为 events 数组' }
  }
}

function respondError(
  res: Response,
  status: number,
  code: 'VALIDATION_FAILED' | 'INTERNAL_ERROR',
  message: string,
  issues: TrackIssue[]
): void {
  const body: TrackErrorResponse = { success: false, error: { code, message, issues } }
  res.status(status).json(body)
}

/** 一条被拒的原因（code 比 TrackIssue 宽一格：多一个「反馈已关闭」的本地码） */
interface RejectIssue {
  index: number
  code: string
  message: string
}

/** 原始条目是不是 feedback_submit（只认 event 字段，其余交给 normalizeEvent 校验） */
function isFeedbackEvent(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)['event'] === 'feedback_submit'
    : false
}

router.post('/', (req: Request, res: Response) => {
  const envelope = parseEnvelope(req.body)
  if (!envelope.ok) {
    respondError(res, 400, 'VALIDATION_FAILED', envelope.issue.message, [envelope.issue])
    return
  }

  // 🔴 T11：游客权限 `feedback` 关闭时，游客（未登录）的反馈一律拒收。
  //    判「游客」按 JWT 校验（见 guest/identity.ts）；已登录用户照常能提。
  //    混批时**只摘掉反馈那几条**，页面访问等其它事件照常落库。
  const feedbackClosed = isLoggedIn(req) ? false : !loadGuestPermissions().feedback
  const allowed: Array<{ index: number; raw: unknown }> = []
  const rejected: RejectIssue[] = []
  envelope.items.forEach((raw, index) => {
    if (feedbackClosed && isFeedbackEvent(raw)) {
      rejected.push({ index, code: FEEDBACK_CLOSED_CODE, message: FEEDBACK_CLOSED_MESSAGE })
      return
    }
    allowed.push({ index, raw })
  })

  if (allowed.length === 0 && rejected.length > 0) {
    // 整批都是被关掉的反馈：直接 403 并说清楚（前端 http.ts 会弹这句中文）
    res.status(403).json({
      success: false,
      error: { code: FEEDBACK_CLOSED_CODE, message: FEEDBACK_CLOSED_MESSAGE, issues: rejected }
    })
    return
  }

  const accepted: StoredEvent[] = []
  allowed.forEach((item) => {
    // index 传原始下标：被摘掉几条之后，下标仍与前端发来的一致，便于对账
    const [event, issue] = normalizeEvent(item.raw, item.index)
    if (event !== null) accepted.push(event)
    else if (issue !== null) rejected.push(issue as RejectIssue)
  })

  if (accepted.length === 0) {
    // 说清楚「为什么一条没落库」：既可能是全部非法，也可能混着被关掉的反馈。
    // 混着的时候不说清楚，老师会以为是自己写错了事件名。
    const blockedCount = rejected.filter((r) => r.code === FEEDBACK_CLOSED_CODE).length
    const invalidCount = rejected.length - blockedCount
    const parts: string[] = []
    if (invalidCount > 0) parts.push(`${invalidCount} 条非法`)
    if (blockedCount > 0) parts.push(`${blockedCount} 条因反馈功能已关闭被拒收`)
    respondError(
      res,
      400,
      'VALIDATION_FAILED',
      `本批 ${rejected.length} 条事件未落库（${parts.join('、')}）`,
      rejected as TrackIssue[]
    )
    return
  }

  const inserted = appendEvents(accepted)
  if (inserted !== accepted.length) {
    respondError(res, 500, 'INTERNAL_ERROR', '埋点写入失败（详见服务端日志）', [])
    return
  }

  // accepted 严格等于实际落库行数（契约不变）；rejected 里带上了「反馈被关」的那几条
  res.status(201).json({ success: true, accepted: inserted, rejected })
})

/* ------------------------------------------------------------------ *
 * GET /api/track/stats（看板）
 * ------------------------------------------------------------------ */

router.get('/stats', async (req: Request, res: Response) => {
  if (!(await requireAdminGuard(req, res))) return
  try {
    const summary: StatsSummaryResponse = buildStatsSummary(readEvents())
    res.status(200).json(summary)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[track] 统计聚合失败：${detail}（文件：${trackFilePath()}）`)
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '统计聚合失败（详见服务端日志）' }
    })
  }
})

export default router
