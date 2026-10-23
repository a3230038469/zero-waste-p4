/**
 * 管理接口客户端（老师后台用）—— 2026-10-08 本地演示版新增
 *
 * 鉴权（2026-10-19 改造）：**管理员账号**。这里一个口令头都不带 ——
 * 登录凭证由 api/http.ts 的请求拦截器统一附上（`Authorization: Bearer <token>`），
 * 后端查这个账号的 `role` 是不是 admin（见 backend/src/admin/guard.ts）。
 * 原来的共用口令 `X-Admin-Token` 已从这一层彻底移除。
 *
 * 【统一文案表（操作员口径）】2026-10-21 T4：管理台各页的提示语都出自这张表，
 * 不要再写「看看后端（:4000）在不在」这种开发口吻 —— 操作员看不懂，
 * 也不知道该找谁。后端给出的 error.message 优先直接显示；后端没给时才用下面这些。
 *
 * | 场景 | 统一说法 |
 * | --- | --- |
 * | 资料列表读不出来 | 资料列表暂时读不出来，请稍后再试。 |
 * | 用户列表读不出来 | 用户名单暂时读不出来，请稍后再试。 |
 * | 反馈列表读不出来 | 反馈列表读取失败，请稍后再试。 |
 * | 机构信息读不出来 | 机构信息读取失败，请刷新页面重试。 |
 * | 不是管理员 | 当前账号不是管理员。 |
 * | 登录过期 / 没权限（403） | 没有下载权限，或登录已过期。请重新登录后再试。 |
 * | 资料确实没了（404） | 这份资料已经不在了（可能已被删除），刷新一下列表看看。 |
 * | 删除失败 | 删除失败，请稍后再试 |
 * | 重新上传失败 | 重新上传失败，请稍后再试 |
 * | 上传失败 | 上传失败，请稍后再试 |
 * | 导出失败 | 导出失败，请稍后再试 |
 * | 保存失败 | 保存失败，请稍后再试。 |
 * | 引擎 Key 没填 | 没填新的 API Key，引擎继续用现在那个（已配置，没改动）。 |
 * | 自检没跑起来 | 自检没跑起来，请稍后再试。 |
 *
 * 数字口径：状态标签一律用 KNOWLEDGE_STATE_LABEL（6 值枚举），
 * 页面上不允许出现 success / deleting / parsing 这类英文原值。
 */
import http from './http'
import { describeBlobError, saveBlob } from '../utils/download'
import type { GuestPermissionsPayload } from './guest'
import type { FacetItem } from './types'

/* ------------------------------------------------------------------ *
 * 资料处理状态：前端与后端共用同一张表（契约 C5）
 *
 * 后端会把引擎原值（success / error / parsing / deleting …）归一到这 6 个值；
 * 这里再兜一层归一，防止后端未升级时把英文原值漏到页面上（页面上出现
 * "success" / "deleting" 这种词，运营根本看不懂）。
 * ------------------------------------------------------------------ */

/** 资料的处理状态 */
export type KnowledgeState = 'completed' | 'failed' | 'processing' | 'pending' | 'deleted' | 'unknown'

/** 状态 → 页面上的说法（表格标签、统计数字都用这一份，不要各写各的） */
export const KNOWLEDGE_STATE_LABEL: Record<KnowledgeState, string> = {
  completed: '已入库',
  failed: '解析失败',
  processing: '解析中',
  pending: '待解析',
  deleted: '已删除',
  unknown: '状态未知'
}

/** 状态 → 标签颜色（Element Plus 的 type） */
export const KNOWLEDGE_STATE_TAG: Record<KnowledgeState, 'success' | 'danger' | 'warning' | 'info'> = {
  completed: 'success',
  failed: 'danger',
  processing: 'warning',
  pending: 'info',
  deleted: 'info',
  unknown: 'info'
}

/**
 * 把后端可能给出的各种值归一到 6 值枚举。
 * 兼容后端未升级时的引擎原值：success→completed、error→failed、
 * parsing→processing、deleting→deleted，其余一律 unknown。
 */
export function normalizeKnowledgeState(raw: string | null | undefined): KnowledgeState {
  const v = (raw ?? '').trim().toLowerCase()
  switch (v) {
    case 'completed':
    case 'success':
    case 'done':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'processing':
    case 'parsing':
    case 'finalizing':
      return 'processing'
    case 'pending':
      return 'pending'
    case 'deleted':
    case 'deleting':
      return 'deleted'
    default:
      return 'unknown'
  }
}

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

