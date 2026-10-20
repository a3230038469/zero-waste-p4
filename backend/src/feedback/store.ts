/**
 * 反馈 · 落库与读取（2026-10-14 新增）
 *
 * 存储与埋点同款：JSONL 追加文件（`backend/data/feedback.jsonl`，每行一条）。
 * 理由同 `track/store.ts` —— 零新依赖、零迁移、量级小；将来要换数据库只改本文件。
 *
 * 为什么不复用埋点（track）那张表：
 *   埋点是**计数**用的（谁点了什么，只看聚合），反馈是**要读内容**的工单
 *   （某位老师说了什么、要把哪份资料改掉）。两者的读取权限与生命周期都不同：
 *   看板只给聚合数字，反馈要能逐条读、还要能导出给基金会跟进。混在一起两边都别扭。
 *   但提交成功时仍会**顺带记一条 `feedback_submit` 埋点**（在路由里做），
 *   这样看板上照样能看到反馈量的趋势。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

/* ------------------------------------------------------------------ *
 * 契约：类型与取值
 * ------------------------------------------------------------------ */

/** 反馈类型白名单（前端下拉与后端校验共用同一套取值，**别自创别名**） */
export const FEEDBACK_KINDS = ['recommend', 'correction', 'cooperation', 'other'] as const

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

/** 中文名（后台列表与导出的表头用） */
export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  recommend: '资料推荐',
  correction: '纠错',
  cooperation: '合作',
  other: '其他'
}

/**
 * 细分原因白名单（2026-10-19 新增）。
 *
 * 为什么要有它：前台反馈是**按场景**让用户选的 ——
 *   资料页给的是「文件打不开 / 内容有误 / 内容重复 / 希望补充相关内容」，
 *   站点页给的是「功能建议 / 内容建议 / 使用问题 / 其他」。
 * 上面那 4 个 kind 是给后台做粗分组用的，颗粒度不够；
 * 老师要判断「这条要不要动手改」，看的是用户当初点的那个选项，所以原样存下来。
 * 取值必须与 `frontend/src/constants/feedback.ts` 的 DOC_REASONS / SITE_KINDS 一致。
 */
export const FEEDBACK_REASONS = [
  'broken',
  'wrong',
  'duplicate',
  'missing',
  'feature',
  'content',
  'usage',
  'other'
] as const

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number]

/** 细分原因的中文名（后台列表与导出共用；前端不再各写一份） */
export const FEEDBACK_REASON_LABELS: Record<string, string> = {
  broken: '文件打不开 / 无法预览下载',
  wrong: '内容有误（标题、机构、年份等）',
  duplicate: '内容重复收录',
  missing: '希望补充相关内容',
  feature: '功能建议',
  content: '内容建议',
  usage: '使用问题',
  other: '其他'
}

/** 反馈提交的场景（资料级 / 站点级） */
export const FEEDBACK_SCOPES = ['doc', 'site'] as const

export type FeedbackScope = (typeof FEEDBACK_SCOPES)[number]


/** 各字段长度上限（超出按**拒绝**处理，不静默截断 —— 反馈是工单，不能悄悄丢内容） */
export const FEEDBACK_MAX_MESSAGE_CHARS = 2000
export const FEEDBACK_MAX_CONTACT_CHARS = 120
export const FEEDBACK_MAX_DOC_TITLE_CHARS = 200

/** 一条落库的反馈 */
export interface StoredFeedback {
  /** 反馈编号 */
  id: string
  /** 提交时刻，ISO 8601 */
  ts: string
  kind: FeedbackKind
  /** 细分原因（FEEDBACK_REASONS 取值；老数据可能为空串） */
  reason: string
  /** 提交场景：doc = 针对某份资料，site = 针对站点 */
  scope: FeedbackScope
  /** 反馈正文 */
  message: string
  /** 联系方式（选填）。⚠️ 属个人信息，只给管理者看，不出现在任何对外页面 */
  contact: string
  /** 针对哪份资料（选填，纠错时有用） */
  docId: string
  docTitle: string
  /** 来源页面（路由 fullPath） */
  path: string
}

/* ------------------------------------------------------------------ *
 * 落库位置
 * ------------------------------------------------------------------ */

/** 默认落库位置：backend/data/feedback.jsonl（src 与 dist 两种布局都落到同一处） */
const DEFAULT_FEEDBACK_FILE = fileURLToPath(new URL('../../data/feedback.jsonl', import.meta.url))

function feedbackFile(): string {
  const override = (process.env.FEEDBACK_FILE ?? '').trim()
  return override ? resolve(override) : DEFAULT_FEEDBACK_FILE
}

