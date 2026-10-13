/**
 * 智能体配置读写层（T7：问答走智能体 + 智能体设置上网页）—— 负责人：韶茹
 *
 * 引擎侧四条接口（本文件只用前两条）：
 *   GET /api/v1/agents/{id}   读配置（config 不裁剪，是数据库的超集）
 *   PUT /api/v1/agents/{id}   改配置 —— 🔴 **整体替换，不是字段级合并**
 *   POST /api/v1/agent-chat/{sid}   智能体问答（在 index.ts 里用）
 *   POST /api/v1/knowledge-chat/{sid} 普通知识库问答（兜底，保留）
 *
 * ─────────────────────────────────────────────────────────────────
 * 🔴 为什么这个文件写得这么啰嗦：PUT 是「整体替换」
 * ─────────────────────────────────────────────────────────────────
 * 引擎源码（internal/application/service/custom_agent.go 的 UpdateAgent）：
 *
 *     existingAgent.Config = agent.Config     // 整体替换，无字段级合并
 *     existingAgent.EnsureDefaults()          // 之后只补一部分默认值
 *
 * 而 EnsureDefaults() **不补**下面这几个字段 → 漏传即归零：
 *
 *   max_completion_tokens → 0 → 回落到 config.yaml 的 1024 → 长回答被截断（以前修过的 bug）
 *   temperature           → 0（不是 0.7，源码只处理 <0）→ 输出变完全确定
 *   system_prompt         → 空 → 老师那 777 字提示词全没
 *   model_id              → 空
 *   fallback_strategy     → 空 → 被补成 "model" →「库内暂未收录」变成模型自由发挥
 *
 * 所以写入的唯一安全姿势（**本文件强制这么走，不给第二条路**）：
 *
 *   1. GET 全量 config（原始对象，一个字不改）
 *   2. 把 patch 里**非空**的字段覆盖上去（未传的字段保持原值）
 *   3. PUT 完整 config（不是「表单值 = 完整 config」）
 *   4. **回读** GET 一次，校验四项
 *   5. 四项任一不过 → 抛错并说明是哪一项
 *
 * ─────────────────────────────────────────────────────────────────
 * 🔴 硬闸：kb_selection_mode 必须是 selected，绝不能是 all
 * ─────────────────────────────────────────────────────────────────
 * all = **当前租户下全部知识库**，而引擎里现在有 7 个库（零废弃 603、
 * AI系统学习 123、零废弃-高精度测试 35、课本 2、另外三个 0）。
 * 设成 all，问「垃圾分类」会把 123 份 AI 学习资料一起拉进检索池。
 * 本文件在**写入前**与**回读后**各卡一道，任何一处不是 selected 都不放行。
 *
 * 将来的「全选」档也必须用「请求传多个库 id」实现，而不是 all：
 *   POST /api/v1/agent-chat/{sid} {query, agent_id, agent_enabled, knowledge_base_ids:[…]}
 */
import { EngineError } from './types.js'

/* ------------------------------------------------------------------ *
 * 环境与引擎调用
 * ------------------------------------------------------------------ */

/** 占位符识别：.env.example 抄来的值不算配置好（与 weknora/index.ts 同口径） */
const PLACEHOLDER = /^(your_|please_|change_?me|xxx|todo)/i

function readEnv(name: string): string {
  const value = (process.env[name] ?? '').trim()
  if (!value || PLACEHOLDER.test(value)) return ''
  return value
}

/**
 * 智能体 id：只从 `.env` 的 `WEKNORA_AGENT_ID` 读，**代码里不写死**。
 *
 * ⚠️ 没配 = **不报错**，问答链路自动走 knowledge-chat 兜底（index.ts 读这个函数）。
 *    这也是验收第 6 项「把 id 指成不存在的值 → 自动回退」的实现方式。
 */
export function getAgentId(): string {
  return readEnv('WEKNORA_AGENT_ID')
}

/** 非流式引擎调用超时（读配置很快，但引擎在 Docker 里，冷启动可能慢一点） */
const AGENT_TIMEOUT_MS = 20_000

