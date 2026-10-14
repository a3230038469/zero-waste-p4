/**
 * 反馈接口 —— 新增（2026-10-14）
 *
 *   POST /api/feedback   提交一条反馈（**匿名可提交**，不用登录）
 *
 * 为什么不做成「登录后才能反馈」：
 *   「关于项目」页邀请的是任何人 —— 有值得收录的公开资料、发现条目与原件对不上、
 *   想谈合作。要求先注册再反馈，等于把大部分反馈挡在门外。
 *
 * ⚠️ 但「匿名」不等于「不受后台开关管」：T11 的游客权限里有 `feedback` 一项
 *   （设置页可关），关掉后未登录访客在**所有**入口都不该能提。所以第一道闸就是它 ——
 *   见下面「闸 0」的注释。两个入口（本站表单 / B09 的 FeedbackDialog）走的是
 *   两个不同接口，各自都要拦，不能只在 /api/track 那边拦。
 *
 * 代价是这里成了一个公开写入点，所以配了四道闸：
 *   0. 游客权限开关（未登录且后台关了反馈 → 403 FEEDBACK_CLOSED）；
 *   1. 类型白名单 + 逐字段长度上限；超长**拒绝**而不是静默截断 ——
 *      反馈是工单，悄悄丢掉一半内容比报错更糟；
 *   2. 简易内存限流（同 IP 10 分钟最多 5 条），挡住「一个脚本灌一万条」；
 *   3. 落库失败如实回 500，不假装成功。
 *
 * ⚠️ 闸 1/2 的顺序是「**先校验、后限流**」，不能反过来：
 *   要保护的是**落库**这个动作（磁盘与后续人工跟进），只有校验通过的请求才会写。
 *   若把限流放前面，一次手误（正文写超了 2000 字）就会白占掉 10 分钟窗口里的一个名额，
 *   改完再提就可能被自己锁在门外；而这些被拒的请求实际上什么都没做，没有需要限的必要。
 *   （2026-10-14 验收时调整：原实现是限流在前。）
 *
 * 顺带记一条 `feedback_submit` 埋点，让看板上能看到反馈量的趋势
 * （服务端记比前端记更准 —— 与 preview / download 同一考量）。
 *
 * 落库位置与读取：见 ../feedback/store.ts。
 */
import { Router, type Request, type Response } from 'express'

import {
  appendFeedback,
  buildFeedback,
  parseFeedback
} from '../feedback/store.js'
import { isLoggedIn } from '../guest/identity.js'
import { loadGuestPermissions } from '../guest/permissions.js'
import { recordEvent } from '../track/store.js'

const router = Router()

/* ------------------------------------------------------------------ *
 * 游客权限闸（T11 的开关必须在这条链路上也生效）
 * ------------------------------------------------------------------ */

/**
 * 「意见反馈已关闭」的错误码与文案。
 *
 * ⚠️ 与 `routes/track.ts` 里那两个常量**必须逐字一致**：访客反馈有两个提交入口
 *    （B09 的 FeedbackDialog 走 /api/track；本站表单走 /api/feedback），
 *    前端一律按 `code === 'FEEDBACK_CLOSED'` 识别并提示登录。
 *    这里刻意各写一份而不去 import routes 文件 —— 真相来源是 track.ts，
 *    改任何一处都要两处一起改（见本文件头部「两个入口」说明）。
 */
const FEEDBACK_CLOSED_CODE = 'FEEDBACK_CLOSED'
const FEEDBACK_CLOSED_MESSAGE = '意见反馈需要登录后才能提交，请先登录'

/* ------------------------------------------------------------------ *
 * 简易内存限流
 * ------------------------------------------------------------------ */

/** 限流窗口 */
const RATE_WINDOW_MS = 10 * 60 * 1000
/** 窗口内同一 IP 最多提交几条 */
const RATE_MAX = 5
/** 触发一次全量清理的阈值，防止 Map 被大量不同 IP 撑大 */
const RATE_PRUNE_AT = 5000

const hits = new Map<string, number[]>()

function pruneIfNeeded(now: number): void {
  if (hits.size < RATE_PRUNE_AT) return
  for (const [key, list] of hits) {
    const kept = list.filter((t) => now - t < RATE_WINDOW_MS)
    if (kept.length === 0) hits.delete(key)
    else hits.set(key, kept)
  }
}

/** @returns true = 放行；false = 超出频率 */
function allow(ip: string): boolean {
  const now = Date.now()
  pruneIfNeeded(now)
  const list = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  if (list.length >= RATE_MAX) {
    hits.set(ip, list)
    return false
  }
  list.push(now)
  hits.set(ip, list)
  return true
}

/* ------------------------------------------------------------------ *
 * POST /api/feedback
 * ------------------------------------------------------------------ */

router.post('/', (req: Request, res: Response) => {
  // 闸 0：游客权限。后台把「游客反馈」关掉后，未登录访客在**所有**入口都不该能提 ——
  // 只关 /api/track 那条而不关这条，开关就是个摆设。判「游客」按 JWT（guest/identity.ts），
  // 已登录用户不受这个开关限制。放在校验之前：不允许的人不必先收到「你内容填错了」。
  if (!isLoggedIn(req) && !loadGuestPermissions().feedback) {
    res.status(403).json({
      success: false,
      error: { code: FEEDBACK_CLOSED_CODE, message: FEEDBACK_CLOSED_MESSAGE }
    })
    return
  }

  // 闸 1：先校验。内容不合规的直接退回，不占用频率额度（见文件头「先校验、后限流」）
  const [input, problem] = parseFeedback(req.body)
  if (!input) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_FAILED', message: problem ?? '反馈内容有误' }
    })
    return
  }

  // 闸 2：后限流。只有真的要落库的请求才计数
  const ip = req.ip ?? 'unknown'
  if (!allow(ip)) {
    res.status(429).json({
      success: false,
      error: {
        code: 'TOO_MANY_SUBMISSIONS',
        message: `提交太频繁了，请等一会儿再试（同一地址 10 分钟内最多 ${RATE_MAX} 条）`
      }
    })
    return
  }

  const record = buildFeedback(input)
  try {
    appendFeedback(record)
  } catch (err) {
    // 写不进去必须如实说 —— 否则用户以为提了、其实丢了
    const detail = err instanceof Error ? err.message : '未知错误'
    console.error(`[feedback] 落库失败：${detail}`)
    res.status(500).json({
      success: false,
      error: { code: 'STORE_FAILED', message: '反馈没能保存下来，请稍后再试或改用其他方式联系我们' }
    })
    return
  }

  // 埋点是旁路：recordEvent 内部已吞掉所有异常，绝不影响上面的成功响应
  recordEvent({
    event: 'feedback_submit',
    source: 'server',
    path: '/api/feedback',
    payload: { kind: record.kind, hasContact: Boolean(record.contact), docId: record.docId }
  })

  res.status(201).json({ success: true, id: record.id })
})

export default router
