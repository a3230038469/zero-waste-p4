/**
 * 管理接口客户端（老师后台用）—— 2026-10-08 本地演示版新增
 *
 * 鉴权：口令走 X-Admin-Token 请求头；口令只存在浏览器本地，不写进代码、不进 git。
 */
import http from './http'

/** 口令在 localStorage 的键名（与统计看板共用同一个） */
export const ADMIN_TOKEN_KEY = 'zwp.adminToken'

/** 管理视角的一条资料 */
export interface AdminKnowledgeItem {
  id: string
  title: string
  fileName: string
  fileType: string
  size: number
  /** 引擎解析状态：completed / failed / processing … */
  parseStatus: string
  summaryStatus: string
  enabled: boolean
  createdAt: string
  /** 库里所在的文件夹路径（可当分类线索） */
  folderPath: string
  /** 业务元数据（机构/年份/类型/领域）。老资料可能全为空 */
  meta: { org: string; year: string; type: string; tags: string }
}

export interface AdminKnowledgeList {
  success: boolean
  total: number
  items: AdminKnowledgeItem[]
}

/** 拉知识库资料列表（管理视角） */
export async function fetchKnowledgeList(token: string): Promise<AdminKnowledgeList> {
  const res = await http.get<AdminKnowledgeList>('/admin/knowledge', {
    headers: { 'X-Admin-Token': token },
    silent: true
  })
  return res.data
}

/** 允许上传的资料类型（与引擎侧支持的一致） */
export const UPLOAD_ACCEPT = '.pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.xlsx'

/** 上传时可一并填写的业务元数据（都可以留空） */
export interface UploadMeta {
  org?: string
  year?: string
  type?: string
  tags?: string
}

/** 上传结果：metaSaved=false 时看 metaNote 知道标签为什么没写上 */
export interface UploadResult {
  success: boolean
  message: string
  metaSaved: boolean
  metaNote: string
}

/**
 * 上传一份资料到知识库，可一并带上业务元数据。
 *
 * 文件以**原始二进制**放在请求体（Content-Type: application/octet-stream），
 * 文件名走 X-File-Name 头（URL 编码，避免中文名乱码）——
 * 这样既不用在前端转 base64（体积会涨三成），后端也不用新增上传中间件。
 * 元数据走查询参数（org / year / type / tags），由后端在文件落库后补写。
 */
export async function uploadKnowledge(
  token: string,
  file: File,
  meta: UploadMeta = {}
): Promise<UploadResult> {
  const params = new URLSearchParams()
  for (const key of ['org', 'year', 'type', 'tags'] as const) {
    const value = (meta[key] ?? '').trim()
    if (value) params.set(key, value)
  }
  const query = params.toString()

  const res = await http.post<UploadResult>(
    `/admin/knowledge/upload${query ? `?${query}` : ''}`,
    file,
    {
      headers: {
        'X-Admin-Token': token,
        'X-File-Name': encodeURIComponent(file.name),
        'Content-Type': 'application/octet-stream'
      },
      silent: true,
      timeout: 300_000
    }
  )
  return res.data
}

/**
 * 删除一份资料。
 *
 * ⚠️ 引擎删除后有**几秒延迟**（列表接口会短暂仍返回它），
 * 调用方删完最好延迟约 3 秒再刷新，否则老师会以为没删掉。
 */
export async function deleteKnowledge(token: string, id: string): Promise<void> {
  await http.delete(`/admin/knowledge/${encodeURIComponent(id)}`, {
    headers: { 'X-Admin-Token': token },
    silent: true
  })
}

/** 重新上传的结果。`metaRestored=false` 时看 metaNote 知道标签为什么没带回来 */
export interface ReuploadResult {
  success: boolean
  message: string
  metaNote: string
  data: { id: string; fileName: string; metaRestored: boolean }
}

/**
 * 解析失败 → 重新上传（后端一站式完成：取回原件 → 删旧记录 → 传回去 → 补回标签）。
 *
 * 老师本地不需要留原件，所以调用方不用传文件；旧 id 传进去，新 id 从
 * `data.id` 拿（**一定换成了新 id**，别再用旧 id 去查详情）。
 *
 * ⚠️ 传的是大文件（几十兆 PDF 常见），默认 20s 超时不够，这里放到 5 分钟。
 */
export async function reuploadKnowledge(token: string, id: string): Promise<ReuploadResult> {
  const res = await http.post<ReuploadResult>(
    `/admin/knowledge/${encodeURIComponent(id)}/reupload`,
    null,
    {
      headers: { 'X-Admin-Token': token },
      silent: true,
      timeout: 300_000
    }
  )
  return res.data
}

/* ------------------------------------------------------------------ *
 * 设置页（T10：解析引擎设置 + 一键自检）
 * ------------------------------------------------------------------ */

/** 一个解析引擎的可用状态（字段名已由后端从引擎的 PascalCase 归一成小驼峰） */
export interface ParserEngineInfo {
  name: string
  description: string
  /** 这个引擎能吃哪些文件后缀 */
  fileTypes: string[]
  available: boolean
  /** 不可用时引擎给的原因（英文原文，前端翻译成人话后展示） */
  unavailableReason: string
}

