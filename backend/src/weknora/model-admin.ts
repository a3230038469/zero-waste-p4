/**
 * 模型管理（管理台）—— 2026-10-22 新增
 *
 * 把引擎自带「模型管理」界面的能力搬到我们自己的管理台，只做三件事：
 *   1. 列出 / 新增 / 换密钥 / 测试 / 删除 **对话、视觉、重排** 三类模型；
 *   2. 向量模型（Embedding）**只读**：能看，不能在这里增删改 ——
 *      库里有 603 份资料的向量，换掉它检索会悄悄变差；
 *   3. 删除前查「是不是正在被用」，命中就拦下来（引擎自己不会拦）。
 *
 * 引擎接口（WeKnora v0.8.2，已在本机实测过权限）：
 *   GET    /api/v1/models                         列表（credentials 只回 configured 布尔）
 *   GET    /api/v1/models/providers               厂商目录（含默认地址、中文名）
 *   POST   /api/v1/models                         新建
 *   GET    /api/v1/models/{id}                    单条（更新前拿全量参数）
 *   PUT    /api/v1/models/{id}                    改名字/地址（⚠️ parameters 是整体替换）
 *   PUT    /api/v1/models/{id}/credentials        只换 api_key
 *   POST   /api/v1/models/{id}/debug              模型测试（发一句话看回不回）
 *   DELETE /api/v1/models/{id}                    删除
 *
 * 🔴 两条实测得来的坑：
 *   - PUT /models/{id} 会**整体替换 parameters**，且 `source` / `type` 也会被覆盖。
 *     所以更新前必须 GET 全量、原样带回，只改要改的那一个字段（见 updateEngineModel）。
 *   - api_key 不走 PUT /models/{id}（引擎会忽略并记一条 warn），只能走 /credentials。
 */
import { EngineError } from './types.js'
import { engineRequest, fetchKnowledgeBaseBindings } from './index.js'
import { fetchRawAgent } from './agent-config.js'

/** 前端分组（与引擎的 type 一一对应） */
export type ModelGroup = 'chat' | 'vision' | 'rerank' | 'embedding' | 'other'

const ENGINE_TYPE_BY_GROUP: Record<string, string> = {
  chat: 'KnowledgeQA',
  vision: 'VLLM',
  rerank: 'Rerank',
  embedding: 'Embedding'
}

const GROUP_BY_ENGINE_TYPE: Record<string, ModelGroup> = {
  KnowledgeQA: 'chat',
  VLLM: 'vision',
  Rerank: 'rerank',
  Embedding: 'embedding'
}

/** 只允许在这三类里增删改；embedding 只读 */
const EDITABLE_GROUPS: ModelGroup[] = ['chat', 'vision', 'rerank']

/** 给前端的一张模型卡 */
export interface AdminModelItem {
  id: string
  /** 引擎里的模型名（调厂商时用的那个，如 gpt-4o-mini） */
  name: string
  /** 展示名 */
  displayName: string
  /** 引擎原值（KnowledgeQA / VLLM / Rerank / Embedding） */
  type: string
  group: ModelGroup
  provider: string
  providerLabel: string
  baseUrl: string
  /** 引擎只回「配没配」，原值永远拿不到 */
  keyConfigured: boolean
  isBuiltin: boolean
  status: string
  contextWindow: number
  dimension: number
  /** 正在被谁用：['问答模型'] / ['向量模型'] / [] */
  inUse: string[]
  /** 是否允许在这里改/删（内置模型与向量模型都是 false） */
  editable: boolean
}

/** 厂商目录的一项（只留页面要用的字段） */
export interface ModelProviderOption {
  value: string
  label: string
  description: string
  /** 引擎的类型 → 默认地址（chat / vllm / rerank / embedding） */
  defaultUrls: Record<string, string>
  /** 这家厂商支持哪些类型（chat / vllm / rerank / embedding / asr） */
  modelTypes: string[]
}

export interface ModelAdminView {
  models: AdminModelItem[]
  providers: ModelProviderOption[]
  /** 厂商目录读不到时的原因（列表本身仍然可用） */
  providersError: string
  /** 绑定关系读不到时的原因（删除保护会退化成「拒绝删除」） */
  bindingsError: string
}

/* ---------------- 小工具 ---------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) return Number(value)
  return 0
}

/** 引擎错误信封里的可读原因（管理台可以看英文原文，但截断，避免刷屏） */
function engineReason(res: { payload: unknown; text: string }, fallback: string): string {
  if (isRecord(res.payload)) {
    const error = res.payload['error']
    if (isRecord(error)) {
      const message = error['message']
      if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 240)
    }
    const message = res.payload['message']
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 240)
  }
  const text = res.text.trim()
  return text ? text.slice(0, 240) : fallback
}

