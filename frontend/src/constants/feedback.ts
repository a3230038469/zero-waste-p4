/**
 * 反馈的取值与提交口径 —— B09（2026-10-13 新增）
 *
 * **单一真相来源**：资料级四个原因 / 站点级四个分类 / 留言字数上限 / 提交 payload 形状。
 * 反馈弹窗（components/FeedbackDialog.vue）与「我要投稿」页的反馈 Tab（views/ContributeView.vue）
 * 共用本文件 —— 两处各抄一份常量，早晚会漂。
 *
 * 落库口径：**不新增接口、不新增事件名**，走已有的 POST /api/track，用白名单里现成的
 * `feedback_submit`（真相来源：backend/src/track/types.ts）。payload 形状：
 *   doc  → { kind: 'doc', docId, docTitle, reason, text, contact }
 *   site → { kind: 'site', path, reason, text, contact }
 *
 * ⚠️ 改下面的取值等于改数据口径（看板按 payload.reason 分类），要同步 docs/接口约定.md。
 */
import { trackEvent } from '../api/track'

/** 资料级反馈的四个原因（对外是单选，对内是 payload.reason 的取值） */
export const DOC_REASONS = [
  { value: 'broken', label: '文件打不开 / 无法预览下载' },
  { value: 'wrong', label: '内容有误（标题、机构、年份等）' },
  { value: 'duplicate', label: '内容重复收录' },
  { value: 'missing', label: '希望补充相关内容' }
] as const

/** 站点级反馈的四个分类 */
export const SITE_KINDS = [
  { value: 'feature', label: '功能建议' },
  { value: 'content', label: '内容建议' },
  { value: 'usage', label: '使用问题' },
  { value: 'other', label: '其他' }
] as const

/** 留言上限（payload 整体限 4000 字符，这里留足余量） */
export const FEEDBACK_TEXT_MAX = 300

/** 站点级反馈的必填提示语（弹窗与页面共用同一句，避免两处口径不一致） */
export const SITE_FEEDBACK_HINT =
  '使用中遇到问题，或希望站点增加什么功能，都可以写在这里。你的反馈会进入后台统计，我们逐条看。'

export interface FeedbackInput {
  scope: 'doc' | 'site'
  /** DOC_REASONS / SITE_KINDS 里的 value */
  reason: string
  text: string
  contact: string
  /** scope='doc' 时必传 */
  docId?: string
  docTitle?: string
  /** 页面来源（路由 fullPath），便于按页面定位问题 */
  path?: string
  /** 登录用户 id；匿名传 null */
  userId?: string | null
}

/** 提交一条反馈。埋点本身是尽力而为的旁路（见 api/track.ts），失败不抛错、不影响页面 */
export async function submitFeedback(input: FeedbackInput): Promise<void> {
  const isDoc = input.scope === 'doc'
  const payload: Record<string, unknown> = {
    kind: isDoc ? 'doc' : 'site',
    reason: input.reason,
    text: input.text.trim().slice(0, FEEDBACK_TEXT_MAX),
    contact: input.contact.trim()
  }
  if (isDoc) {
    payload.docId = input.docId ?? ''
    payload.docTitle = input.docTitle ?? ''
  } else {
    payload.path = input.path ?? ''
  }

  await trackEvent({
    event: 'feedback_submit',
    userId: input.userId ?? null,
    path: input.path ?? '',
    payload
  })
}