/** 密钥字段的状态。🔴 **只有 configured，没有原值** —— 后端绝不回显真密钥 */
export interface ParserSecretState {
  configured: boolean
}

/** GET /api/admin/parser-config 的响应体 */
export interface ParserConfigPayload {
  success: boolean
  /** 非密钥字段的原值（引擎实测 18 个字段，除密钥外全在这儿） */
  values: Record<string, string | number | boolean>
  /** 密钥字段的「已配置 / 未配置」 */
  secrets: Record<string, ParserSecretState>
  engines: ParserEngineInfo[]
  /** 非空说明引擎列表取不到（配置本身照常返回，接口仍 200） */
  enginesError: string
}

/** 读解析引擎设置 */
export async function fetchParserConfig(token: string): Promise<ParserConfigPayload> {
  const res = await http.get<ParserConfigPayload>('/admin/parser-config', {
    headers: { 'X-Admin-Token': token },
    silent: true
  })
  return res.data
}

/** 保存请求体：只放要改的字段。🔴 密钥留空 = 不改（后端会**不提交**该字段，保留原值） */
export type ParserConfigPatch = Record<string, string | number | boolean>

/** 回读校验的一项（老师要看得见「到底哪一项没过」） */
export interface ParserFieldCheck {
  key: string
  label: string
  expected: string
  actual: string
  ok: boolean
}

export interface ParserSaveResult {
  /** 全部回读校验通过才是 true；false 时看 message 与 checks（配置已写入，只是有项没生效） */
  success: boolean
  message: string
  changed: string[]
  /** 本次**没有提交**的密钥字段（引擎保留原值） */
  keptSecrets: string[]
  /** 本次提交了几个字段 / 回读到了几个（任务单验收第 6 项要比对的就是它） */
  submittedCount: number
  readBackCount: number
  /** 提交了但回读时不见了（应为空数组；非空说明引擎把它清掉了） */
  missingFields: string[]
  checks: ParserFieldCheck[]
  /** 回读后的配置视图 */
  config: ParserConfigPayload
}

export async function saveParserConfig(
  token: string,
  patch: ParserConfigPatch
): Promise<ParserSaveResult> {
  const res = await http.put<ParserSaveResult>('/admin/parser-config', patch, {
    headers: { 'X-Admin-Token': token },
    silent: true,
    timeout: 60_000
  })
  return res.data
}

/** 测试连接（只测不存）：把待测配置丢给引擎的 parser-engines/check */
export interface ParserCheckResult {
  success: boolean
  message: string
  engines: ParserEngineInfo[]
  /** 本次是否带了新密钥去测（false = 用引擎里已保存的那把测） */
  usedPendingSecret: boolean
}

export async function checkParserConfig(
  token: string,
  patch: ParserConfigPatch
): Promise<ParserCheckResult> {
  const res = await http.post<ParserCheckResult>('/admin/parser-config/check', patch, {
    headers: { 'X-Admin-Token': token },
    silent: true,
    timeout: 60_000
  })
  return res.data
}

/** 一键自检的一项（message 是人话，不是英文报错原文） */
export interface SelfcheckItem {
  key: 'engine' | 'database' | 'vector' | 'mineru'
  label: string
  ok: boolean
  message: string
  /** 这一项花了多久（毫秒） */
  ms: number
  /** 排障用的原始原因（前端只在失败时打到控制台） */
  detail: string
}

export interface SelfcheckPayload {
  success: boolean
  /** 四项全过才是 true */
  ok: boolean
  generatedAt: string
  items: SelfcheckItem[]
}

export async function runSelfcheck(token: string): Promise<SelfcheckPayload> {
  const res = await http.post<SelfcheckPayload>('/admin/selfcheck', null, {
    headers: { 'X-Admin-Token': token },
    silent: true,
    timeout: 30_000
  })
  return res.data
}

/** 管理视角的一个注册用户（手机号已脱敏） */
export interface AdminUserItem {
  id: string
  name: string
  org: string
  occupation: string
  topics: string[]
  /** 已脱敏，形如 138****8888 */
  phone: string
  createdAt: string
}

export interface AdminUserList {
  success: boolean
  total: number
  items: AdminUserItem[]
}

/** 拉注册用户列表（管理视角；手机号由后端脱敏，前端拿到就是打码后的） */
export async function fetchUserList(token: string): Promise<AdminUserList> {
  const res = await http.get<AdminUserList>('/admin/users', {
    headers: { 'X-Admin-Token': token },
    silent: true
  })
  return res.data
}

/* ------------------------------------------------------------------ *
 * 问答设置（模型 / 回答方式 / 思考强度）
 * ------------------------------------------------------------------ */

/** 回答方式。取值与后端契约一致，**别自创别名** */
export type QaStyle = 'quick' | 'knowledge'

/** 思考强度。引擎原生参数 reasoning_effort 的 8 个合法取值；'' = 跟随引擎默认 */
export type ReasoningEffort =
  | ''
  | 'off'
  | 'auto'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/** 引擎侧的一个可选问答模型 */
export interface QaModelOption {
  id: string
  name: string
  type: string
  status: string
}

