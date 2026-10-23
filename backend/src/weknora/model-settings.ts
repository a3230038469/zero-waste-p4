/**
 * 「模型选择」设置层（2026-10-21 新增）—— 系统设置页把引擎里的模型摆出来让老师选
 *
 * 目标：老师不用进引擎后台，就能在 /admin/settings 看到「现在用的是什么模型」，
 * 并改掉**引擎允许改的那三项**（回答 / 看图 / 重排）。
 *
 * ─────────────────────────────────────────────────────────────────
 * 🔴 哪些能改、哪些只能看（2026-10-21 逐字段实测得出，别凭直觉放宽）
 * ─────────────────────────────────────────────────────────────────
 * 能改（走智能体配置，PUT /api/v1/agents/{id} 是唯一写入口）：
 *   model_id        回答模型（KnowledgeQA 类）
 *   vlm_model_id    图片理解模型（VLLM 类）
 *   rerank_model_id 检索重排模型（Rerank 类）
 *
 * 只能看（引擎**没有**可安全调用的更新接口）：
 *   embedding_model_id  知识库的向量模型 —— 决定了全部 603 份资料的向量，
 *                       库里有向量后换模型 = 检索悄悄变差，必须在引擎后台或重建库时改
 *   summary_model_id    知识库的摘要模型
 *   解析引擎（MinerU 等） 知识库 chunking_config.parser_engine_rules
 *
 * 实测依据：PUT /api/v1/knowledge-bases/{id} 只认 name / description，
 * embedding_model_id / summary_model_id / vlm_config / chunking_config 等全部 200 静默忽略；
 * PUT|POST /{id}/config、/{id}/models、/{id}/chunking、PATCH 全 404。
 * 所以这里**只读地**把知识库绑定读出来展示，不做任何写入尝试。
 */
import { EngineError } from './types.js'
import {
  fetchKnowledgeBaseBindings,
  listEngineModels,
  type EngineKbBindings,
  type EngineModelOption
} from './index.js'
import { fetchRawAgent, updateAgentConfig, type AgentConfigPatch } from './agent-config.js'

/** 前端下拉用的一项（只给 id / 名字 / 状态，引擎内部结构不外泄） */
export interface ModelOption {
  id: string
  name: string
  status: string
}

/** 按类型分好组的模型清单 */
export interface ModelGroups {
  /** 回答模型（KnowledgeQA） */
  qa: ModelOption[]
  /** 图片理解模型（VLLM） */
  vlm: ModelOption[]
  /** 向量模型（Embedding） */
  embedding: ModelOption[]
  /** 重排模型（Rerank） */
  rerank: ModelOption[]
}

/** 智能体上当前绑定的三项（可改） */
export interface AgentModelBindings {
  model_id: string
  vlm_model_id: string
  rerank_model_id: string
}

/** GET /api/admin/model-settings 的响应体 */
export interface ModelSettingsView {
  success: true
  models: ModelGroups
  /** 非空 = 引擎模型列表没拉到（接口本身仍 200，老师至少能看到「现在用的是什么」） */
  modelsError: string
  /** 可改的三项：智能体上当前的绑定 */
  current: AgentModelBindings
  /** 只读：知识库上的绑定（拉不到就是 null，原因在 kbError） */
  kb: EngineKbBindings | null
  kbError: string
  /** 三行只读项为什么不能改 —— 页面直接展示，别让老师以为是我们没做 */
  notes: { embedding: string; summary: string; parser: string }
}

/** 只读项的统一说明（前端原样展示；口径要跟 docs/接口约定.md 一致） */
const NOTES = {
  embedding:
    '向量模型决定全部资料怎么被检索，库里已经有向量后换它会悄悄变差。引擎没有提供修改接口，要换代请进引擎后台、或导入新库时选定。',
  summary:
    '摘要模型只影响资料卡片的摘要文字，不影响检索与引用。引擎没有提供修改接口，要换请进引擎后台或重建库。',
  parser:
    '解析引擎（PDF/Word 怎么抽正文）由知识库配置决定，引擎没有提供修改接口。要换请进引擎后台或重建库。'
}

function toOptions(models: EngineModelOption[], type: string): ModelOption[] {
  return models
    .filter((m) => m.type === type)
    .map((m) => ({ id: m.id, name: m.name, status: m.status }))
}