/** 全库状态分布（页面顶部那排数字的权威来源） */
export interface AdminKnowledgeFacets {
  all: number
  completed: number
  processing: number
  /** 解析失败（要重传的那种） */
  failed: number
  /**
   * 解析成功但摘要没生成（2026-10-22 起单独计数）。
   * 多数是扫描件/纯图片 PDF 没有可读正文，引擎主动跳过摘要，不算故障；
   * 不能算进 failed，否则后台会一直报「失败 N 份」吓人。
   */
  nosummary: number
  /** 没填机构/年份/类型标签的份数（与上面几项可重叠） */
  untagged: number
}

export interface AdminKnowledgeList {
  success: boolean
  total: number
  items: AdminKnowledgeItem[]
  /** facets=1 时后端回全库分布；没回就说明后端还不支持，前端退回本页统计 */
  facets?: AdminKnowledgeFacets
  /** 后端支持分页时会回传当前页与每页条数（未升级时这两个字段不存在） */
  page?: number
  pageSize?: number
}

/** 列表查询参数（后端支持后由后端分页；未升级时后端会忽略 page/pageSize） */
export interface KnowledgeListParams {
  page?: number
  pageSize?: number
  keyword?: string
  /** 状态筛选：按「分组状态」筛（completed / processing / failed / nosummary / untagged） */
  status?: KnowledgeState | 'nosummary' | 'untagged' | 'all'
  /** 要全库状态分布时传 true（页面顶部数字靠它，别再用当前页自己数） */
  facets?: boolean
}

/**
 * 拉知识库资料列表（管理视角）。
 *
 * 带上分页参数：后端升级后一次只回一页（列表响应从 200KB+ 降到几 KB）；
 * 后端还没升级时会忽略这些参数、照旧回全量，前端据此自动退回本地分页。
 */
export async function fetchKnowledgeList(
  params: KnowledgeListParams = {}
): Promise<AdminKnowledgeList> {
  const res = await http.get<AdminKnowledgeList>('/admin/knowledge', { params })
  return res.data
}

/** 公开检索页的筛选候选（类型 / 机构 / 年份 / 主题标签） */
export interface DocFacets {
  types: FacetItem[]
  orgs: FacetItem[]
  years: FacetItem[]
  tags: FacetItem[]
}

/**
 * 读筛选候选词。
 * ⚠️ 必须走 http（统一 baseURL + 登录凭证），不能用裸 fetch：
 *    裸 fetch 打的是前端开发服务器（5173），部署后就是打错地址。
 */
export async function fetchDocFacets(): Promise<DocFacets> {
  const res = await http.get<DocFacets>('/docs/facets')
  return res.data
}

/**
 * 下载一份资料的原件。
 *
 * 走统一 http（带登录凭证）：后台下载走的是公开下载接口 /docs/:id/download，
 * 匿名会被拒（403），带凭证才给文件。之前这里用裸 fetch 不带凭证，
 * 老师一点「下载」就弹「下载失败（403），这份资料可能已经被删掉了」——
 * 其实文件好好的，是没带凭证。
 */
export async function downloadKnowledgeFile(id: string, fileName: string): Promise<void> {
  try {
    const res = await http.get<Blob>(`/docs/${encodeURIComponent(id)}/download`, {
      responseType: 'blob',
      silent: true
    })
    saveBlob(res.data, fileName)
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status
    if (status === 403) {
      throw new Error('没有下载权限，或登录已过期。请重新登录后再试。')
    }
    if (status === 404) {
      throw new Error('这份资料已经不在了（可能已被删除），刷新一下列表看看。')
    }
    throw new Error(await describeBlobError(err, '下载失败，请稍后再试'))
  }
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
  /** 本次走的解析引擎：`default` = 引擎按知识库默认规则（MinerU 云），`builtin` = 本地引擎兜底 */
  engine?: 'default' | 'builtin'
}

/**
 * 上传一份资料到知识库，可一并带上业务元数据。
 *
 * 文件以**原始二进制**放在请求体（Content-Type: application/octet-stream），
 * 文件名走 X-File-Name 头（URL 编码，避免中文名乱码）——
 * 这样既不用在前端转 base64（体积会涨三成），后端也不用新增上传中间件。
 * 元数据走查询参数（org / year / type / tags），由后端在文件落库后补写。
 *
 * 2026-10-19（互通角信-31）：`localEngine = true` 时改打 `/admin/knowledge/upload-large`，
 * 后端对**这一份**指定本地引擎 —— MinerU 云对 >200MB / >200 页是硬拒（实测官方回显）。
 */
