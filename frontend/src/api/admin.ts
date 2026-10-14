/**
 * 管理接口客户端（老师后台用）—— 2026-10-08 本地演示版新增
 *
 * 鉴权：口令走 X-Admin-Token 请求头；口令只存在浏览器本地，不写进代码、不进 git。
 */
import http from './http'
import { describeBlobError, saveBlob } from '../utils/download'

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
 * 访客反馈（2026-10-14 新增）
 *
 * GET /api/admin/feedback → 反馈列表（需 X-Admin-Token）
 * ⚠️ 反馈里带提交者自愿填写的联系方式，属个人信息 —— 只给管理者看，
 *    不出现在任何对外页面上。
 * ------------------------------------------------------------------ */

/** 一条访客反馈（与后端 StoredFeedback 对应；kindLabel 由后端补好） */
export interface AdminFeedbackItem {
  id: string
  ts: string
  kind: string
  /** 后端补的中文类型名，前端不再维护第二张映射表 */
  kindLabel: string
  message: string
  /** 提交者自愿留的联系方式，可能为空 */
  contact: string
  docId: string
  docTitle: string
  path: string
}

export interface AdminFeedbackList {
  success: boolean
  total: number
  items: AdminFeedbackItem[]
}

/** 拉访客反馈列表（已按提交时间倒序） */
export async function fetchFeedbackList(token: string): Promise<AdminFeedbackList> {
  const res = await http.get<AdminFeedbackList>('/admin/feedback', {
    headers: { 'X-Admin-Token': token },
    silent: true
  })
  return res.data
}

/* ------------------------------------------------------------------ *
 * 数据导出（2026-10-14 新增）
 *
 * GET /api/admin/export/{knowledge|users|stats|feedback} → CSV 附件
 * 四个接口都需 X-Admin-Token，与其余管理接口同一套口令。
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

/**
 * 下载一份 CSV 报表。
 *
 * 失败时抛 `Error`，message 是可直接展示给用户的中文；
 * `silent: true` 是为了不让统一拦截器再补一条英文的 axios 原文。
 */
export async function exportCsv(token: string, kind: ExportKind): Promise<void> {
  try {
    const res = await http.get<Blob>(`/admin/export/${kind}`, {
      headers: { 'X-Admin-Token': token },
      responseType: 'blob',
      silent: true
    })
    saveBlob(res.data, exportFileName(kind))
  } catch (err) {
    throw new Error(await describeBlobError(err, '导出失败，请稍后再试'))
  }
}
