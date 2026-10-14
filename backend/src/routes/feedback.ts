/**
 * 反馈接口 —— 新增（2026-10-14）
 *
 *   POST /api/feedback   提交一条反馈（**匿名可提交**，不用登录）
 *
 * 为什么不做成「登录后才能反馈」：
 *   「关于项目」页邀请的是任何人 —— 有值得收录的公开资料、发现条目与原件对不上、
 *   想谈合作。要求先注册再反馈，等于把大部分反馈挡在门外。
 *
 * 代价是这里成了一个公开写入点，所以配了三道闸：
 *   1. 类型白名单 + 逐字段长度上限；超长**拒绝**而不是静默截断 ——
 *      反馈是工单，悄悄丢掉一半内容比报错更糟；
 *   2. 简易内存限流（同 IP 10 分钟最多 5 条），挡住「一个脚本灌一万条」；
 *   3. 落库失败如实回 500，不假装成功。
 *
 * ⚠️ 顺序是「**先校验、后限流**」，不能反过来：
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
import { recordEvent } from '../track/store.js'

const router = Router()

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
  // 先校验：内容不合规的直接退回，不占用频率额度（见文件头「先校验、后限流」）
  const [input, problem] = parseFeedback(req.body)
  if (!input) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_FAILED', message: problem ?? '反馈内容有误' }
    })
    return
  }

  // 后限流：只有真的要落库的请求才计数
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