export async function uploadKnowledge(
  file: File,
  meta: UploadMeta = {},
  options: { localEngine?: boolean } = {}
): Promise<UploadResult> {
  const params = new URLSearchParams()
  for (const key of ['org', 'year', 'type', 'tags'] as const) {
    const value = (meta[key] ?? '').trim()
    if (value) params.set(key, value)
  }
  const query = params.toString()
  const path = options.localEngine ? '/admin/knowledge/upload-large' : '/admin/knowledge/upload'

  const res = await http.post<UploadResult>(
    `${path}${query ? `?${query}` : ''}`,
    file,
    {
      headers: {
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
export async function deleteKnowledge(id: string): Promise<void> {
  await http.delete(`/admin/knowledge/${encodeURIComponent(id)}`, {
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
 *
 * `localEngine = true` 时带 `?engine=local`：重传同样会撞 MinerU 云的 200MB / 200 页硬限，
 * 超限文件重传必须走本地引擎（信-31 第 84 行明确要求）。
 */
export async function reuploadKnowledge(
  id: string,
  options: { localEngine?: boolean } = {}
): Promise<ReuploadResult> {
  const query = options.localEngine ? '?engine=local' : ''
  const res = await http.post<ReuploadResult>(
    `/admin/knowledge/${encodeURIComponent(id)}/reupload${query}`,
    null,
    {
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
export async function fetchParserConfig(): Promise<ParserConfigPayload> {
  const res = await http.get<ParserConfigPayload>('/admin/parser-config')
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
  patch: ParserConfigPatch
): Promise<ParserSaveResult> {
  const res = await http.put<ParserSaveResult>('/admin/parser-config', patch, {
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

export async function runSelfcheck(): Promise<SelfcheckPayload> {
  const res = await http.post<SelfcheckPayload>('/admin/selfcheck', null, {
    silent: true,
    timeout: 30_000
  })
  return res.data
}

/** 管理视角的一个注册用户 */
export interface AdminUserItem {
  id: string
  name: string
  org: string
  occupation: string
  topics: string[]
  /** 手机号（后端给的是完整号码；导出 CSV 时前端会做脱敏） */
  phone: string
  createdAt: string
  /** 身份：admin = 管理员，其他为普通用户（契约 P1-9，后端未升级时这个字段没有） */
  role?: string
  /** 账号状态（如 active / disabled）。后端未升级时这个字段没有 */
  status?: string
}

export interface AdminUserList {
  success: boolean
  total: number
  items: AdminUserItem[]
}

/** 拉注册用户列表（管理视角） */
export async function fetchUserList(): Promise<AdminUserList> {
  const res = await http.get<AdminUserList>('/admin/users')
  return res.data
}

/** 管理员修改某个用户资料（契约：PATCH /admin/users/:id） */
export interface AdminUserPatch {
  name?: string
  org?: string
  occupation?: string
  topics?: string[]
  /** 角色只能从固定选项里选（user / admin），不接受自由文本 */
  role?: 'user' | 'admin'
}

export interface AdminUserUpdateResult {
  success: boolean
  message?: string
  /** 回读后的用户（后端未实现该接口时返回空） */
  user?: AdminUserItem
}

/**
 * 管理员修改某个用户的资料。
 *
 * ⚠️ 后端尚未提供 PATCH /admin/users/:id（目前只有 PATCH /auth/me 改自己）。
 *    这里先把对接写好：接口到位即可用；没到位时抛中文错，页面照常显示，不静默。
 */
export async function updateAdminUser(
  id: string,
  patch: AdminUserPatch
): Promise<AdminUserUpdateResult> {
  try {
    const res = await http.patch<AdminUserUpdateResult>(
      `/admin/users/${encodeURIComponent(id)}`,
      patch,
      { silent: true }
    )
    return res.data
  } catch (err) {
    const status = (err as { response?: { status?: number; data?: { error?: { message?: string } } } }).response?.status
    const backendMessage = (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message
    if (status === 404 || status === 405 || status === 501) {
      throw new Error('后端还没有提供「修改用户资料」接口，这次改动没有保存。')
    }
    if (status === 403) {
      throw new Error('当前账号不是管理员，改不了别人的资料。')
    }
    if (status === 400) {
      throw new Error(backendMessage ?? '保存失败，请检查填写内容')
    }
    throw err
  }
}

export interface ResetPasswordResult {
  success: boolean
  message: string
  user?: { id: string; name: string; phone: string }
}

/**
 * 管理员把用户密码重置为初始密码 123456。
 *
 * 为什么不是「查看密码」：库里只有 bcrypt 单向哈希，无法反推原文。
 * 重置后原密码立即失效，页面要提醒管理员转告用户尽快修改。
 */
export async function resetAdminUserPassword(id: string): Promise<ResetPasswordResult> {
  try {
    const res = await http.post<ResetPasswordResult>(
      `/admin/users/${encodeURIComponent(id)}/reset-password`,
      {},
      { silent: true }
    )
    return res.data
  } catch (err) {
    const status = (err as { response?: { status?: number; data?: { error?: { message?: string } } } }).response?.status
    const backendMessage = (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message
    if (status === 403) throw new Error('当前账号不是管理员，不能重置别人的密码。')
    if (status === 404) throw new Error('找不到这个用户，可能已被删除。')
    if (backendMessage) throw new Error(backendMessage)
    throw new Error('重置密码失败，请稍后重试。')
  }
}

/* ------------------------------------------------------------------ *
 * 访客反馈（2026-10-14 新增，2026-10-19 改为「收件箱」口径）
 *
 * GET /api/admin/feedback → 反馈列表（需管理员账号登录态）
 * ⚠️ 2026-10-19 起后端把**两个来源**合并返回：
 *    source='form'  = 正规落库（POST /api/feedback，现行唯一正路）
 *    source='event' = 历史上只记了埋点的旧反馈（弹窗时代），不合并就会漏掉
 * ⚠️ 反馈里带提交者自愿填写的联系方式，属个人信息 —— 只给管理者看，
 *    不出现在任何对外页面上。
 * ------------------------------------------------------------------ */

/** 一条访客反馈（与后端 feedback/inbox.ts 的 InboxItem 对应；中文名由后端补好） */
export interface AdminFeedbackItem {
  id: string
  ts: string
  /** form = 进了反馈表；event = 只有历史埋点 */
  source: 'form' | 'event'
  kind: string
  /** 后端补的中文类型名，前端不再维护第二张映射表 */
  kindLabel: string
  /** 细分原因（用户当初点的那个选项，如 broken / feature），可能为空 */
  reason: string
  /** 细分原因的中文名，可能为空 */
  reasonLabel: string
  message: string
  /** 提交者自愿留的联系方式，可能为空 */
  contact: string
  docId: string
  docTitle: string
  path: string
  /** 提交账号 id（仅埋点来源有），匿名为空串 */
  userId: string
  /** 提交账号姓名（后端查库补的），匿名为空串 */
  userName: string
}

export interface AdminFeedbackList {
  success: boolean
  total: number
  items: AdminFeedbackItem[]
}

/** 拉访客反馈列表（已按提交时间倒序） */
export async function fetchFeedbackList(): Promise<AdminFeedbackList> {
  const res = await http.get<AdminFeedbackList>('/admin/feedback')
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
  /** true = 思考模式（先想再答），false = 快速模式（直接答） */
  thinking: boolean
  /** 视觉模型（用户上传图片提问时由它看图）；空串 = 引擎没配 */
  vlm_model_id: string
  /** 检索重排模型；空串 = 引擎没配 */
  rerank_model_id: string
  /**
   * 摘要模型（**知识库级** summary_model_id，不在智能体 config 里）。
   * 保存时后端会单独写知识库配置，并回读校验「除它以外别的都没动」。
   */
  summary_model_id: string
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
  /** 非空说明知识库那边的摘要模型没读到（不影响别的字段照常显示） */
  summaryModelError?: string
}

/** 读智能体设置（管理视角） */
export async function fetchAgentConfig(): Promise<AgentConfigPayload> {
  const res = await http.get<AgentConfigPayload>('/admin/agent')
  return res.data
}

/* ------------------------------------------------------------------ *
 * 模型选择（2026-10-21 新增：系统设置页把引擎里的模型都摆出来）
 * ------------------------------------------------------------------ *
 *
 * 三类可改（回答 / 看图 / 重排）走同一份智能体配置；
 * 向量 / 摘要 / 解析引擎**只读** —— 引擎没有可安全调用的更新接口。
 */

/** 下拉里的一项 */
export interface ModelOption {
  id: string
  name: string
  /** active / downloading / download_failed */
  status: string
}

/** 按类型分好组的模型清单（类型由后端分组，前端不自己按 type 猜） */
export interface ModelGroups {
  qa: ModelOption[]
  vlm: ModelOption[]
  embedding: ModelOption[]
  rerank: ModelOption[]
}

/** 智能体上当前绑定的三项（可改） */
export interface AgentModelBindings {
  model_id: string
  vlm_model_id: string
  rerank_model_id: string
}

/** 知识库上绑定的模型（只读） */
export interface KbModelBindings {
  id: string
  name: string
  embeddingModelId: string
  summaryModelId: string
  vlmModelId: string
  vlmEnabled: boolean
  parserRules: Array<{ fileTypes: string; engine: string }>
}

export interface ModelSettingsPayload {
  success: boolean
  models: ModelGroups
  /** 非空 = 模型列表没拉到（接口本身仍是 200） */
  modelsError: string
  current: AgentModelBindings
  kb: KbModelBindings | null
  kbError: string
  /** 三行只读项为什么不能改 */
  notes: { embedding: string; summary: string; parser: string }
}

/** 读「模型选择」（模型清单 + 当前绑定） */
export async function fetchModelSettings(): Promise<ModelSettingsPayload> {
  const res = await http.get<ModelSettingsPayload>('/admin/model-settings')
  return res.data
}

/** 保存请求体：只这三项可改，空串 = 不改 */
export interface ModelSettingsPatch {
  model_id?: string
  vlm_model_id?: string
  rerank_model_id?: string
}

export interface ModelSettingsSaveResult {
  success: boolean
  message: string
  changed: string[]
  ignored: string[]
  /** 保存后重新读到的视图（页面直接用，不靠本地猜） */
  view: ModelSettingsPayload
}

/** 保存模型绑定。后端会先验「模型存在 + 类型对」，再走智能体配置的合并写入与回读校验 */
export async function saveModelSettings(patch: ModelSettingsPatch): Promise<ModelSettingsSaveResult> {
  const res = await http.put<ModelSettingsSaveResult>('/admin/model-settings', patch, {
    silent: true,
    timeout: 60_000
  })
  return res.data
}

/* ------------------------------------------------------------------ *
 * 数据导出（2026-10-14 新增）
 *
 * GET /api/admin/export/{knowledge|users|stats|feedback} → CSV 附件
 * 四个接口都需管理员账号登录态（与其余管理接口同一套身份）。
 * ------------------------------------------------------------------ */

/** 可导出的四种报表 */
export type ExportKind = 'knowledge' | 'users' | 'stats' | 'feedback'

/** 导出种类 → 中文名（进文件名） */
const EXPORT_LABELS: Record<ExportKind, string> = {
  knowledge: '资料台账',
  users: '注册用户',
  stats: '统计报表',
  feedback: '访客反馈'
}

/**
 * 导出文件名由**前端**拼。
 *
 * 不去读响应头里的 Content-Disposition —— 本地开发时前端在 5173、后端在 4000，
 * 属跨域请求；浏览器的 CORS 默认**不暴露** Content-Disposition，读了也是空。
 * 与其配后端 exposedHeaders 只为了个文件名，不如两端各拼一次（格式一致即可）。
 */
function exportFileName(kind: ExportKind): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  return `零废弃知识库-${EXPORT_LABELS[kind]}-${stamp}.csv`
}

/** 手机号脱敏：只保留后 4 位（138****8888 这种） */
export function maskPhone(phone: string): string {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length < 7) return phone ?? ''
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`
}

/**
 * 下载一份 CSV 报表。
 *
 * 失败时抛 `Error`，message 是可直接展示给用户的中文；
 * `silent: true` 是为了不让统一拦截器再补一条英文的 axios 原文。
 *
 * 注册用户名单的 CSV **手机号做脱敏**（只留后 4 位）：名单是个人信息，
 * 导出后容易外传，页面表格里看得到完整号码就够了。
 */
export async function exportCsv(kind: ExportKind): Promise<void> {
  try {
    const res = await http.get<Blob>(`/admin/export/${kind}`, {
      responseType: 'blob',
      silent: true
    })
    if (kind !== 'users') {
      saveBlob(res.data, exportFileName(kind))
      return
    }
    const text = await res.data.text()
    const masked = text.replace(/(?<!\d)1\d{10}(?!\d)/g, (m) => maskPhone(m))
    saveBlob(new Blob([masked], { type: 'text/csv;charset=utf-8' }), exportFileName(kind))
  } catch (err) {
    throw new Error(await describeBlobError(err, '导出失败，请稍后再试'))
  }
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
  /** true = 思考模式，false = 快速模式（布尔值，没有「空串 = 不改」这一说） */
  thinking?: boolean
  /** 视觉模型；空串 = 不改这一项 */
  vlm_model_id?: string
  /** 检索重排模型；空串 = 不改这一项 */
  rerank_model_id?: string
  /** 摘要模型（知识库级）；空串 = 不改这一项 */
  summary_model_id?: string
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
  /** 回读校验六项：四项值 + 回答模式 thinking + 知识库范围红线 */
  checks: AgentCheck[]
  models: Array<{ id: string; name: string; status: string }>
  modelsError: string
  /** 这次摘要模型的写入结果（没提交这一项时是 null） */
  summaryModel: {
    changed: boolean
    message: string
    before: string
    after: string
    preserved: Array<{ key: string; ok: boolean }>
  } | null
}

/** 保存智能体设置。后端会走「GET 全量 → 合并 → PUT 完整 config → 回读校验」 */
export async function saveAgentConfig(
  patch: AgentConfigPatch
): Promise<AgentSaveResult> {
  const res = await http.put<AgentSaveResult>('/admin/agent', patch, {
    silent: true,
    timeout: 60_000
  })
  return res.data
}

/* ------------------------------------------------------------------ *
 * 游客权限（T11：设置页第 4 块）
 * ------------------------------------------------------------------ *
 *
 * 响应体类型与公众端那条公开只读口径**共用同一份定义**（api/guest.ts），
 * 两边各写一份类型，早晚会漂 —— 开关清单与顺序由后端下发，前端不自己抄。
 */

/** 读游客权限（开关清单 + 当前值）。需要管理员账号登录态 */
export async function fetchGuestPermissions(): Promise<GuestPermissionsPayload> {
  const res = await http.get<GuestPermissionsPayload>('/admin/guest-permissions')
  return res.data
}

/** 保存请求体：字段全可选，只改传了的那些（`browse` 是只读项，传了也忽略） */
export type GuestPermissionPatch = Partial<{
  aiAsk: boolean
  aiAskDailyLimit: number
  preview: boolean
  share: boolean
  feedback: boolean
  download: boolean
}>

/** 回读校验的一项（与智能体 / 解析引擎设置同一套写法：哪一项没过就写哪一项） */
export interface GuestPermissionCheck {
  key: string
  label: string
  expected: string
  actual: string
  ok: boolean
}

export interface GuestPermissionSaveResult {
  /** 全部回读校验通过才是 true；false 时看 message 与 checks（已写入，只是有项没生效） */
  success: boolean
  message: string
  /** 本次真正改动过的键（空数组 = 值都一样） */
  changed: string[]
  /** 被忽略的键（如只读的 browse、拼错的键） */
  ignored: string[]
  checks: GuestPermissionCheck[]
  /** 回读后的配置视图 */
  config: GuestPermissionsPayload
}

/** 保存游客权限。后端会「写盘 → 重新读一遍 → 逐项校验」 */
export async function saveGuestPermissions(
  patch: GuestPermissionPatch
): Promise<GuestPermissionSaveResult> {
  const res = await http.put<GuestPermissionSaveResult>('/admin/guest-permissions', patch, {
    silent: true,
    timeout: 30_000
  })
  return res.data
}

/* ------------------------------------------------------------------ *
 * 使用明细（T11-C：数据面板末尾那块）
 * ------------------------------------------------------------------ */

/** 表里的一行 = 一个账号（`userId: null` 即游客，后端已把 name 填成「游客」） */
export interface UsageDetailRow {
  userId: string | null
  name: string
  org: string
  ai_ask: number
  preview: number
  download: number
  total: number
}

export interface UsageDetailPayload {
  success: boolean
  /** YYYY-MM-DD（本地时区） */
  date: string
  rows: UsageDetailRow[]
  totals: { ai_ask: number; preview: number; download: number }
}

/**
 * 读某一天的使用明细（省略 date = 今天）。
 * 🔴 与 /track/stats 一样是独立接口：本看板的既有统计口径一个字都没动。
 */
export async function fetchUsageDetail(date = ''): Promise<UsageDetailPayload> {
  const res = await http.get<UsageDetailPayload>('/admin/usage-detail', {
    params: date ? { date } : {},
    silent: true
  })
  return res.data
}