function engineBaseUrl(): string {
  return readEnv('WEKNORA_BASE_URL') || 'http://localhost:8080'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 一次引擎调用（带 X-API-Key 与超时），只把**连不上/超时**抛成 EngineError。
 *
 * ⚠️ HTTP 状态码由调用方自己判（404 与 500 的处理完全不同），
 *    沿用 routes/admin.ts 里 engineCall 的同一套写法。
 */
async function agentFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const apiKey = readEnv('WEKNORA_API_KEY')
  if (!apiKey) {
    throw new EngineError('ENGINE_NOT_CONFIGURED', '未配置 WEKNORA_API_KEY，读不了智能体配置', 503)
  }
  const url = `${engineBaseUrl().replace(/\/+$/, '')}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
        ...(init.headers ?? {})
      }
    })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new EngineError(
      aborted ? 'ENGINE_TIMEOUT' : 'ENGINE_UNREACHABLE',
      aborted ? `引擎响应超时（${AGENT_TIMEOUT_MS / 1000}s）：${url}` : `连不上引擎 ${url}`,
      504
    )
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * 对外的字段契约（白名单 —— 其余字段一律「原样透传，绝不展示也绝不提交」）
 * ------------------------------------------------------------------ */

/** 可读可改的 6 个字段（前端控件见 docs/接口约定.md 第二节） */
export interface AgentEditableConfig {
  system_prompt: string
  model_id: string
  temperature: number
  max_completion_tokens: number
  fallback_strategy: string
  fallback_response: string
}

/** 只读展示的 4 组字段 */
export interface AgentReadonlyConfig {
  /** 关联的知识库 id 列表 */
  knowledge_bases: string[]
  /** 🔴 必须恒为 selected；展示出来是为了让老师看得见这条红线 */
  kb_selection_mode: string
  /** 意图提示词：只给「键名 + 字数」，不把三大段原文塞进页面 */
  intent_prompts: Array<{ key: string; length: number }>
  /** 智能体模式：quick-answer / smart-reasoning 等 */
  agent_mode: string
}

/** GET /api/admin/agent 的响应体（前端只认这些字段，别的都不给） */
export interface AgentConfigView {
  success: true
  agentId: string
  /** 智能体名称（只读展示用；本文件不改它） */
  name: string
  editable: AgentEditableConfig
  readonly: AgentReadonlyConfig
  /** 引擎侧最后更新时间（老师看得见「我这次改动生效了没」） */
  updatedAt: string
  /**
   * 可选模型下拉的选项（复用现有 listQaModels()，与 /qa-settings 同款）。
   * 引擎连不上时是空数组，原因放在 modelsError，接口本身仍然 200。
   */
  models: Array<{ id: string; name: string; status: string }>
  modelsError: string
}

/** PUT /api/admin/agent 的请求体：每个字段都可选，只改传了的那些 */
export interface AgentConfigPatch {
  system_prompt?: string
  model_id?: string
  temperature?: number
  max_completion_tokens?: number
  fallback_strategy?: string
  fallback_response?: string
}

/** 回读校验的一项（老师要看得见「到底哪一项没过」） */
export interface AgentCheck {
  key: string
  label: string
  /** 期望值（来自本次合并后要写下去的那份 config） */
  expected: string
  /** 回读到的实际值 */
  actual: string
  ok: boolean
}

/** PUT /api/admin/agent 的响应体 */
export interface UpdateAgentResult {
  success: true
  message: string
  /** 这次真正改动过的字段（空数组 = 原样写回，一个字没改） */
  changed: string[]
  /** 被忽略的空字段（传了空串 → 不写，保持原值，见 updateAgentConfig 的注释） */
  ignored: string[]
  before: AgentConfigView
  after: AgentConfigView
  checks: AgentCheck[]
}

/** 引擎智能体返回的原始记录 */
interface EngineAgent {
  id: string
  name: string
  description: string
  avatar: string
  updated_at: string
  config: Record<string, unknown>
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

/**
 * GET /api/v1/agents/{id} 的原始结果（**一个字都不裁剪**）。
 *
 * 🔴 updateAgentConfig 依赖这里拿到的**全量** config 做合并 —— 一旦这里做白名单过滤，
 *    PUT 就会把没在白名单里的字段全部清零（这正是要防的事故）。
 */
export async function fetchRawAgent(agentId?: string): Promise<EngineAgent> {
  const id = (agentId ?? getAgentId()).trim()
  if (!id) {
    throw new EngineError('AGENT_NOT_CONFIGURED', '未配置 WEKNORA_AGENT_ID，读不了智能体配置', 503)
  }
  const res = await agentFetch(`/api/v1/agents/${encodeURIComponent(id)}`)
  if (res.status === 404) {
    throw new EngineError('AGENT_NOT_FOUND', `引擎里没有这个智能体：${id}`, 404)
  }
  if (res.status === 401 || res.status === 403) {
    throw new EngineError('ENGINE_UNAUTHORIZED', '引擎拒绝：API Key 无效或无权限', 502)
  }
  if (!res.ok) {
    throw new EngineError('ENGINE_BAD_STATUS', `引擎返回 ${res.status}（读智能体配置）`, 502)
  }
  const payload: unknown = await res.json().catch(() => null)
  if (!isRecord(payload)) {
    throw new EngineError('ENGINE_BAD_PAYLOAD', '引擎返回的智能体格式不符合预期', 502)
  }
  // 引擎的单条接口外层包了一层 {success, data:{…}}（与 /knowledge/{id} 同一套路，2026-10-08 实测踩中）
  const data = isRecord(payload['data']) ? payload['data'] : payload
  if (!isRecord(data) || !isRecord(data['config'])) {
    throw new EngineError('ENGINE_BAD_PAYLOAD', '引擎返回的智能体里没有 config 字段', 502)
  }
  return {
    id: str(data['id']) || id,
    name: str(data['name']),
    description: str(data['description']),
    avatar: str(data['avatar']),
    updated_at: str(data['updated_at']),
    config: data['config']
  }
}

/** 把原始 config 折成前端能安全渲染的白名单视图 */
export function toAgentView(
  agent: EngineAgent,
  models: AgentConfigView['models'] = [],
  modelsError = ''
): AgentConfigView {
  const cfg = agent.config
  const intentRaw = isRecord(cfg['intent_prompts']) ? cfg['intent_prompts'] : {}
  const intentPrompts = Object.entries(intentRaw).map(([key, value]) => ({
    key,
    length: typeof value === 'string' ? value.length : 0
  }))
  const kbs = Array.isArray(cfg['knowledge_bases'])
    ? cfg['knowledge_bases'].filter((v): v is string => typeof v === 'string')
    : []
  return {
    success: true,
    agentId: agent.id,
    name: agent.name,
    editable: {
      system_prompt: str(cfg['system_prompt']),
      model_id: str(cfg['model_id']),
      temperature: num(cfg['temperature']),
      max_completion_tokens: num(cfg['max_completion_tokens']),
      fallback_strategy: str(cfg['fallback_strategy']),
      fallback_response: str(cfg['fallback_response'])
    },
    readonly: {
      knowledge_bases: kbs,
      kb_selection_mode: str(cfg['kb_selection_mode']),
      intent_prompts: intentPrompts,
      agent_mode: str(cfg['agent_mode'])
    },
    updatedAt: agent.updated_at,
    models,
    modelsError
  }
}

/**
 * GET /api/admin/agent —— 读智能体关键配置。
 *
 * ⚠️ 模型列表由**路由层**取（它本来就 import 了 weknora/index 的 listQaModels），
 *    再当参数传进来 —— 这样本文件不需要反向 import index.ts，不会和 index.ts 形成循环依赖。
 *
 * 取不到模型列表时接口**仍然 200**（models 空 + modelsError 有值），与 /qa-settings 同款口径：
 * 老师还能看到「当前生效的是什么」，而不是一个空白页。
 */
export async function getAgentConfig(
  models: AgentConfigView['models'] = [],
  modelsError = ''
): Promise<AgentConfigView> {
  const agent = await fetchRawAgent()
  return toAgentView(agent, models, modelsError)
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

/** 合法的 fallback_strategy（fixed = 用固定文案；model = 交给模型自由发挥） */
export const FALLBACK_STRATEGIES: readonly string[] = ['fixed', 'model'] as const

/** 🔴 只允许这一个值，见文件头「硬闸」 */
const REQUIRED_KB_SELECTION_MODE = 'selected'

/**
 * 写入前的硬闸：`kb_selection_mode` 绝不能是 all。
 *
 * 这条是**拒绝写入**，不是「偷偷改成 selected」—— 引擎里真被设成 all 时，
 * 那是有人（或某个脚本）在别处动过它，本文件不能自作主张替老师改口径，
 * 必须让人看见并确认。所以：all → 直接抛错；其它非 selected 值 → 拉回 selected。
 */
function assertKbSelectionMode(mode: string): void {
  if (mode === 'all') {
    throw new EngineError(
      'AGENT_KB_MODE_FORBIDDEN',
      '智能体的知识库范围现在是「全部知识库（all）」——这会把 123 份 AI 系统学习资料也拉进检索池。' +
        '请先在引擎里改回「按选择（selected）」再来保存，本接口不会替你改这个口径。',
      409
    )
  }
}

/**
 * 改智能体配置。**这是本项目唯一允许写智能体的地方。**
 *
 * 步骤（顺序不可换）：
 *   1. GET 全量 config —— 原始对象，一个字不改
 *   2. patch 里**非空**的字段覆盖上去（未传的保持原值；空串视为「不改」）
 *   3. 硬闸检查 kb_selection_mode
 *   4. PUT 完整 config（body 是 {name, description, avatar, config}，见下方实测注释）
 *   5. 回读 GET 一次，校验四项（+ 第五项 kb_selection_mode 红线）
 *   6. 任一不过 → 抛错并说明是哪一项
 *
 * ⚠️ 为什么「空串 = 不改」：整体替换下，传空串等于**主动清空**老师的 777 字提示词。
 *    宁可老师发现「我清空没生效」也不要悄悄把提示词抹掉。真想清空某项，
 *    将来另开一个显式的 clearXxx 参数，别复用空串。
 *
 * ⚠️ PUT 的 body 形状是**实测逼出来的**（任务单没给，源码也不在本机）：
 *    引擎的 Go 结构体是 `UpdateAgentRequest{name, description, avatar, config}`
 *    （用类型错误探测法确认：`{"config":456,"name":123}` 回
 *      `cannot unmarshal number into Go struct field UpdateAgentRequest.config of type types.CustomAgentConfig`；
 *      而 `is_builtin` / `enabled` / `tenant_id` 会被**静默忽略**，不要往 body 里塞）。
 */
export async function updateAgentConfig(
  patch: AgentConfigPatch,
  models: AgentConfigView['models'] = []
): Promise<UpdateAgentResult> {
  /* 步骤 1：GET 全量 ------------------------------------------------------ */
  const before = await fetchRawAgent()

  /* 步骤 2：只覆盖 patch 里非空的字段 ------------------------------------ */
  const next: Record<string, unknown> = { ...before.config }
  const changed: string[] = []
  const ignored: string[] = []

  const applyString = (key: keyof AgentEditableConfig, value: unknown): void => {
    if (value === undefined || value === null) return
    if (typeof value !== 'string') {
      throw new EngineError('INVALID_AGENT_FIELD', `${key} 得是字符串`, 400)
    }
    if (value.trim() === '') {
      ignored.push(key)
      return
    }
    if (value !== next[key]) changed.push(key)
    next[key] = value
  }
  const applyNumber = (key: keyof AgentEditableConfig, value: unknown): void => {
    if (value === undefined || value === null) return
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new EngineError('INVALID_AGENT_FIELD', `${key} 得是数字`, 400)
    }
    if (value !== next[key]) changed.push(key)
    next[key] = value
  }

  applyString('system_prompt', patch.system_prompt)
  applyString('model_id', patch.model_id)
  applyNumber('temperature', patch.temperature)
  applyNumber('max_completion_tokens', patch.max_completion_tokens)
  applyString('fallback_strategy', patch.fallback_strategy)
  applyString('fallback_response', patch.fallback_response)

  /* 步骤 3：kb_selection_mode 硬闸 ---------------------------------------- */
  assertKbSelectionMode(str(before.config['kb_selection_mode']))
  // 非 all 的异常值（空串等）一律拉回 selected —— 这条红线没有第二种口径
  next['kb_selection_mode'] = REQUIRED_KB_SELECTION_MODE

  /* 步骤 4：PUT 完整 config ---------------------------------------------- */
  const res = await agentFetch(`/api/v1/agents/${encodeURIComponent(before.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: before.name,
      description: before.description,
      avatar: before.avatar,
      config: next
    })
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    throw new EngineError(
      'ENGINE_REJECTED_UPDATE',
      `引擎拒绝了这次保存（HTTP ${res.status}），配置**没有**改动。引擎原话：${detail || '(空)'}`,
      502
    )
  }

  /* 步骤 5：回读 + 四项校验 ----------------------------------------------- */
  const after = await fetchRawAgent()
  const checks = buildChecks(next, after.config)

  /* 步骤 6：任一不过 → 抛错并说明是哪一项 -------------------------------- */
  const failed = checks.filter((c) => !c.ok)
  if (failed.length > 0) {
    const detailText = failed.map((c) => `${c.label}：期望 ${c.expected}，实际 ${c.actual}`).join('；')
    // 把逐项结果塞进 err 的 message 里一起带走：路由层只要把 message 吐给前端即可，
    // 不用给 EngineError 加第四个参数（那是契约类型，不为本任务改动它）。
    throw new EngineError(
      'AGENT_VERIFY_FAILED',
      `已写入引擎，但**回读校验没过**（${failed.length}/${checks.length} 项）。${detailText}。` +
        `逐项结果：${checks.map((c) => `${c.key}=${c.ok ? '过' : '不过'}`).join('、')}`,
      502
    )
  }

  return {
    success: true,
    message:
      changed.length === 0
        ? '已原样写回（一个字没改），四项回读校验全过'
        : `已保存并生效（改了 ${changed.length} 项：${changed.join('、')}），四项回读校验全过`,
    changed,
    ignored,
    before: toAgentView(before, models),
    after: toAgentView(after, models),
    checks
  }
}

