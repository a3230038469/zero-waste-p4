/**
 * 投稿接口客户端 —— B09 公众上传（2026-10-13 新增）
 *
 * 投稿人侧（需登录态，token 由 http.ts 拦截器自动带上）：
 *   POST /api/contributions          提交投稿
 *   GET  /api/contributions/mine     我的投稿
 * 管理侧（需**管理员账号**登录态，凭证由 http.ts 拦截器自动带上）：
 *   GET  /api/admin/contributions           审核队列
 *   GET  /api/admin/contributions/:id/file  查看原件
 *   POST /api/admin/contributions/:id/approve   通过（真入库）
 *   POST /api/admin/contributions/:id/reject    退回（必填理由）
 *
 * 上传口径照抄 api/admin.ts：文件原始二进制放请求体（Content-Type: application/octet-stream），
 * 文件名走 X-File-Name 头（URL 编码，避免中文名乱码），元数据走查询参数。
 */
import http from './http'

/** 投稿状态三态（与后端 store.ts 一一对应，**不要加第四个**） */
export type ContributionStatus = 'pending' | 'approved' | 'rejected'

/**
 * 通过之后、真正可被问答引用之前的解析进度（2026-10-21 新增）
 *
 * 审核通过只是「已经送进知识库」，引擎还要解析（实测 PDF 约 1 分钟）。
 * unknown = 数据源不是引擎（本地资料包 / 演示快照），或查询失败 —— 此时不编进度。
 */
export type ContributionParseState =
  | 'pending'
  | 'processing'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'unknown'

/**
 * 审核状态的中文说法（管理台 + 公众端「我的投稿」共用一份，避免两边各写一套对不上）
 * 2026-10-21：之前管理台自己写了一套「已通过 · 已入库」之类的拼接文案，这里收成枚举。
 */
export const CONTRIBUTION_STATUS_LABEL: Record<ContributionStatus, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已退回'
}

/** 解析进度的中文说法；unknown 表示查不到进度，不编内容 */
export const CONTRIBUTION_PARSE_LABEL: Record<ContributionParseState, string> = {
  pending: '排队中',
  processing: '解析中',
  finalizing: '整理中',
  completed: '已入库',
  failed: '解析失败',
  unknown: '进度未知'
}

/** 解析进度对应的标签色（Element Plus tag type） */
export const CONTRIBUTION_PARSE_TAG: Record<
  ContributionParseState,
  'success' | 'warning' | 'danger' | 'info'
> = {
  pending: 'info',
  processing: 'warning',
  finalizing: 'warning',
  completed: 'success',
  failed: 'danger',
  unknown: 'info'
}

/** 只收 PDF（拍板结论）：引擎对 PDF 解析效果最好 */
export const CONTRIBUTION_ACCEPT = '.pdf'
/** 单份文件大小上限，与后端 MAX_FILE_BYTES 对齐 */
export const MAX_CONTRIBUTION_BYTES = 50 * 1024 * 1024

/** 待审原创的展示信息（投稿人视角，**不含投稿人电话**） */
export interface MyContribution {
  id: string
  title: string
  fileName: string
  org: string
  year: string
  type: string
  tags: string
  note: string
  status: ContributionStatus
  /** 「已通过」之后引擎的解析进度；未通过或查不到时为 unknown */
  parseState?: ContributionParseState
  /** 被退回时的理由（status='rejected' 时非空） */
  reason: string
  createdAt: string
  reviewedAt: string
}

export interface MyContributionList {
  success: boolean
  total: number
  items: MyContribution[]
}

/** 管理端视角的一条投稿（多出投稿人身份与原件信息） */
export interface AdminContribution extends MyContribution {
  size: number
  /** 通过后知识库返回的条目编号（可能为空串） */
  docId: string
  userId: string
  userName: string
  userOrg: string
  userPhone: string
}

export interface AdminContributionCounts {
  pending: number
  approved: number
  rejected: number
}

export interface AdminContributionList {
  success: boolean
  total: number
  page: number
  pageSize: number
  counts: AdminContributionCounts
  items: AdminContribution[]
}

/** 提交投稿时一并带上的元数据（四维都必填，note 选填） */
export interface ContributionMeta {
  title: string
  org: string
  year: string
  type: string
  tags: string
  note?: string
}

export interface SubmitContributionResult {
  success: boolean
  message: string
  data: MyContribution
}