/** 读「模型选择」全量视图：模型清单 + 当前绑定（可改三项 + 只读三项） */
export async function getModelSettingsView(): Promise<ModelSettingsView> {
  let models: EngineModelOption[] = []
  let modelsError = ''
  try {
    models = await listEngineModels()
  } catch (err) {
    // 模型列表拉不到不影响「现在用的是什么」—— 与 /agent、/qa-settings 同款口径
    modelsError = err instanceof EngineError ? err.message : '模型列表读取失败，请稍后再试'
  }

  const agent = await fetchRawAgent()
  const current: AgentModelBindings = {
    model_id: typeof agent.config['model_id'] === 'string' ? agent.config['model_id'] : '',
    vlm_model_id: typeof agent.config['vlm_model_id'] === 'string' ? agent.config['vlm_model_id'] : '',
    rerank_model_id:
      typeof agent.config['rerank_model_id'] === 'string' ? agent.config['rerank_model_id'] : ''
  }

  let kb: EngineKbBindings | null = null
  let kbError = ''
  try {
    kb = await fetchKnowledgeBaseBindings()
  } catch (err) {
    kbError = err instanceof EngineError ? err.message : '知识库配置读取失败，请稍后再试'
  }

  return {
    success: true,
    models: {
      qa: toOptions(models, 'KnowledgeQA'),
      vlm: toOptions(models, 'VLLM'),
      embedding: toOptions(models, 'Embedding'),
      rerank: toOptions(models, 'Rerank')
    },
    modelsError,
    current,
    kb,
    kbError,
    notes: NOTES
  }
}

/** 可改的三个字段 → 期望的模型类型（类型不对 = 引擎会静默回退默认模型，必须提前拦住） */
const MODEL_FIELDS: Array<{ key: 'model_id' | 'vlm_model_id' | 'rerank_model_id'; type: string; label: string }> = [
  { key: 'model_id', type: 'KnowledgeQA', label: '回答模型' },
  { key: 'vlm_model_id', type: 'VLLM', label: '图片理解模型' },
  { key: 'rerank_model_id', type: 'Rerank', label: '检索重排模型' }
]

/** PUT /api/admin/model-settings 的响应体 */
export interface SaveModelSettingsResult {
  success: true
  message: string
  /** 这次真正改动的字段 */
  changed: string[]
  /** 传了空串被忽略的字段（空串 = 不改，不是清空） */
  ignored: string[]
  /** 保存后重新读到的视图（页面直接用，不靠本地猜） */
  view: ModelSettingsView
}

/**
 * 保存三项模型绑定。
 *
 * 校验顺序（不可换）：
 *   1. 先拉模型清单 —— 拉不到就 502，绝不盲写（引擎对不存在的 model_id 是**静默回退**）
 *   2. 逐字段校验「必须是字符串 + 必须真实存在 + 必须是对应类型」
 *   3. 交给 updateAgentConfig（GET 全量 → 合并 → PUT 完整 config → 回读校验）
 *   4. 重新读一遍视图返回给页面
 */
export async function saveModelSettings(raw: unknown): Promise<SaveModelSettingsResult> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EngineError('INVALID_MODEL_FIELD', '请求体得是一个对象', 400)
  }
  const body = raw as Record<string, unknown>

  let models: EngineModelOption[]
  try {
    models = await listEngineModels()
  } catch (err) {
    throw new EngineError(
      'ENGINE_UNREACHABLE',
      `连不上引擎，没法验模型是否存在：${err instanceof Error ? err.message : '未知错误'}`,
      502
    )
  }

  const patch: AgentConfigPatch = {}
  for (const field of MODEL_FIELDS) {
    if (!(field.key in body)) continue
    const value = body[field.key]
    if (value === null || value === undefined) continue
    if (typeof value !== 'string') {
      throw new EngineError('INVALID_MODEL_FIELD', `${field.key} 得是字符串`, 400)
    }
    // 空串 = 「不改这一项」（与智能体设置同一口径，清空输入框不该变成 400）
    if (value.trim() === '') continue
    const hit = models.find((m) => m.id === value)
    if (!hit) {
      throw new EngineError(
        'MODEL_NOT_AVAILABLE',
        `引擎里没有这个模型（可能已被删除），请重新选一个：${field.label}`,
        400
      )
    }
    if (hit.type !== field.type) {
      throw new EngineError(
        'MODEL_TYPE_MISMATCH',
        `${field.label}只能选 ${field.type} 类模型，${hit.name} 是 ${hit.type} 类`,
        400
      )
    }
    if (field.key === 'model_id') patch.model_id = value
    if (field.key === 'vlm_model_id') patch.vlm_model_id = value
    if (field.key === 'rerank_model_id') patch.rerank_model_id = value
  }

  if (Object.keys(patch).length === 0) {
    throw new EngineError('NOTHING_TO_SAVE', '没有要改的模型（三项都是空或没传）', 400)
  }

  const qaModels = models
    .filter((m) => m.type === 'KnowledgeQA')
    .map((m) => ({ id: m.id, name: m.name, status: m.status }))
  const result = await updateAgentConfig(patch, qaModels)

  return {
    success: true,
    message: result.message,
    changed: result.changed,
    ignored: result.ignored,
    view: await getModelSettingsView()
  }
}

