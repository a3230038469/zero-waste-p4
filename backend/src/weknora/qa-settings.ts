/**
 * 问答设置（模型 / 回答方式 / 思考强度）—— 老师后台「问答设置」卡片
 *
 * 落盘位置：backend/data/qa-settings.json（运行时文件，已 gitignore）
 *
 * 为什么自己存、不改引擎：
 *   铁律 3（不改 WeKnora 源码）+ 引擎那个 `PUT /api/v1/initialization/config/*`
 *   会清空知识库分块配置（实测踩过），绝不能碰。
 *   所以我们只在自己的层记住「老师选了什么」，提问时按需翻译成引擎认的参数。
 *
 * 每次请求都现读文件（不缓存）：老师一点「保存」，下一次提问就该生效。
 * 文件很小（几百字节），读一次的开销可以忽略；换来的是「不用重启后端」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ *
 * 取值定义（全部照抄引擎词表，不自创）
 * ------------------------------------------------------------------ */

/** 回答方式。引擎没有这个概念，是我们在提问前拼提示词实现的。 */
export type QaStyle = 'quick' | 'knowledge'

export const QA_STYLES: readonly QaStyle[] = ['quick', 'knowledge']

/** 思考强度。引擎原生参数 reasoning_effort 的合法取值（实测引擎 400 回显确认）。 */
export type ReasoningEffort =
  | 'off'
  | 'auto'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'off',
  'auto',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/** 中文名沿用 WeKnora 自己界面的叫法（frontend/src/i18n/locales/zh-CN.ts） */
export const STYLE_LABELS: Record<QaStyle, string> = {
  quick: '快速问答',
  knowledge: '知识问答'
}

export const STYLE_HINTS: Record<QaStyle, string> = {
  quick: '用三五句话简洁回答，直接给要点。答得快，适合一眼看结论。',
  knowledge: '最多 5 点，每点末尾用【资料名】注明出处。答得慢，适合要引证的时候。'
}

export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  off: '关闭',
  auto: '自动',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大'
}

/**
 * 风格指令：拼在用户问题**前面**。
 *
 * ⚠️ 注意：这是提示词层面的软约束，模型不一定 100% 照做（快速问答尤其可能展开写）。
 * 引擎的 knowledge-chat 没有「输出一律分点」这类硬开关，所以只能这样实现。
 *
 * 🔴 「知识问答」**必须写死条数上限**（2026-10-10 真机实测踩中）：
 * 本知识库有 400+ 份资料，指令若只说「每个要点注明出自哪份资料」，模型会把
 * 几乎所有相关资料都列一遍，一路写到引擎的 per-response output limit 为止，
 * 最后整条回答退化成一句「hit the model's output limit」的报错（流是通的，
 * 但内容等于废了）。加上「最多 5 点 / 只挑最相关的」之后同样的提问恢复正常。
 */
const STYLE_PROMPTS: Record<QaStyle, string> = {
  quick: '用三五句话简洁回答，直接给要点，不要展开解释，不要罗列资料。',
  knowledge:
    '分点详细回答，最多 5 点，每点末尾用【资料名】注明出自哪份资料；只挑最相关的资料，不要罗列全部。'
}

/** 空串 = 跟随引擎默认（提问时干脆不带这个字段） */
export type MaybeEffort = ReasoningEffort | ''

/* ------------------------------------------------------------------ *
 * 落盘的设置
 * ------------------------------------------------------------------ */

export interface QaSettings {
  /** 回答模型 id；空串 = 跟引擎默认（由知识库配置 summary_model_id 决定） */
  modelId: string
  style: QaStyle
  /** 思考强度；空串 = 不下发这个字段，交给引擎/智能体自己的配置 */
  reasoningEffort: MaybeEffort
  /** ISO 时间戳；空串 = 从没保存过 */
  updatedAt: string
}

/**
 * 默认值。
 *
 * style 默认 knowledge：这是个**知识库**，带出处比省字数更有用；
 * 老师觉得太啰嗦，在卡片上一键切「快速问答」即可。
 * reasoningEffort 默认空串 = 不动引擎原有行为（模型不支持思考时也不会被 400）。
 */
export const DEFAULT_QA_SETTINGS: QaSettings = {
  modelId: '',
  style: 'knowledge',
  reasoningEffort: '',
  updatedAt: ''
}

/* ------------------------------------------------------------------ *
 * 读写
 * ------------------------------------------------------------------ */

/** 与 weknora/index.ts 的 DEFAULT_DATA_DIR 同解法：src 与 dist 两种布局都落到 backend/data */
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url))

function settingsFile(): string {
  const override = (process.env.KB_DATA_DIR ?? '').trim()
  return join(override || DEFAULT_DATA_DIR, 'qa-settings.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isQaStyle(value: unknown): value is QaStyle {
  return value === 'quick' || value === 'knowledge'
}

function isEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * 读设置。
 *
 * ⚠️ 故意**永不抛异常**：这个文件坏了，最多退回默认值，
 * 绝不能让整个 AI 问答挂掉（问答是主功能，设置只是附加项）。
 */
export function loadQaSettings(): QaSettings {
  const file = settingsFile()
  if (!existsSync(file)) return { ...DEFAULT_QA_SETTINGS }

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(parsed)) return { ...DEFAULT_QA_SETTINGS }
    return {
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId.trim() : '',
      style: isQaStyle(parsed.style) ? parsed.style : DEFAULT_QA_SETTINGS.style,
      reasoningEffort: isEffort(parsed.reasoningEffort) ? parsed.reasoningEffort : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
    }
  } catch {
    return { ...DEFAULT_QA_SETTINGS }
  }
}

/** 写设置（调用方负责先校验合法性）。写失败要抛，让路由层能如实回 500。 */
export function saveQaSettings(next: QaSettings): QaSettings {
  const file = settingsFile()
  mkdirSync(join(file, '..'), { recursive: true })
  const record: QaSettings = {
    modelId: next.modelId.trim(),
    style: next.style,
    reasoningEffort: next.reasoningEffort,
    updatedAt: new Date().toISOString()
  }
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}

/* ------------------------------------------------------------------ *
 * 翻译成引擎请求
 * ------------------------------------------------------------------ */

/** 按风格把用户问题改写成带指令的提问 */
export function buildStyledQuery(query: string, style: QaStyle): string {
  const instruction = STYLE_PROMPTS[style] ?? STYLE_PROMPTS.knowledge
  return `${instruction}\n\n问题：${query}`
}

/**
 * 把设置折成要加进引擎请求体的字段。
 *
 * ⚠️ 模型字段名是 **`summary_model_id`**，不是 `model_id`：
 * 引擎的 CreateKnowledgeQARequest 没有 model_id，传了会被 json 绑定静默忽略
 * （仍返回 200，但根本没换模型）。实测确认，见 docs/接口约定.md。
 */
export function buildEngineOverrides(settings: QaSettings): Record<string, string> {
  const overrides: Record<string, string> = {}
  if (settings.modelId) overrides.summary_model_id = settings.modelId
  if (settings.reasoningEffort) overrides.reasoning_effort = settings.reasoningEffort
  return overrides
}