export function feedbackFilePath(): string {
  return feedbackFile()
}

/* ------------------------------------------------------------------ *
 * 写入 / 读取
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 追加一条反馈。**这条会抛** —— 反馈写不进去必须如实告诉提交者，不能假装成功。 */
export function appendFeedback(record: StoredFeedback): void {
  const file = feedbackFile()
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/** 读全量反馈（按提交时间倒序）。文件不存在返回空数组（全新环境不算错）。 */
export function readFeedback(): StoredFeedback[] {
  const file = feedbackFile()
  if (!existsSync(file)) return []

  const parsed: StoredFeedback[] = []
  let broken = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const value: unknown = JSON.parse(text)
      // 只跳过坏行，不让一行坏数据废掉整份反馈
      if (isRecord(value) && typeof value.message === 'string') {
        parsed.push(value as unknown as StoredFeedback)
      } else {
        broken += 1
      }
    } catch {
      broken += 1
    }
  }
  if (broken > 0) console.warn(`[feedback] 跳过 ${broken} 行无法解析的反馈记录：${file}`)

  return parsed.sort((a, b) => b.ts.localeCompare(a.ts))
}

/* ------------------------------------------------------------------ *
 * 解析与校验
 * ------------------------------------------------------------------ */

export interface FeedbackInput {
  kind: FeedbackKind
  reason: string
  scope: FeedbackScope
  message: string
  contact: string
  docId: string
  docTitle: string
  path: string
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value.trim() : ''
}

function isKind(value: string): value is FeedbackKind {
  return (FEEDBACK_KINDS as readonly string[]).includes(value)
}

function isReason(value: string): value is FeedbackReason {
  return (FEEDBACK_REASONS as readonly string[]).includes(value)
}

/**
 * 校验并归一化提交内容。
 *
 * ⚠️ 刻意**不记录提交者身份**（不读登录态）：反馈不需要知道「谁」，需要的是
 *   「怎么联系回去」—— 那是可选的 contact 字段，由提交者自己决定给不给。
 *   少存一份身份，就少一份个人信息；也避免依赖 auth 模块的内部实现。
 *
 * @returns [输入, null] 通过；[null, 错误原因] 被拒
 */
export function parseFeedback(raw: unknown): [FeedbackInput | null, string | null] {
  if (!isRecord(raw)) return [null, '请求体需为对象']

  const kind = readString(raw, 'kind') || 'other'
  if (!isKind(kind)) {
    return [null, `反馈类型只能是 ${FEEDBACK_KINDS.join(' / ')} 之一`]
  }

  const message = readString(raw, 'message')
  if (!message) return [null, '请写一下反馈内容']
  if (message.length > FEEDBACK_MAX_MESSAGE_CHARS) {
    return [null, `反馈内容最多 ${FEEDBACK_MAX_MESSAGE_CHARS} 字，当前 ${message.length} 字`]
  }

  const contact = readString(raw, 'contact')
  if (contact.length > FEEDBACK_MAX_CONTACT_CHARS) {
    return [null, `联系方式最多 ${FEEDBACK_MAX_CONTACT_CHARS} 字`]
  }

  const docTitle = readString(raw, 'docTitle')
  if (docTitle.length > FEEDBACK_MAX_DOC_TITLE_CHARS) {
    return [null, `资料标题最多 ${FEEDBACK_MAX_DOC_TITLE_CHARS} 字`]
  }

  // 细分原因与场景都是**选填**：老调用方（只传 kind/message）照旧能用，
  // 传了不认识的取值就退回空串，不因为一个附加字段把整条反馈拒掉。
  const reasonRaw = readString(raw, 'reason')
  const reason = isReason(reasonRaw) ? reasonRaw : ''
  const scopeRaw = readString(raw, 'scope')
  const docId = readString(raw, 'docId')
  const scope: FeedbackScope =
    scopeRaw === 'doc' || scopeRaw === 'site' ? scopeRaw : docId ? 'doc' : 'site'

  return [
    {
      kind,
      reason,
      scope,
      message,
      contact,
      docId,
      docTitle,
      path: readString(raw, 'path')
    },
    null
  ]
}

/** 把校验过的输入落成一条可存的反馈（补上编号与时间） */
export function buildFeedback(input: FeedbackInput): StoredFeedback {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    kind: input.kind,
    reason: input.reason,
    scope: input.scope,
    message: input.message,
    contact: input.contact,
    docId: input.docId,
    docTitle: input.docTitle,
    path: input.path
  }
}