function throwEngine(res: { status: number; payload: unknown; text: string }, fallback: string): never {
  const reason = engineReason(res, fallback)
  const status = res.status === 409 ? 409 : res.status === 400 ? 400 : 502
  throw new EngineError('ENGINE_MODEL_REJECTED', `${fallback}（引擎：${reason}）`, status)
}

/**
 * 地址只做最低限度的检查：必须是 http/https 且有主机名。
 *
 * ⚠️ **不**在这里拦内网 / 回环地址：我们的后端不会去请求这个地址，
 *    真正发请求的是引擎；而且引擎里现有的重排模型用的就是
 *    `http://host.docker.internal:11436`（Docker 内部地址），拦了会把正常配置改坏。
 *    引擎自己在 CreateModel / UpdateModel 里有 SSRF 校验（ValidateURLForSSRF），
 *    内网地址由它把关。
 */
function assertBaseUrl(raw: string): string {
  const value = raw.trim()
  if (!value) throw new EngineError('BAD_INPUT', '模型地址不能为空', 400)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new EngineError('BAD_INPUT', '模型地址格式不对（要形如 https://api.example.com/v1）', 400)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EngineError('BAD_INPUT', '模型地址只支持 http / https', 400)
  }
  if (!parsed.hostname) {
    throw new EngineError('BAD_INPUT', '模型地址缺少主机名', 400)
  }
  return value
}

/* ---------------- 读 ---------------- */

/** 当前绑定关系：模型 id → 用途标签 */
async function readUsage(): Promise<{ usage: Map<string, string[]>; error: string }> {
  const usage = new Map<string, string[]>()
  const add = (id: string, label: string): void => {
    if (!id) return
    const list = usage.get(id) ?? []
    if (!list.includes(label)) list.push(label)
    usage.set(id, list)
  }
  const failed: string[] = []

  try {
    const agent = await fetchRawAgent()
    add(str(agent.config['model_id']), '问答模型')
    add(str(agent.config['vlm_model_id']), '看图模型')
    add(str(agent.config['rerank_model_id']), '重排模型')
  } catch {
    failed.push('智能体配置')
  }
  try {
    const kb = await fetchKnowledgeBaseBindings()
    add(kb.embeddingModelId, '向量模型')
    add(kb.summaryModelId, '摘要模型')
    add(kb.vlmModelId, '看图模型')
  } catch {
    failed.push('知识库配置')
  }

  return {
    usage,
    error: failed.length ? `没能读到${failed.join('、')}的当前绑定` : ''
  }
}

/** 读厂商目录 */
async function readProviders(): Promise<{ list: ModelProviderOption[]; error: string }> {
  const res = await engineRequest('/api/v1/models/providers')
  if (res.status !== 200 || !isRecord(res.payload)) {
    return { list: [], error: engineReason(res, '厂商列表读取失败') }
  }
  const rows = Array.isArray(res.payload['data']) ? (res.payload['data'] as unknown[]) : []
  const list: ModelProviderOption[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const value = str(row['value'])
    if (!value) continue
    const labels = isRecord(row['labels']) ? row['labels'] : {}
    const descriptions = isRecord(row['descriptions']) ? row['descriptions'] : {}
    const defaultUrls: Record<string, string> = {}
    if (isRecord(row['defaultUrls'])) {
      for (const [k, v] of Object.entries(row['defaultUrls'])) {
        if (typeof v === 'string' && v) defaultUrls[k] = v
      }
    }
    list.push({
      value,
      label: str(labels['zh-CN']) || str(row['label']) || value,
      description: str(descriptions['zh-CN']) || str(row['description']),
      defaultUrls,
      modelTypes: Array.isArray(row['modelTypes'])
        ? (row['modelTypes'] as unknown[]).filter((t): t is string => typeof t === 'string')
        : []
    })
  }
  return { list, error: '' }
}

