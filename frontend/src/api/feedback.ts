/**
 * 反馈接口客户端（2026-10-14 新增）
 *
 * 对应后端 `POST /api/feedback`（匿名可提交，无需登录）。
 * 类型取值与后端 `backend/src/feedback/store.ts` 的 `FEEDBACK_KINDS` **逐一对应**，别自创别名。
 */
import http from './http'

/** 反馈类型（与后端白名单一致） */
export const FEEDBACK_KINDS = ['recommend', 'correction', 'cooperation', 'other'] as const

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  recommend: '资料推荐',
  correction: '纠错',
  cooperation: '合作',
  other: '其他'
}

/** 每个类型的补充说明，帮提交者选对 */
export const FEEDBACK_KIND_HINTS: Record<FeedbackKind, string> = {
  recommend: '有值得收录的公开资料',
  correction: '条目信息与原件不符',
  cooperation: '教学、研究或公益项目协作',
  other: '其他想说的'
}

/** 与后端一致的长度上限（前端先拦一道，省一次往返） */
export const FEEDBACK_MAX_MESSAGE_CHARS = 2000
export const FEEDBACK_MAX_CONTACT_CHARS = 120

export interface FeedbackSubmit {
  kind: FeedbackKind
  message: string
  /** 选填。提交者自愿留下的联系方式 */
  contact?: string
  /** 选填。针对哪份资料（纠错时由详情页带过来） */
  docId?: string
  docTitle?: string
  /** 来源页面（路由 fullPath），便于定位问题 */
  path?: string
}

/**
 * 提交一条反馈。
 *
 * 失败时抛 `Error`，message 是可直接展示给用户的中文
 * （后端给的是中文原因，拿不到再退回一句人话）。
 * `silent: true` 是为了不让统一拦截器再补一条格式化的通用提示 —— 表单自己有错误位。
 */
export async function submitFeedback(payload: FeedbackSubmit): Promise<void> {
  try {
    await http.post('/feedback', payload, { silent: true })
  } catch (err) {
    const message = (
      err as { response?: { data?: { error?: { message?: string } } } }
    ).response?.data?.error?.message
    throw new Error(message || '提交失败，请稍后再试')
  }
}
