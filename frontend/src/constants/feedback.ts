/**
 * 反馈的取值与提交口径 —— B09（2026-10-13 新增）
 *
 * **单一真相来源**：资料级四个原因 / 站点级四个分类 / 留言字数上限 / 提交 payload 形状。
 * 反馈弹窗（components/FeedbackDialog.vue）与「我要投稿」页的反馈 Tab（views/ContributeView.vue）
 * 共用本文件 —— 两处各抄一份常量，早晚会漂。
 *
 * 落库口径（2026-10-19 改）：**走正规接口 `POST /api/feedback`**。
 *   此前弹窗只往 `POST /api/track` 记一条 `feedback_submit` 埋点、不写反馈表，
 *   结果后台「访客反馈」页永远读不到（它只读 feedback.jsonl）——
 *   收得进来、看得见、能导出，三者缺一不可，所以这里改走正路；
 *   埋点由后端在落库成功后自己补记（不会再出现「只有埋点、没有工单」的情况）。
 *   payload 形状：
 *   doc  → { kind, reason: 'broken'|'wrong'|'duplicate'|'missing', scope: 'doc', message, contact, docId, docTitle, path }
 *   site → { kind, reason: 'feature'|'content'|'usage'|'other',  scope: 'site', message, contact, path }
 *   `reason` 原样存进反馈表（后台按它分类），`kind` 只是粗分组，映射见下面 KIND_BY_*。
 *
 * ⚠️ 改下面的取值等于改数据口径，要同步 docs/接口约定.md。
 */
import { submitFeedback as postFeedback } from '../api/feedback'

/** 资料级反馈的四个原因（对外是单选，对内是 reason 的取值） */
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

/**
 * 细分原因 → 后台粗分组（要和 backend/src/feedback/store.ts 的 FEEDBACK_KINDS 对齐）。
 * 资料级：打不开/有误/重复 都是「需要改」，归 correction；希望补充 = 推荐资料。
 * 站点级：内容建议本质是「希望有这类资料」，归 recommend；其余都归 other。
 */
const KIND_BY_DOC_REASON: Record<string, 'correction' | 'recommend'> = {
  broken: 'correction',
  wrong: 'correction',
  duplicate: 'correction',
  missing: 'recommend'
}
const KIND_BY_SITE_REASON: Record<string, 'recommend' | 'other'> = {
  feature: 'other',
  content: 'recommend',
  usage: 'other',
  other: 'other'
}

/**
 * 留言上限。
 *
 * ⚠️ 2026-10-21（T3 · P2-8）：原来这里是 300 字，后端 `api/feedback.ts`
 *   的 FEEDBACK_MAX_MESSAGE_CHARS 是 2000 —— 两边不一致，用户写满 300 字就被
 *   前端**静默截断**（提交函数里直接 .slice），反馈内容丢了还不告诉他。
 *   现在以**后端 2000 字**为准，前端同一套上限，超长时明确报错而不是悄悄截断。
 */
export const FEEDBACK_TEXT_MAX = 2000

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
  /** 登录用户 id；匿名传 null。⚠️ 反馈表本身不记身份，只用于埋点归类 */
  userId?: string | null
}

/**
 * 提交一条反馈。
 *
 * ⚠️ 与旧版最大的区别：**失败会抛错**（`Error`，message 可直接展示）。
 *   反馈是工单，提交失败必须让用户知道，不能像埋点那样悄悄咽掉 ——
 *   旧版吞掉异常再报「已提交」，用户以为提了、其实丢了。
 */
export async function submitFeedback(input: FeedbackInput): Promise<void> {
  const isDoc = input.scope === 'doc'
  const kind = isDoc
    ? (KIND_BY_DOC_REASON[input.reason] ?? 'other')
    : (KIND_BY_SITE_REASON[input.reason] ?? 'other')

  const text = input.text.trim()
  // 超长**明确报错**，不再静默截断（静默截断 = 用户以为提交了完整内容）
  if (text.length > FEEDBACK_TEXT_MAX) {
    throw new Error('留言最长 ' + FEEDBACK_TEXT_MAX + ' 字，请删掉超出部分再提交。')
  }

  await postFeedback({
    kind,
    message: text,
    contact: input.contact.trim(),
    reason: input.reason,
    scope: input.scope,
    docId: isDoc ? (input.docId ?? '') : '',
    docTitle: isDoc ? (input.docTitle ?? '') : '',
    path: input.path ?? ''
  })
}