/** 管理台「模型管理」整页数据 */
export async function getModelAdminView(): Promise<ModelAdminView> {
  const res = await engineRequest('/api/v1/models')
  if (res.status !== 200 || !isRecord(res.payload)) {
    throw new EngineError('ENGINE_BAD_STATUS', '模型列表读取失败，请稍后再试', 502)
  }
  const rows = Array.isArray(res.payload['data']) ? (res.payload['data'] as unknown[]) : []

  const [providers, bindings] = await Promise.all([readProviders(), readUsage()])
  const providerLabels = new Map(providers.list.map((p) => [p.value, p.label]))

  const models: AdminModelItem[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = str(row['id'])
    if (!id) continue
    const type = str(row['type'])
    const group = GROUP_BY_ENGINE_TYPE[type] ?? 'other'
    const parameters = isRecord(row['parameters']) ? row['parameters'] : {}
    const embedding = isRecord(parameters['embedding_parameters'])
      ? parameters['embedding_parameters']
      : {}
    const credentials = isRecord(row['credentials']) ? row['credentials'] : {}
    const apiKey = isRecord(credentials['api_key']) ? credentials['api_key'] : {}
    const provider = str(parameters['provider'])
    const isBuiltin = row['is_builtin'] === true

    models.push({
      id,
      name: str(row['name']),
      displayName: str(row['display_name']) || str(row['name']),
      type,
      group,
      provider,
      providerLabel: providerLabels.get(provider) ?? provider,
      baseUrl: str(parameters['base_url']),
      keyConfigured: apiKey['configured'] === true,
      isBuiltin,
      status: str(row['status']),
      contextWindow: num(parameters['context_window']),
      dimension: num(embedding['dimension']),
      inUse: bindings.usage.get(id) ?? [],
      editable: !isBuiltin && EDITABLE_GROUPS.includes(group)
    })
  }

  return {
    models,
    providers: providers.list,
    providersError: providers.error,
    bindingsError: bindings.error
  }
}

/* ---------------- 写 ---------------- */

export interface CreateModelInput {
  /** chat / vision / rerank（向量模型不在这里建） */
  group: string
  name: string
  displayName: string
  provider: string
  baseUrl: string
  apiKey: string
  contextWindow: number
}

/** 新建模型；返回引擎给的新 id */
export async function createEngineModel(input: CreateModelInput): Promise<string> {
  const type = ENGINE_TYPE_BY_GROUP[input.group]
  if (!type || !EDITABLE_GROUPS.includes(input.group as ModelGroup)) {
    throw new EngineError('BAD_INPUT', '只支持新增对话 / 视觉 / 重排模型', 400)
  }
  const name = input.name.trim()
  if (!name) throw new EngineError('BAD_INPUT', '模型名不能为空', 400)
  if (name.length > 100) throw new EngineError('BAD_INPUT', '模型名最多 100 个字符', 400)
  const provider = input.provider.trim()
  if (!provider) throw new EngineError('BAD_INPUT', '请选择厂商', 400)
  const apiKey = input.apiKey.trim()
  if (!apiKey) throw new EngineError('BAD_INPUT', '请填写 API Key', 400)
  const baseUrl = assertBaseUrl(input.baseUrl)
  const contextWindow = Number.isFinite(input.contextWindow) ? Math.max(0, input.contextWindow) : 0

  const parameters: Record<string, unknown> = {
    provider,
    base_url: baseUrl,
    api_key: apiKey
  }
  if (contextWindow > 0) parameters['context_window'] = contextWindow

  const res = await engineRequest('/api/v1/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      display_name: input.displayName.trim() || name,
      type,
      source: 'remote',
      description: '',
      parameters
    })
  })
  if (res.status !== 201 && res.status !== 200) {
    throwEngine(res, '引擎拒绝了这次新建')
  }
  const data = isRecord(res.payload) && isRecord(res.payload['data']) ? res.payload['data'] : {}
  const id = str(data['id'])
  if (!id) throw new EngineError('ENGINE_BAD_PAYLOAD', '模型建好了，但引擎没回 id，请刷新列表看看', 502)
  return id
}

/**
 * 改展示名 / 地址。
 *
 * 🔴 必须先把当前模型整条读回来再原样提交：PUT 会整体替换 parameters，
 *    只发 base_url 会把 provider、context_window、supports_vision 等一起清掉。
 */
