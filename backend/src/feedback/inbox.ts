/**
 * 反馈收件箱 —— 把两条历史路径并成一份列表（2026-10-19 新增）
 *
 * 背景：站上的反馈一度是**两个入口、两条落点**：
 *   1. 正规入口 `POST /api/feedback` → `backend/data/feedback.jsonl`（要读内容的工单）；
 *   2. 反馈弹窗（B09）只往 `POST /api/track` 记一条 `feedback_submit` 埋点（只有计数）。
 * 后果：弹窗提交的反馈在看板上看得到数字，却在「访客反馈」页里一条都看不到 ——
 * 那个页面只读 `feedback.jsonl`，而当时**没有任何页面在写它**（写它的组件没人引用），
 * 于是文件根本不存在、页面永远是空的。
 *
 * 2026-10-19 起前端统一改走正规入口（埋点由后端在落库成功后补记），但**历史埋点不能丢**：
 * 老师之前提过的反馈只存在于埋点里，所以本模块把两边合起来读。
 *
 * 去重规则：`path === '/api/feedback'` 的 `feedback_submit` 事件是正规落库的**镜像**
 *   （见 `routes/feedback.ts`：落库成功后才补记），一律跳过；
 *   否则同一条反馈会在列表里出现两次。
 *
 * 本模块只读、不写；字段口径与 `store.ts` 保持一致。
 */
import { FEEDBACK_KIND_LABELS, FEEDBACK_REASON_LABELS, readFeedback } from './store.js'
import { readEvents } from '../track/store.js'

/** 收件箱里的一条（两种来源统一成同一个形状，前端只认这一份） */
export interface InboxItem {
  id: string
  ts: string
  /** form = 正规落库（反馈表）；event = 只有历史埋点（弹窗时代的旧数据） */
  source: 'form' | 'event'
  kind: string
  kindLabel: string
  reason: string
  reasonLabel: string
  message: string
  contact: string
  docId: string
  docTitle: string
  path: string
  /** 提交者账号 id（仅埋点来源有；匿名为空串） */
  userId: string
  /** 提交者姓名（在路由里查库补上；空串 = 匿名） */
  userName: string
}

/** 埋点来源的 kind 取值 → 后台显示用的中文名 */
const EVENT_KIND_LABELS: Record<string, string> = {
  doc: '资料反馈',
  site: '站点建议'
}

/** 事件 payload 里的字符串字段（埋点是自由形状，读到什么算什么，不猜） */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** 正规落库的那条路径 —— 它的埋点事件是镜像，要跳过 */
const MIRROR_PATH = '/api/feedback'

/**
 * 读全部反馈：正规落库的在前、历史埋点在后的排序由 ts 统一决定（倒序）。
 *
 * @returns 按提交时间倒序的收件箱
 */
export function readFeedbackInbox(): InboxItem[] {
  const fromStore: InboxItem[] = readFeedback().map((item) => ({
    id: item.id,
    ts: item.ts,
    source: 'form',
    kind: item.kind,
    kindLabel: FEEDBACK_KIND_LABELS[item.kind] ?? item.kind,
    reason: item.reason ?? '',
    reasonLabel: FEEDBACK_REASON_LABELS[item.reason] ?? '',
    message: item.message,
    contact: item.contact,
    docId: item.docId,
    docTitle: item.docTitle,
    path: item.path,
    userId: '',
    userName: ''
  }))

  const fromEvents: InboxItem[] = []
  let index = 0
  for (const ev of readEvents()) {
    if (ev.event !== 'feedback_submit') continue
    if (ev.path === MIRROR_PATH) continue

    const payload = ev.payload ?? {}
    const rawKind = readString(payload, 'kind')
    const reason = readString(payload, 'reason')
    index += 1

    fromEvents.push({
      // 埋点没有 id，用「时刻 + 序号」拼一个稳定的 key（列表 :key 与导出都要唯一）
      id: `evt-${ev.ts}-${index}`,
      ts: ev.ts,
      source: 'event',
      kind: rawKind || 'site',
      kindLabel:
        FEEDBACK_KIND_LABELS[rawKind as keyof typeof FEEDBACK_KIND_LABELS] ??
        EVENT_KIND_LABELS[rawKind] ??
        '反馈',
      reason,
      reasonLabel: FEEDBACK_REASON_LABELS[reason] ?? '',
      message: readString(payload, 'text'),
      contact: readString(payload, 'contact'),
      docId: readString(payload, 'docId'),
      docTitle: readString(payload, 'docTitle'),
      path: readString(payload, 'path') || ev.path,
      userId: ev.userId ?? '',
      userName: ''
    })
  }

  return [...fromStore, ...fromEvents].sort((a, b) => b.ts.localeCompare(a.ts))
}