/**
 * 提交一份投稿。
 *
 * 文件走原始二进制而不是 multipart：不引 multer、前端也不用 base64（体积会涨三成）。
 * 超时给到 5 分钟 —— 几十兆的 PDF 在慢网络下 20 秒真的不够（与 api/admin.ts 同口径）。
 */
export async function submitContribution(
  file: File,
  meta: ContributionMeta
): Promise<SubmitContributionResult> {
  const params = new URLSearchParams()
  for (const key of ['title', 'org', 'year', 'type', 'tags', 'note'] as const) {
    const value = (meta[key] ?? '').trim()
    if (value) params.set(key, value)
  }

  const res = await http.post<SubmitContributionResult>(`/contributions?${params.toString()}`, file, {
    headers: {
      'X-File-Name': encodeURIComponent(file.name),
      'Content-Type': 'application/octet-stream'
    },
    silent: true,
    timeout: 300_000
  })
  return res.data
}

/** 我的投稿（新→旧，含状态与退回理由） */
export async function fetchMyContributions(): Promise<MyContributionList> {
  const res = await http.get<MyContributionList>('/contributions/mine', { silent: true })
  return res.data
}

/** 拉审核队列（管理视角） */
export async function fetchAdminContributions(
  options: { status?: ContributionStatus | ''; keyword?: string; page?: number; pageSize?: number } = {}
): Promise<AdminContributionList> {
  const params = new URLSearchParams()
  if (options.status) params.set('status', options.status)
  if (options.keyword) params.set('keyword', options.keyword)
  if (options.page) params.set('page', String(options.page))
  if (options.pageSize) params.set('pageSize', String(options.pageSize))
  const query = params.toString()

  const res = await http.get<AdminContributionList>(
    `/admin/contributions${query ? `?${query}` : ''}`,
    { silent: true }
  )
  return res.data
}

/**
 * 打开待审原件（新标签页预览 PDF）。
 *
 * 不能用普通 window.open(url) —— 查看原件要带登录凭证（管理员账号才有权看审核队列），
 * 而浏览器直接导航的请求带不上自定义头。所以先 fetch 成 blob，再开本地 objectURL。
 * 一分钟后回收，避免长期占内存。
 *
 * 关键：必须先同步开一个空白窗口，再异步取 blob 并把 location 指向 objectURL。
 * 否则浏览器把异步后的 window.open 当弹窗拦截。
 */
export async function openContributionFile(id: string): Promise<void> {
  // 先同步开窗口，拿到窗口引用；异步之后再赋值 location，避免被拦截
  const w = window.open('', '_blank')
  if (!w) {
    // 被拦截：给明确中文提示，不静默失败
    const msg = '浏览器拦截了新窗口，请允许本站弹窗后重试'
    throw new Error(msg)
  }

  let objectUrl: string | null = null
  try {
    const res = await http.get(`/admin/contributions/${encodeURIComponent(id)}/file`, {
      responseType: 'blob',
      silent: true
    })
    objectUrl = URL.createObjectURL(res.data as Blob)
    w.location.href = objectUrl
  } catch (err) {
    // 取文件失败时别把空白窗口留在那里
    w.close()
    throw err
  } finally {
    // 无论成功失败，60 秒后回收 objectURL（若已创建）
    if (objectUrl) {
      window.setTimeout(() => URL.revokeObjectURL(objectUrl as string), 60_000)
    }
  }
}

export interface ReviewResult {
  success: boolean
  message: string
  data: AdminContribution | null
}

/**
 * 通过一条投稿。
 *
 * ⚠️ 后端这一步会**真的把文件送进知识库**：入库失败会返回 502 且状态保持「待审核」。
 *    所以这里**不能**catch 后静默当成功 —— 要把后端的 message 原样显示给管理员。
 *    引擎入库有几秒到几分钟延迟，成功后别立刻断言「书架一定马上有」。
 */
export async function approveContribution(id: string): Promise<ReviewResult> {
  const res = await http.post<ReviewResult>(
    `/admin/contributions/${encodeURIComponent(id)}/approve`,
    null,
    { silent: true, timeout: 300_000 }
  )
  return res.data
}

/** 退回一条投稿（理由必填，投稿人会在「我的投稿」里看到） */
export async function rejectContribution(
  id: string,
  reason: string
): Promise<ReviewResult> {
  const res = await http.post<ReviewResult>(
    `/admin/contributions/${encodeURIComponent(id)}/reject`,
    { reason },
    { silent: true }
  )
  return res.data
}
