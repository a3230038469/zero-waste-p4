/**
 * 埋点与统计接口 —— 负责人：韶茹
 *
 *   POST /api/track        上报行为事件（匿名可传，允许部分成功）
 *   GET  /api/track/stats  看板统计摘要（需 X-Admin-Token）
 *
 * 契约见 docs/接口约定.md 第二节「行为埋点与统计」。
 * 设计与 /api/docs、/api/auth、/api/embed、/api/ask 全不重叠，路由挂载在最后即可。
 *
 * 实现要点：
 *  - 埋点是「尽力而为」的旁路：单条非法不影响同批合法条（逐条校验、部分成功）；
 *    只有信封不可用（不是对象/数组、空数组、超 100 条）或整批全非法才 400。
 *  - accepted 严格等于实际落库行数。
 *  - 看板守卫 fail closed：没配 ADMIN_STATS_TOKEN 一律 403，不因为缺配置就放行。
 */
import { Router, type Request, type Response } from 'express'

import { buildStatsSummary } from '../track/stats.js'
import { appendEvents, normalizeEvent, readEvents, trackFilePath } from '../track/store.js'
import {
  TRACK_MAX_EVENTS_PER_REQUEST,
  type StatsSummaryResponse,
  type StoredEvent,
  type TrackAcceptedResponse,
  type TrackErrorResponse,
  type TrackIssue
} from '../track/types.js'

const router = Router()

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

router.post('/', (req: Request, res: Response) => {
  const envelope = parseEnvelope(req.body)
  if (!envelope.ok) {
    respondError(res, 400, 'VALIDATION_FAILED', envelope.issue.message, [envelope.issue])
    return
  }

  const accepted: StoredEvent[] = []
  const rejected: TrackIssue[] = []
  envelope.items.forEach((raw, index) => {
    const [event, issue] = normalizeEvent(raw, index)
    if (event !== null) accepted.push(event)
    else if (issue !== null) rejected.push(issue)
  })

  if (accepted.length === 0) {
    respondError(
      res,
      400,
      'VALIDATION_FAILED',
      `本批 ${rejected.length} 条事件全部非法，未落库`,
      rejected
    )
    return
  }

  const inserted = appendEvents(accepted)
  if (inserted !== accepted.length) {
    respondError(res, 500, 'INTERNAL_ERROR', '埋点写入失败（详见服务端日志）', [])
    return
  }

  const body: TrackAcceptedResponse = { success: true, accepted: inserted, rejected }
  res.status(201).json(body)
})

/* ------------------------------------------------------------------ *
 * GET /api/track/stats（看板）
 * ------------------------------------------------------------------ */

/** 看板口令：只从环境变量读，不写进代码 */
function adminToken(): string {
  return (process.env.ADMIN_STATS_TOKEN ?? '').trim()
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = adminToken()
  if (!expected) {
    // fail closed：没配口令就不放行，避免「忘了配 = 全世界可看」
    res.status(403).json({
      success: false,
      error: {
        code: 'ADMIN_NOT_CONFIGURED',
        message: '服务端未配置 ADMIN_STATS_TOKEN，看板已关闭。请在 backend/.env 配置后重启。'
      }
    })
    return false
  }
  const provided = String(req.headers['x-admin-token'] ?? '')
  if (provided !== expected) {
    res.status(403).json({
      success: false,
      error: { code: 'ADMIN_FORBIDDEN', message: '看板口令不正确' }
    })
    return false
  }
  return true
}

router.get('/stats', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
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