export interface QaStyleOption {
  value: QaStyle
  label: string
  hint: string
}

export interface QaEffortOption {
  value: ReasoningEffort
  label: string
}

/**
 * 问答设置的读取结果。
 *
 * ⚠️ `modelsError` 非空说明引擎没连上、`models` 是空的（接口本身仍是 200，
 * 已保存的设置照常返回）。这时要把原因显示出来，别给老师一个空白下拉框。
 */
export interface QaSettingsPayload {
  success: boolean
  currentModelId: string
  /** 在 models 里查不到时为空串 —— 此时 currentModelId 可能指向一个已被删掉的模型 */
  currentModelName: string
  models: QaModelOption[]
  style: QaStyle
  styles: QaStyleOption[]
  reasoningEffort: ReasoningEffort
  efforts: QaEffortOption[]
  modelsError: string
  updatedAt: string
}

/** 读问答设置（管理视角） */
export async function fetchQaSettings(token: string): Promise<QaSettingsPayload> {
  const res = await http.get<QaSettingsPayload>('/admin/qa-settings', {
    headers: { 'X-Admin-Token': token },
    silent: true
  })
  return res.data
}

/** 保存问答设置。三个字段都可选，只传要改的；传空串 = 清掉该项、跟随引擎默认 */
export interface QaSettingsPatch {
  modelId?: string
  style?: QaStyle
  reasoningEffort?: ReasoningEffort
}

export async function saveQaSettings(
  token: string,
  patch: QaSettingsPatch
): Promise<QaSettingsPayload> {
  const res = await http.put<QaSettingsPayload>('/admin/qa-settings', patch, {
    headers: { 'X-Admin-Token': token },
    silent: true
  })
  return res.data
}

/* ------------------------------------------------------------------ *
 * 智能体设置（T7：问答走智能体 + 智能体设置上网页）
 * ------------------------------------------------------------------ */

/** 可读可改的 6 个字段 —— 引擎智能体 config 里的同名 snake_case 字段 */
export interface AgentEditableConfig {
  /** 系统提示词（老师那 777 字严谨约束就在这里） */
  system_prompt: string
  model_id: string
  temperature: number
  max_completion_tokens: number
  /** fixed = 用固定兜底文案；model = 交给模型自由发挥 */
  fallback_strategy: string
  /** 「库内暂未收录…」那段固定文案原文 */
  fallback_response: string
}

/** 只读展示的 4 组字段 */
export interface AgentReadonlyConfig {
  /** 关联的知识库 id */
  knowledge_bases: string[]
  /** 🔴 恒为 selected；设成 all 会把 123 份「AI系统学习」资料也拉进检索池 */
  kb_selection_mode: string
  /** 意图提示词：只给键名与字数，不把三大段原文塞进页面 */
  intent_prompts: Array<{ key: string; length: number }>
  agent_mode: string
}

export interface AgentConfigPayload {
  success: boolean
  agentId: string
  name: string
  editable: AgentEditableConfig
  readonly: AgentReadonlyConfig
  /** 引擎侧最后更新时间 —— 老师看得见「我这次改动生效了没」 */
  updatedAt: string
  /** 模型下拉的选项（取自引擎 KnowledgeQA 模型列表） */
  models: Array<{ id: string; name: string; status: string }>
  /** 非空说明引擎没连上、models 是空的（接口本身仍是 200） */
  modelsError: string
}

/** 读智能体设置（管理视角） */
export async function fetchAgentConfig(token: string): Promise<AgentConfigPayload> {
  const res = await http.get<AgentConfigPayload>('/admin/agent', {
    headers: { 'X-Admin-Token': token },
    silent: true
  })
  return res.data
}

/**
 * 保存请求体：每个字段都可选，只改传了的那些。
 *
 * ⚠️ **空串 = 「不改这一项」，不是「清空」**。引擎的 PUT 是整体替换，
 *    传空串会直接抹掉老师那 777 字提示词；后端已按「空串不写」处理并在 `ignored` 里如实回报。
 * 🔴 白名单之外的字段（如 kb_selection_mode）后端一律丢弃，提交了也没用。
 */
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
  expected: string
  actual: string
  ok: boolean
}

export interface AgentSaveResult {
  success: boolean
  message: string
  /** 这次真正改动过的字段（空数组 = 原样写回，一个字没改） */
  changed: string[]
  /** 被忽略的空字段（传了空串 → 保持原值） */
  ignored: string[]
  before: AgentConfigPayload
  after: AgentConfigPayload
  /** 四项回读校验 + 第五项知识库范围红线 */
  checks: AgentCheck[]
  models: Array<{ id: string; name: string; status: string }>
  modelsError: string
}

/** 保存智能体设置。后端会走「GET 全量 → 合并 → PUT 完整 config → 回读校验」 */
export async function saveAgentConfig(
  token: string,
  patch: AgentConfigPatch
): Promise<AgentSaveResult> {
  const res = await http.put<AgentSaveResult>('/admin/agent', patch, {
    headers: { 'X-Admin-Token': token },
    silent: true,
    timeout: 60_000
  })
  return res.data
}