/**
 * 四项回读校验（+ 第五项红线），**目标字段名写死**，期望值来自本次要写的那份 config。
 *
 * 前四项就是任务单 3.3 点名的：
 *   1. max_completion_tokens = 8192（漏传会回落到 1024，长回答被截断）
 *   2. system_prompt 长度 = 777（或与改前一致）
 *   3. temperature = 0.3（漏传变 0，输出完全确定）
 *   4. fallback_strategy = "fixed"（漏传被补成 model，兜底文案失效）
 * 第五项是本文件自己的硬闸：kb_selection_mode 必须是 selected。
 */
function buildChecks(expected: Record<string, unknown>, actual: Record<string, unknown>): AgentCheck[] {
  const expectTokens = num(expected['max_completion_tokens'])
  const actualTokens = num(actual['max_completion_tokens'])
  const expectPrompt = str(expected['system_prompt'])
  const actualPrompt = str(actual['system_prompt'])
  const expectTemp = num(expected['temperature'])
  const actualTemp = num(actual['temperature'])
  const expectFallback = str(expected['fallback_strategy'])
  const actualFallback = str(actual['fallback_strategy'])
  const expectMode = REQUIRED_KB_SELECTION_MODE
  const actualMode = str(actual['kb_selection_mode'])

  return [
    {
      key: 'max_completion_tokens',
      label: '回答长度上限',
      expected: String(expectTokens),
      actual: String(actualTokens),
      ok: expectTokens === actualTokens
    },
    {
      key: 'system_prompt_len',
      label: '系统提示词长度',
      expected: String(expectPrompt.length),
      actual: String(actualPrompt.length),
      ok: expectPrompt.length === actualPrompt.length
    },
    {
      key: 'temperature',
      label: '回答随机度',
      expected: String(expectTemp),
      actual: String(actualTemp),
      ok: expectTemp === actualTemp
    },
    {
      key: 'fallback_strategy',
      label: '答不上来时',
      expected: expectFallback,
      actual: actualFallback,
      ok: expectFallback === actualFallback
    },
    {
      key: 'kb_selection_mode',
      label: '知识库范围（红线）',
      expected: expectMode,
      actual: actualMode,
      ok: actualMode === expectMode
    }
  ]
}