export async function updateEngineModel(
  id: string,
  patch: { displayName?: string; baseUrl?: string }
): Promise<void> {
  const current = await engineRequest(`/api/v1/models/${encodeURIComponent(id)}`)
  if (current.status !== 200 || !isRecord(current.payload)) {
    throwEngine(current, '没读到这个模型，可能已被删除')
  }
  const model = isRecord(current.payload['data']) ? current.payload['data'] : {}
  const type = str(model['type'])
  const group = GROUP_BY_ENGINE_TYPE[type] ?? 'other'
  if (!EDITABLE_GROUPS.includes(group)) {
    throw new EngineError('BAD_INPUT', '这一类的模型不在这里修改', 400)
  }
  if (model['is_builtin'] === true) {
    throw new EngineError('BAD_INPUT', '内置模型不能修改', 400)
  }

  const parameters: Record<string, unknown> = isRecord(model['parameters'])
    ? { ...model['parameters'] }
    : {}
  if (typeof patch.baseUrl === 'string') {
    parameters['base_url'] = assertBaseUrl(patch.baseUrl)
  }

  const body = {
    name: str(model['name']),
    display_name:
      typeof patch.displayName === 'string' ? patch.displayName.trim() : str(model['display_name']),
    description: str(model['description']),
    type,
    source: str(model['source']) || 'remote',
    parameters,
    is_default: model['is_default'] === true
  }
  const res = await engineRequest(`/api/v1/models/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (res.status !== 200) throwEngine(res, '引擎拒绝了这次修改')
}

/** 只换密钥（引擎的 PUT /models/{id} 会忽略 api_key，必须走 /credentials） */
export async function updateEngineModelKey(id: string, apiKey: string): Promise<void> {
  const key = apiKey.trim()
  if (!key) throw new EngineError('BAD_INPUT', '请填写新的 API Key', 400)
  const res = await engineRequest(`/api/v1/models/${encodeURIComponent(id)}/credentials`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key })
  })
  if (res.status !== 200) throwEngine(res, '引擎拒绝了这次密钥更新')
}

export interface ModelTestResult {
  ok: boolean
  elapsedMs: number
  /** 给老师看的一句话结论（聊天模型是回答开头；向量模型是维度；重排是分数） */
  summary: string
  /** 失败原因（引擎/厂商原文，管理台可见） */
  error: string
}

/** 模型测试：把一句话发给这个模型，看它回不回（会消耗一次厂商额度） */
export async function testEngineModel(id: string, input = ''): Promise<ModelTestResult> {
  const text = (input ?? '').trim() || '你好，请用一句中文回复「连接正常」。'
  // debug 是真调一次模型，15s 的默认超时不够，单独放宽到 60s
  const res = await engineRequest(
    `/api/v1/models/${encodeURIComponent(id)}/debug`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `input=${encodeURIComponent(text)}`
    },
    60_000
  )
  if (res.status !== 200 || !isRecord(res.payload) || !isRecord(res.payload['data'])) {
    throwEngine(res, '模型测试没跑起来')
  }
  const data = res.payload['data'] as Record<string, unknown>
  const ok = data['ok'] === true
  const elapsedMs = num(data['elapsed_ms'])
  const raw = isRecord(data['raw_response']) ? data['raw_response'] : {}
  const observations = isRecord(data['observations']) ? data['observations'] : {}

  let summary = ''
  if (ok) {
    const content = str(raw['content']).trim()
    if (content) {
      summary = content.slice(0, 200)
    } else if (num(observations['dimension']) > 0) {
      summary = `返回向量维度 ${num(observations['dimension'])}`
    } else {
      summary = JSON.stringify(raw).slice(0, 200)
    }
  }
  return {
    ok,
    elapsedMs,
    summary,
    error: ok ? '' : str(data['error']) || '模型没有返回内容'
  }
}

/** 删除模型（正在被使用 / 向量模型 / 内置模型 一律拒绝） */
export async function deleteEngineModel(id: string): Promise<void> {
  const view = await getModelAdminView()
  if (view.bindingsError) {
    // 读不到绑定关系就不知道删了会不会把问答弄坏 —— 宁可拒绝
    throw new EngineError(
      'MODEL_USAGE_UNKNOWN',
      '读不到当前绑定关系，为安全起见先不删；请稍后重试或去引擎后台处理',
      503
    )
  }
  const target = view.models.find((m) => m.id === id)
  if (!target) throw new EngineError('MODEL_NOT_FOUND', '这个模型已经不在引擎里了', 404)
  if (target.group === 'embedding') {
    throw new EngineError('MODEL_LOCKED', '向量模型不在这里删除（会影响已有资料的检索）', 400)
  }
  if (target.isBuiltin) throw new EngineError('MODEL_LOCKED', '内置模型不能删除', 400)
  if (target.inUse.length > 0) {
    throw new EngineError(
      'MODEL_IN_USE',
      `这个模型正在被用作「${target.inUse.join('、')}」，先在设置页换掉再删`,
      409
    )
  }

  const res = await engineRequest(`/api/v1/models/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (res.status !== 200 && res.status !== 204) throwEngine(res, '引擎拒绝了这次删除')
}
