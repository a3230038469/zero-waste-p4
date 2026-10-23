<script setup lang="ts">
/**
 * 老师后台 · 资料管理 —— 2026-10-08 本地演示版新增
 *
 * 路由：/admin/knowledge
 * 数据源：GET /api/admin/knowledge（需管理员账号登录态）
 *
 * 已接：列出全部资料、上传（可一并填标签）、删除、下载、解析失败行的「重新上传」。
 *   上传后引擎在后台解析，状态先显示「解析中」（2026-10-21 起，原先叫「处理中」）。
 *   删除成功后延迟 3 秒再刷新 —— 引擎删除有几秒延迟，列表会短暂仍返回它。
 *
 * 2026-10-11 合并适配（第三方）：色值统一收敛到 var(--zw-*)，视觉不变。
 * 2026-10-13（T7）：「问答设置」卡片升级为「智能体设置」。
 * 2026-10-14（T10）：「智能体设置」整体搬到设置页，本页只剩一张跳转小卡。
 * 2026-10-19：管理台鉴权从共用口令改成管理员账号，本页口令输入框与口令状态一并删除。
 *
 * 2026-10-19（第二轮，用户口述 + 互通角信-30/31）：
 *   1. **删掉「智能体设置」跳转卡** —— 这一页讲资料，智能体在设置页本来就够用，
 *      中间再摆一张「去别处」的卡只是噪音（用户原话：这个卡片不需要了）。
 *   2. **筛选改成状态组**：全部 / 已入库 / 解析中 / **解析失败** / 无标签，
 *      统计数字本身就是按钮（点一下即筛）。「解析失败」就是老师最常要找的那一类
 *      —— 以前只能自己滚着找。
 *   3. **操作重新组织**：每行 = 预览（开公众详情页，跟访客看到的一致）/ 下载 / 更多 ▾
 *      （复制详情链接、重新上传、重新上传（本地引擎）、删除）。
 *      「重新上传」不再只给失败行 —— 解析得不好想重来也能手动重传。
 *   4. **批量**：勾选后可批量重传 / 批量删除（600 份里失败十几份，点十几次太折腾）。
 *   5. **两个上传入口**（信-31 老板拍板）：普通上传（引擎按库默认规则走 MinerU 云）
 *      与「大文件上传」（本地引擎兜底）。选完文件立刻自检大小与页数，超限就提示并
 *      一键切到本地引擎那条路；本地引擎会慢（实测 230MB 约 16 分钟），界面上必须写明。
 *   6. 小工具：排序（入库时间 / 大小 / 标题）、每页条数、手动刷新 + 上次刷新时间、文件夹列。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import {
  KNOWLEDGE_STATE_LABEL,
  UPLOAD_ACCEPT,
  deleteKnowledge,
  downloadKnowledgeFile,
  exportCsv,
  fetchDocFacets,
  fetchKnowledgeList,
  normalizeKnowledgeState,
  reuploadKnowledge,
  uploadKnowledge,
  type AdminKnowledgeFacets,
  type AdminKnowledgeItem,
  type KnowledgeState
} from '../api/admin'
import { publicErrorText, sanitizePublicMessage } from '../api/http'
import { LARGE_FILE_LIMIT_BYTES, LARGE_PAGE_LIMIT, countPdfPages, isPdf } from '../utils/pdf'

const items = ref<AdminKnowledgeItem[]>([])
const errorText = ref('')
const keyword = ref('')
const page = ref(1)
const pageSize = ref(20)
const exporting = ref(false)
const loading = ref(false)
/**
 * 全库状态分布（facets=1 时后端给）。
 * 页面顶部那排数字必须用它 —— 以前拿「当前页 20 条」去数，
 * 结果库里 603 份却显示「全部 20 / 失败 20」（2026-10-21 老师反馈）。
 * 为空 = 后端还没支持，退回本页统计（不会显示错到离谱的数字）。
 */
const facets = ref<AdminKnowledgeFacets | null>(null)
/**
 * 上一次拿到的全库分布。
 *
 * 后端只在「不带状态筛选」的查询里回 facets；点了「解析中 / 无标签」这类标签再查，
 * 响应里没有 facets —— 若直接用 facets 兜底，那排标签数字会一起变成 0，
 * 看起来像「库里一份资料都没有」。所以把最后一次已知分布记住，交给 countOf 兜底。
 */
const lastFacets = ref<AdminKnowledgeFacets | null>(null)

/** 后端返回的总条数（分页模式下用） */
const totalCount = ref(0)
/**
 * 分页口径：
 * - 'client' = 后端还没做分页（一次把全部资料吐回来），前端自己筛 + 切页；
 * - 'server' = 后端已经按 page/pageSize 分页，前端不再二次切页。
 * 两种都得能用，所以这里按返回条数与总条数自动判断。
 */
const pagingMode = ref<'client' | 'server'>('client')
/** 一旦见过 facets，就说明后端是新版（服务端分页），之后不再回退到 client */
const serverConfirmed = ref(false)
/** 上次成功拉到数据的时间（引擎解析有延迟，老师需要知道看到的是几点钟的快照） */
const lastLoadedAt = ref('')

/* ---------------- 状态筛选（数字即按钮） ---------------- */

type StatusKey = 'all' | 'completed' | 'processing' | 'nosummary' | 'failed' | 'untagged'

const STATUS_TABS: { key: StatusKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'completed', label: '已入库' },
  { key: 'processing', label: '解析中' },
  // 2026-10-22：摘要没生成单独一档。那些扫描件/纯图片 PDF 没有可读正文，
  // 引擎会主动跳过摘要 —— 不是故障，不能和「解析失败」挤在一个红标签里。
  { key: 'nosummary', label: '摘要未生成' },
  { key: 'failed', label: '解析失败' },
  { key: 'untagged', label: '无标签' }
]

const statusFilter = ref<StatusKey>('all')

/**
 * 状态一律走 api/admin.ts 里的 6 值枚举（completed / failed / processing /
 * pending / deleted / unknown），后端给的是引擎原值（success、deleting…）时
 * 由 normalizeKnowledgeState 归一 —— 页面上不该出现英文状态词。
 */
function parseStateOf(row: AdminKnowledgeItem): KnowledgeState {
  return normalizeKnowledgeState(row.parseStatus)
}

/** 摘要（AI 问答能引用到的程度）状态 */
function summaryStateOf(row: AdminKnowledgeItem): KnowledgeState {
  return normalizeKnowledgeState(row.summaryStatus)
}

/** 还在处理（含待解析） */
function isProcessing(state: KnowledgeState): boolean {
  return state === 'processing' || state === 'pending'
}

/**
 * 一行资料的「对外状态」（2026-10-21 · task-18 B-2）。
 *
 * 口径（后端 backend/src/routes/admin.ts 的 knowledgeGroupStateOf 用同一套，改一处必须改两处）：
 * - 解析失败 → failed（真要重传的那种）
 * - 解析成功但摘要没生成 → nosummary（2026-10-22 从 failed 里拆出来的）
 * - 解析或摘要还在跑 → processing
 * - 解析完成 **且** 摘要完成 → completed
 *
 * ⚠️ 摘要没生成**不影响** AI 检索与引用（2026-10-21 实测：摘要失败的文件提问仍能命中并给出引用），
 * 只影响资料卡片上的摘要文字；而其中多数是扫描件/纯图片 PDF（没有可读正文，引擎主动跳过），
 * 那种情况问答才拿不到内容。所以它单列一档，既不报成「失败」，也不说成「问答一定用不了」。
 */
function rowState(row: AdminKnowledgeItem): 'completed' | 'failed' | 'nosummary' | 'processing' | 'unknown' {
  const parse = parseStateOf(row)
  const summary = summaryStateOf(row)
  if (parse === 'failed') return 'failed'
  if (summary === 'failed') return 'nosummary'
  if (isProcessing(parse) || isProcessing(summary)) return 'processing'
  if (parse === 'completed' && summary === 'completed') return 'completed'
  return 'unknown'
}

function matchStatus(row: AdminKnowledgeItem, key: StatusKey): boolean {
  if (key === 'all') return true
  const state = rowState(row)
  if (key === 'completed') return state === 'completed'
  if (key === 'processing') return state === 'processing'
  if (key === 'nosummary') return state === 'nosummary'
  if (key === 'failed') return state === 'failed'
  return !hasMeta(row)
}

function countOf(key: StatusKey): number {
  // 后端给了全库分布就用它（当前页只有 20 条，数出来的不是全库）
  const f = facets.value ?? lastFacets.value
  if (f) {
    if (key === 'all') return f.all
    if (key === 'completed') return f.completed
    if (key === 'processing') return f.processing
    if (key === 'nosummary') return f.nosummary ?? 0
    if (key === 'failed') return f.failed
    return f.untagged
  }
  return items.value.filter((row) => matchStatus(row, key)).length
}

/**
 * 标签上显示的数字。
 *
 * 读取失败时一律显示「—」：那排数字来自**上一次成功**的分布（lastFacets），
 * 摆在失败状态下会让人以为「库里有 603 份、只是列表坏了」——
 * 与书架页「取不到份数 ≠ 0 份」同一口径（ShelfView 的 P1-11）。
 */
function countLabel(key: StatusKey): string {
  if (errorText.value) return '—'
  return String(countOf(key))
}

/* ---------------- 排序 / 关键词 / 分页 ---------------- */

type SortKey = 'created_desc' | 'size_desc' | 'title_asc'

const sortBy = ref<SortKey>('created_desc')

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'created_desc', label: '最新入库在前' },
  { key: 'size_desc', label: '文件大的在前' },
  { key: 'title_asc', label: '按标题排序' }
]

/** 一条资料有没有机构/年份/类型标签 */
function hasMeta(row: AdminKnowledgeItem): boolean {
  return Boolean(row.meta && (row.meta.org || row.meta.year || row.meta.type))
}

/**
 * 关键词（标题或文件夹）→ 状态 → 排序。
 *
 * 后端分页时**筛选已经在服务端做了**（不然「失败 155 份」这种跨页结果根本筛不出来），
 * 这里只负责排序，不再本地二次过滤。
 */
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list =
    pagingMode.value === 'server'
      ? items.value
      : items.value.filter((row) => {
          if (!matchStatus(row, statusFilter.value)) return false
          if (!kw) return true
          return row.title.toLowerCase().includes(kw) || row.folderPath.toLowerCase().includes(kw)
        })
  const sorted = [...list]
  if (sortBy.value === 'size_desc') {
    sorted.sort((a, b) => (b.size || 0) - (a.size || 0))
  } else if (sortBy.value === 'title_asc') {
    sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  } else {
    sorted.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }
  return sorted
})

/**
 * 表格要显示的那一批。
 * - 后端分页：拿到的就是当前页，直接用；
 * - 前端分页：自己切一刀。
 */
const pageItems = computed(() => {
  if (pagingMode.value === 'server') return filtered.value
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

function setStatus(key: StatusKey): void {
  statusFilter.value = key
  page.value = 1
  // 后端分页时筛选要服务端重查，否则只是把当前这 20 条筛了一遍
  if (pagingMode.value === 'server') void load()
}

/** 当前状态标签的中文名，给「这一类现在没有资料」的空状态用 */
const activeStatusLabel = computed(
  () => STATUS_TABS.find((t) => t.key === statusFilter.value)?.label ?? '全部'
)

/** 空状态里的「看全部资料」：状态和搜索词一起清掉 */
function clearFilters(): void {
  statusFilter.value = 'all'
  keyword.value = ''
  page.value = 1
  if (pagingMode.value === 'server') void load()
}

/** 关键词输入：服务端模式要重新查（带防抖，别每敲一个字就打一次接口） */
let keywordTimer: ReturnType<typeof setTimeout> | null = null
function onKeywordInput(): void {
  page.value = 1
  if (pagingMode.value !== 'server') return
  if (keywordTimer) clearTimeout(keywordTimer)
  keywordTimer = setTimeout(() => {
    keywordTimer = null
    void load()
  }, 400)
}

/**
 * 引擎解析状态 → 表格里显示的文字。
 *
 * 「解析中」是 2026-10-21 从「处理中」改过来的：老师说「处理中」看不出在干什么，
 * 而这段的本意就是「文件进来了、引擎正在解析，解析完才算已入库」。
 *
 * 2026-10-21（T4）：状态只认 6 值枚举，**不再把英文原值漏到页面上**；
 * 另外摘要状态单独出一行标签，解析成功但摘要没生成的文件不再被算成「已入库」。
 */
function statusTag(status: KnowledgeState): { type: 'success' | 'warning' | 'danger' | 'info'; text: string } {
  const label = KNOWLEDGE_STATE_LABEL[status]
  if (status === 'completed') return { type: 'success', text: label }
  if (status === 'failed') return { type: 'danger', text: label }
  if (status === 'processing' || status === 'pending') return { type: 'warning', text: label }
  return { type: 'info', text: label }
}

/**
 * 表格里这一行显示的状态（2026-10-21 · task-18 B-2）。
 *
 * 以前是「主标签（解析状态）+ 附加标签（摘要状态）」两个一起挂，摘要失败的那份
 * 会同时挂着「已入库」和「摘要失败」。现在**一行只挂一个状态**：摘要没生成就显示
 * 「未生成摘要」（灰色，不是报错），解析失败才显示红色「解析失败」。
 * 2026-10-22 老师明确：扫描件/纯图片 PDF 本来就没有文字，引擎跳过摘要，这不算故障。
 */
function statusDisplay(row: AdminKnowledgeItem): {
  type: 'success' | 'warning' | 'danger' | 'info'
  text: string
  tip: string
} {
  const parse = parseStateOf(row)
  const summary = summaryStateOf(row)
  if (parse === 'failed') {
    return {
      ...statusTag('failed'),
      tip: '解析失败：点右侧「更多 → 重新上传（默认引擎）」，超限文件请选「重新上传（本地引擎）」'
    }
  }
  if (summary === 'failed') {
    return {
      type: 'info',
      text: '未生成摘要',
      tip: '摘要没生成，不算故障：多数是扫描件/纯图片 PDF 没有可读正文，引擎主动跳过；也可能当时摘要模型不可用，引擎会自动重试（刷新看看可能就自愈了）。文件本身在库里；如果原件带文字层，可点右侧「更多 → 重新上传」重新解析。'
    }
  }
  if (isProcessing(parse)) {
    return { ...statusTag(parse), tip: '引擎正在解析，解析完才会变成「已入库」。' }
  }
  if (isProcessing(summary)) {
    return {
      type: 'warning',
      text: '摘要生成中',
      tip: '文件已入库，摘要还在生成中，稍后刷新看看。'
    }
  }
  if (parse === 'completed' && summary === 'completed') {
    return { ...statusTag('completed'), tip: '' }
  }
  if (parse === 'deleted') {
    return { ...statusTag('deleted'), tip: '' }
  }
  return { ...statusTag('unknown'), tip: '后端没给明确状态，先刷新看看。' }
}

function formatSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function shortDate(value: string): string {
  return value ? value.slice(0, 10) : '—'
}

/* ---------------- 取数 / 导出 ---------------- */

async function load(): Promise<void> {
  loading.value = true
  try {
    const data = await fetchKnowledgeList({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value.trim() || undefined,
      status: statusFilter.value === 'all' ? undefined : statusFilter.value,
      // 顶部数字要的是全库分布，不是这一页的分布
      facets: true
    })
    const list = data.items ?? []
    const total = data.total ?? list.length
    totalCount.value = total
    facets.value = data.facets ?? null
    if (data.facets) {
      lastFacets.value = data.facets
      serverConfirmed.value = true
    }
    // 回了 facets 就说明后端已经是服务端分页 + 服务端筛选的新版；
    // 否则按「返回条数是否少于总数」猜（旧后端一次给全量，前端自己切页）。
    // 注意：状态筛选的查询后端不带 facets，不能因此把 server 降级成 client，
    // 否则点回「全部」时前端会拿空列表本地筛，页面就一直空着。
    pagingMode.value = serverConfirmed.value || list.length < total ? 'server' : 'client'
    items.value = list
    errorText.value = ''
    if (pagingMode.value === 'client') page.value = 1
    // 换了筛选条件后当前页可能已经超出范围（比如从「全部」切到「解析中」只剩 0 条）
    const maxPage = Math.max(1, Math.ceil(total / pageSize.value))
    if (pagingMode.value === 'server' && list.length === 0 && total > 0 && page.value > maxPage) {
      page.value = maxPage
      loading.value = false
      void load()
      return
    }
    selected.value = []
    const now = new Date()
    lastLoadedAt.value = now.toTimeString().slice(0, 8)
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status
    // ⚠️ 不透传后端 message —— 里面可能带内部引擎地址（task-18 B-1）
    errorText.value =
      status === 403
        ? '当前账号不是管理员。'
        : publicErrorText(err, '资料列表暂时读不出来，请稍后再试。')
    items.value = []
    facets.value = null
    // 列表已经清空，旧的勾选不能留在批量条上（否则会对着看不见的行做批量删除）
    selected.value = []
  } finally {
    loading.value = false
  }
}

/** 切页：后端分页时重新拉，前端分页时由 computed 自己切 */
function onPageChange(): void {
  if (pagingMode.value === 'server') void load()
}

/** 改每页条数：后端分页时要重新拉 */
function onPageSizeChange(): void {
  page.value = 1
  if (pagingMode.value === 'server') void load()
}

/**
 * 导出资料台账（CSV）。
 *
 * ⚠️ 导的是**对外站的完整台账**（后端读 DOCS_SOURCE 那套数据），
 * 不是本页当前筛选结果 —— 所以按钮写「全量」二字。
 */
async function doExport(): Promise<void> {
  exporting.value = true
  try {
    await exportCsv('knowledge')
    ElMessage.success('台账已开始下载')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导出失败')
  } finally {
    exporting.value = false
  }
}

/* ---------------- 查看 / 复制链接 ---------------- */

/** 公众详情页地址（老师用它核对「访客看到的样子」） */
function publicDetailUrl(row: AdminKnowledgeItem): string {
  return `${window.location.origin}/doc/${encodeURIComponent(row.id)}`
}

function openPreview(row: AdminKnowledgeItem): void {
  window.open(publicDetailUrl(row), '_blank', 'noopener,noreferrer')
}

async function copyDetailLink(row: AdminKnowledgeItem): Promise<void> {
  const url = publicDetailUrl(row)
  try {
    await navigator.clipboard.writeText(url)
    ElMessage.success('详情页链接已复制')
  } catch {
    // 非 https / 无剪贴板权限时的兜底：让老师自己复制
    ElMessageBox.alert(url, '详情页链接（手动复制）', { confirmButtonText: '知道了' })
  }
}

/* ---------------- 下载原件 ---------------- */

/**
 * 下载原件：后端按「年份-机构-标题」命名并直接推文件流。
 *
 * 2026-10-21（T4）：改走 api/admin.ts（和全站一样带登录凭证），
 * 之前这里用的是裸 fetch —— 不带凭证，后端按「游客下载」处理，管理员也会被 403，
 * 页面还把 403 说成「这份资料可能已经被删掉了」（权限问题被说成了数据问题）。
 */
async function download(row: AdminKnowledgeItem): Promise<void> {
  try {
    await downloadKnowledgeFile(row.id, row.fileName || row.title)
    ElMessage.success('已开始下载')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '下载失败，请稍后再试')
  }
}

/* ---------------- 删除资料 ---------------- */

const deletingId = ref('')

/**
 * 面向用户的错误文案：一律本地固定中文，不透传后端原文（task-18 B-1）。
 *
 * 分两类处理（2026-10-21 · task-23 收尾实测发现的坑）：
 *  1. **接口错误**（axios 抛的，带 response / isAxiosError）→ 走 http.ts 的
 *     公开文案表 publicErrorText()，按状态码 / 错误码给固定说法。
 *  2. **本地抛出的 Error**（api 层已经把原因写成中文，比如接口未接通时的说明）→
 *     直接用它的 message。这类 Error 没有 response，
 *     若也丢给 publicErrorText()，会被当成「连不上服务器」——
 *     接口 404 被说成断网，运营会以为是网络问题，真原因反而看不见了。
 */
function errorMessageOf(err: unknown, fallback: string): string {
  const axiosLike = err as { isAxiosError?: boolean; response?: unknown } | null
  if (axiosLike && (axiosLike.isAxiosError === true || axiosLike.response !== undefined)) {
    return publicErrorText(err, fallback)
  }
  if (err instanceof Error && err.message) {
    // 本地文案也过一遍清洗（拒 URL / IP / 英文堆栈），不合格就用兜底说法
    return sanitizePublicMessage(err.message) ?? fallback
  }
  return publicErrorText(err, fallback)
}

async function confirmDelete(row: AdminKnowledgeItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定要删除「${row.title}」吗？删掉之后，书架和 AI 问答里都不会再有它了。`,
      '删除资料',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return // 用户点了取消
  }

  deletingId.value = row.id
  try {
    await deleteKnowledge(row.id)
    ElMessage.success(`「${row.title}」已删除`)
    // 引擎删除有短暂延迟（列表接口会先返回它一会儿），等 3 秒再刷新
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await load()
  } catch (err) {
    const message = errorMessageOf(err, '删除失败，请稍后再试')
    const status = (err as { response?: { status?: number } }).response?.status
    if (status === 404) {
      ElMessage.warning('这份资料已经不在了（可能已被删除），列表已刷新。')
      await load()
    } else {
      ElMessage.error(message)
    }
  } finally {
    deletingId.value = ''
  }
}

/* ---------------- 重新上传（解析失败 / 手动重来） ---------------- */

/** 正在重新上传的那一行 id；空串 = 没有。用它做 loading，只转这一行不转全表 */
const reuploadingId = ref('')

/**
 * 重传。`localEngine = true` 时走本地引擎 ——
 * 超限文件（>200MB / >200 页）只有这条路能过（信-31）。
 */
async function doReupload(row: AdminKnowledgeItem, localEngine: boolean): Promise<boolean> {
  reuploadingId.value = row.id
  try {
    const result = await reuploadKnowledge(row.id, { localEngine })
    ElMessage.success(
      localEngine ? '已重新上传（本地引擎解析，会慢一些）' : '已重新上传，引擎正在解析'
    )
    // 标签没带回来时**额外**说明一句，别让老师以为标签还在
    if (result.metaNote) ElMessage.warning(result.metaNote)
    // 刚删过旧记录、引擎删除有几秒延迟，等一下再刷新
    await new Promise((resolve) => setTimeout(resolve, 2000))
    await load()
    return true
  } catch (err) {
    const message = errorMessageOf(err, '重新上传失败，请稍后再试')
    const status = (err as { response?: { status?: number } }).response?.status
    if (status === 404) {
      ElMessage.warning(message)
      await load()
    } else {
      ElMessage.error(message)
    }
    return false
  } finally {
    reuploadingId.value = ''
  }
}

async function confirmReupload(row: AdminKnowledgeItem, localEngine: boolean): Promise<void> {
  const how = localEngine
    ? '改用本地引擎解析（适合超过 200MB / 200 页的文件，会慢一些）'
    : '用知识库默认引擎解析'
  try {
    await ElMessageBox.confirm(
      `「${row.title}」要重新上传吗？\n` +
        `系统会从引擎里取回原件、删掉这份、再原样传一遍，机构/年份/类型标签都会保留。\n` +
        `${how}。`,
      '重新上传',
      { type: 'warning', confirmButtonText: '重新上传', cancelButtonText: '取消' }
    )
  } catch {
    return // 用户点了取消
  }
  await doReupload(row, localEngine)
}

/* ---------------- 批量操作 ---------------- */

const selected = ref<AdminKnowledgeItem[]>([])
const batchRunning = ref('')

function onSelectionChange(rows: AdminKnowledgeItem[]): void {
  selected.value = rows
}

/**
 * 批量重传：逐份走单份逻辑（引擎那边也是一份一份来）。
 * 大小超 200MB 的自动改用本地引擎 —— 那条路才过得去。
 */
async function batchReupload(): Promise<void> {
  const rows = [...selected.value]
  if (!rows.length) return
  const largeCount = rows.filter((r) => (r.size || 0) > LARGE_FILE_LIMIT_BYTES).length
  try {
    await ElMessageBox.confirm(
      `要重新上传选中的 ${rows.length} 份资料吗？\n` +
        '系统会逐份「取回原件 → 删旧 → 重传 → 补回标签」。' +
        (largeCount
          ? `\n其中 ${largeCount} 份超过 200MB，会自动改用本地引擎（会慢一些）。`
          : ''),
      '批量重新上传',
      { type: 'warning', confirmButtonText: `全部重传（${rows.length} 份）`, cancelButtonText: '取消' }
    )
  } catch {
    return
  }

  batchRunning.value = 'reupload'
  let ok = 0
  let fail = 0
  try {
    for (const row of rows) {
      const localEngine = (row.size || 0) > LARGE_FILE_LIMIT_BYTES
      reuploadingId.value = row.id
      try {
        await reuploadKnowledge(row.id, { localEngine })
        ok += 1
      } catch {
        fail += 1
      } finally {
        reuploadingId.value = ''
      }
    }
    if (fail) ElMessage.warning(`重传完成：成功 ${ok} 份，失败 ${fail} 份（失败的可单独再试一次）`)
    else ElMessage.success(`重传完成：${ok} 份都已提交，引擎正在解析`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    await load()
  } finally {
    batchRunning.value = ''
  }
}

async function batchDelete(): Promise<void> {
  const rows = [...selected.value]
  if (!rows.length) return
  try {
    await ElMessageBox.confirm(
      `要删除选中的 ${rows.length} 份资料吗？\n` +
        '删掉之后，书架和 AI 问答里都不会再有它们了。这个操作不可撤销。\n' +
        `前几份是：${rows.slice(0, 3).map((r) => `「${r.title}」`).join('、')}` +
        (rows.length > 3 ? ` 等 ${rows.length} 份` : ''),
      '批量删除',
      { type: 'warning', confirmButtonText: `删除（${rows.length} 份）`, cancelButtonText: '取消' }
    )
  } catch {
    return
  }

  batchRunning.value = 'delete'
  let ok = 0
  let fail = 0
  try {
    for (const row of rows) {
      deletingId.value = row.id
      try {
        await deleteKnowledge(row.id)
        ok += 1
      } catch {
        fail += 1
      } finally {
        deletingId.value = ''
      }
    }
    if (fail) ElMessage.warning(`删除完成：成功 ${ok} 份，失败 ${fail} 份`)
    else ElMessage.success(`已删除 ${ok} 份`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await load()
  } finally {
    batchRunning.value = ''
  }
}

/* ---------------- 上传资料（两个入口：普通 / 大文件） ---------------- */

/** 类型下拉的预设值：直接取库里现有资料用过的分类，省得老师自己编 */
const TYPE_OPTIONS = [
  '国内政策法规',
  '研究实践报告',
  '科学认知',
  '国际公约',
  '研究报告',
  '各类标准',
  '政策法规',
  '案例工具'
]

const uploadDialog = ref(false)
/** 'normal' = 引擎按知识库默认规则（MinerU 云）；'large' = 本地引擎兜底 */
const uploadMode = ref<'normal' | 'large'>('normal')
const uploadFile = ref<File | null>(null)
const uploadForm = ref({ org: '', year: '', type: '', tags: [] as string[] })
const uploading = ref(false)
/** 「领域」多选的候选值：从库里现有主题现拉，避免手打导致主题词对不齐 */
const TAG_OPTIONS = ref<string[]>([])

/** 选完文件的自检结果（大小 / 页数 / 是否超限） */
const probe = ref<{ size: number; pages: number; overSize: boolean; overPages: boolean } | null>(null)
const probing = ref(false)

const overLimit = computed(() =>
  probe.value ? probe.value.overSize || probe.value.overPages : false
)

/** 自检那行字的正文（放在脚本里算，模板里就不用嵌套 template 标签了） */
const probeLine = computed(() => {
  if (!probe.value) return ''
  const size = formatSize(probe.value.size)
  const pages = probe.value.pages
    ? `${probe.value.pages} 页`
    : '页数读不出来（不影响上传）'
  return `这份文件 ${size} · ${pages}`
})

/**
 * 拉取库里已有的主题词，作为「领域」多选下拉的选项（拉不到就留空，仍可自己输入）。
 * 2026-10-21（T4）：改走 api/admin.ts（fetchDocFacets）——
 * 之前是硬编码的裸 fetch('/api/docs/facets')，开发模式下会打到 Vite 端口而不是后端。
 */
async function loadTagOptions(): Promise<void> {
  try {
    const data = await fetchDocFacets()
    TAG_OPTIONS.value = (data.tags ?? []).map((t) => t.value)
  } catch {
    TAG_OPTIONS.value = []
  }
}

/** 打开上传弹窗。`mode='large'` = 直接走本地引擎那条路 */
function openUpload(mode: 'normal' | 'large'): void {
  uploadMode.value = mode
  uploadFile.value = null
  probe.value = null
  uploadForm.value = { org: '', year: '', type: '', tags: [] }
  void loadTagOptions()
  uploadDialog.value = true
}

/** 选完文件立刻自检：大小必有，页数读得出来就读（PDF），读不出来不拦 */
async function onUploadFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  uploadFile.value = file
  probe.value = null
  if (!file) return

  probing.value = true
  try {
    const pages = isPdf(file) ? await countPdfPages(file) : 0
    probe.value = {
      size: file.size,
      pages,
      overSize: file.size > LARGE_FILE_LIMIT_BYTES,
      overPages: pages > LARGE_PAGE_LIMIT
    }
  } finally {
    probing.value = false
  }
}

/** 自检发现超限 → 一键切到本地引擎那条路（不偷偷切，提示写清楚） */
function switchToLocal(): void {
  uploadMode.value = 'large'
}

async function submitUpload(): Promise<void> {
  if (!uploadFile.value) {
    ElMessage.warning('先选一个文件')
    return
  }
  if (uploadMode.value === 'normal' && overLimit.value) {
    ElMessage.warning('这份超过了云解析的上限，请点「改用本地引擎」后再传')
    return
  }

  uploading.value = true
  const name = uploadFile.value.name
  const localEngine = uploadMode.value === 'large'
  try {
    // 「领域」多选在界面上是数组，提交时拼成逗号分隔字符串（后端与引擎存的就是字符串）
    const payload = { ...uploadForm.value, tags: uploadForm.value.tags.join(',') }
    const result = await uploadKnowledge(uploadFile.value, payload, { localEngine })
    // 标签没写成功时如实说，不糊弄成「已完成」
    // 「解析中」这半句不能省：上传成功 ≠ 已入库，引擎还要解析（实测 PDF 约 1 分钟）
    if (result.metaSaved) {
      ElMessage.success(`「${name}」已上传，机构/年份/类型标签也写好了；引擎正在解析，解析完才会变成「已入库」`)
    } else if (result.metaNote) {
      ElMessage.warning(`「${name}」已上传。${result.metaNote}引擎正在解析，解析完才会变成「已入库」`)
    } else {
      ElMessage.success(`「${name}」已上传，引擎正在解析；解析完才会变成「已入库」`)
    }
    // 上传即公开（2026-10-21 用户拍板）：传完解析好就能被看到，没有中间态。
    ElMessage.info('已上传并对外公开，解析完就能在书架和 AI 问答里看到。')
    if (localEngine) {
      ElMessage.info('这次走的是本地引擎（超限文件兜底），解析会慢很多，可以先去忙别的。')
    }
    uploadDialog.value = false
    await load()
  } catch (err) {
    ElMessage.error(errorMessageOf(err, '上传失败，请稍后再试'))
  } finally {
    uploading.value = false
  }
}

/* ---------------- 行内「更多 ▾」的命令分发 ---------------- */

function onRowCommand(cmd: string, row: AdminKnowledgeItem): void {
  if (cmd === 'copy') void copyDetailLink(row)
  else if (cmd === 'reupload') void confirmReupload(row, false)
  else if (cmd === 'reupload-local') void confirmReupload(row, true)
  else if (cmd === 'delete') void confirmDelete(row)
  else ElMessage.error(`不认识的命令：${cmd}`)
}

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="admin-kb">
    <header class="kb-head">
      <div>
        <h2 class="kb-title">资料管理</h2>
        <p class="kb-sub">
          这里管的是<b>知识库里的全部资料</b>——网页书架和 AI 问答用的都是它。
        </p>
      </div>
      <div class="kb-actions">
        <el-tooltip
          content="导出对外站的完整资料台账（CSV，Excel 可直接打开；不是当前筛选结果）"
          placement="bottom"
        >
          <el-button :loading="exporting" @click="doExport">导出全量台账 CSV</el-button>
        </el-tooltip>
        <el-tooltip
          content="普通资料走这个：引擎按知识库默认规则解析（当前是 MinerU 云）"
          placement="bottom"
        >
          <el-button type="primary" @click="openUpload('normal')">上传资料</el-button>
        </el-tooltip>
        <el-tooltip
          content="超过 200MB 或 200 页的资料走这个：改用本地引擎解析，慢一些但不会被打回"
          placement="bottom"
        >
          <el-button @click="openUpload('large')">大文件上传</el-button>
        </el-tooltip>
      </div>
    </header>

    <!-- 读取失败：只收起「这一页的数据」，不收起标签栏 / 工具条 / 表格。
         以前这里是一整块 v-if="!errorText"，一失败就把状态标签、筛选、表格、
         刷新按钮全藏掉，页面上只剩一行小字 + 一大片空白，连重试入口都没有。 -->
    <div v-if="errorText" class="kb-err" role="alert">
      <span class="kb-err-t">读取失败：{{ errorText }}</span>
      <el-button size="small" :loading="loading" @click="load">重新加载</el-button>
    </div>

    <!-- 状态筛选 / 工具条 / 表格：有没有数据、有没有报错都渲染。
         0 条走表格空状态，读取失败走空状态里的重试说明。 -->
    <div class="kb-body">
      <!-- 状态筛选：数字本身就是按钮，点一下即筛。「解析失败」是老师最常找的那一类 -->
      <div class="kb-tabs">
        <button
          v-for="tab in STATUS_TABS"
          :key="tab.key"
          class="kb-tab"
          :class="{ 'is-on': statusFilter === tab.key, 'is-warn': !errorText && tab.key === 'failed' && countOf('failed') > 0 }"
          @click="setStatus(tab.key)"
        >
          {{ tab.label }}
          <b>{{ countLabel(tab.key) }}</b>
        </button>
      </div>

      <div class="kb-tools">
        <el-input
          v-model="keyword"
          class="kb-kw"
          placeholder="搜标题或文件夹"
          clearable
          @input="onKeywordInput"
        />
        <el-select v-model="sortBy" class="kb-sort" @change="page = 1">
          <el-option v-for="s in SORT_OPTIONS" :key="s.key" :label="s.label" :value="s.key" />
        </el-select>
        <el-select v-model="pageSize" class="kb-size" @change="onPageSizeChange">
          <el-option v-for="n in [20, 50, 100]" :key="n" :label="`每页 ${n} 条`" :value="n" />
        </el-select>
        <span class="count">
          <!-- 读取失败时不说「0 份」：那是在说库是空的（假话），实际是没读到 -->
          <template v-if="errorText">列表读取失败</template>
          <template v-else-if="pagingMode === 'server'">
            本页 {{ filtered.length }} 份 · <template
              v-if="statusFilter !== 'all'"
            >该状态共 {{ totalCount }} 份</template><template v-else>共 {{ totalCount }} 份</template>
          </template>
          <template v-else>筛出 {{ filtered.length }} 份</template>
        </span>
        <span class="kb-refresh">
          <span v-if="lastLoadedAt" class="time">上次刷新 {{ lastLoadedAt }}</span>
          <el-button size="small" :loading="loading" @click="load">刷新</el-button>
        </span>
      </div>

      <!-- 批量条：选中才出现，避免平时占地方 -->
      <div v-if="selected.length" class="kb-batch">
        <span>已选 <b>{{ selected.length }}</b> 份</span>
        <el-button
          size="small"
          type="warning"
          plain
          :loading="batchRunning === 'reupload'"
          :disabled="Boolean(batchRunning)"
          @click="batchReupload"
        >
          批量重新上传
        </el-button>
        <el-button
          size="small"
          type="danger"
          plain
          :loading="batchRunning === 'delete'"
          :disabled="Boolean(batchRunning)"
          @click="batchDelete"
        >
          批量删除
        </el-button>
        <span class="kb-batch-note">超过 200MB 的会自动改用本地引擎重传</span>
      </div>

      <el-table
        v-loading="loading"
        :data="pageItems"
        size="small"
        border
        class="kb-table"
        row-key="id"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="40" />
        <el-table-column type="index" label="#" width="44" />
        <el-table-column prop="title" label="资料标题" min-width="180" show-overflow-tooltip />
        <el-table-column label="标签（机构 · 年份 · 类型）" min-width="170">
          <template #default="scope">
            <div v-if="hasMeta(scope.row)" class="meta-cell">
              <span class="meta-org" :title="scope.row.meta.org">
                {{ scope.row.meta.org || '机构未填' }}
              </span>
              <span class="meta-year">{{ scope.row.meta.year || '年份未填' }}</span>
              <el-tag size="small" type="info" effect="plain">
                {{ scope.row.meta.type || '未分类' }}
              </el-tag>
            </div>
            <span v-else class="no-meta">无标签</span>
          </template>
        </el-table-column>
        <el-table-column label="文件夹" min-width="110" show-overflow-tooltip>
          <template #default="scope">
            <span class="folder" :title="scope.row.folderPath">{{ scope.row.folderPath || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="文件" width="56" align="center">
          <template #default="scope">{{ scope.row.fileType || '—' }}</template>
        </el-table-column>
        <el-table-column label="大小" width="70" align="right">
          <template #default="scope">{{ formatSize(scope.row.size) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="124" align="center">
          <template #default="scope">
            <!-- 一行只挂一个状态：摘要没生成的文件不再同时挂「已入库」（2026-10-21 B-2） -->
            <el-tooltip
              v-if="statusDisplay(scope.row).tip"
              :content="statusDisplay(scope.row).tip"
              placement="top"
            >
              <el-tag size="small" :type="statusDisplay(scope.row).type">
                {{ statusDisplay(scope.row).text }}
              </el-tag>
            </el-tooltip>
            <el-tag v-else size="small" :type="statusDisplay(scope.row).type">
              {{ statusDisplay(scope.row).text }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="入库时间" width="96" align="center">
          <template #default="scope">{{ shortDate(scope.row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="168" align="center" fixed="right">
          <template #default="scope">
            <div class="row-acts">
              <el-button
                link
                type="primary"
                size="small"
                @click="openPreview(scope.row)"
              >
                预览
              </el-button>
              <el-button link type="primary" size="small" @click="download(scope.row)">下载</el-button>
              <el-dropdown trigger="click" @command="(cmd: unknown) => onRowCommand(String(cmd), scope.row)">
                <el-button link type="primary" size="small">更多 ▾</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="copy">复制详情链接</el-dropdown-item>
                    <el-dropdown-item command="reupload" divided>重新上传（默认引擎）</el-dropdown-item>
                    <el-dropdown-item command="reupload-local">
                      重新上传（本地引擎，超限文件用）
                    </el-dropdown-item>
                    <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </template>
        </el-table-column>

        <template #empty>
          <div class="kb-empty">
            <!-- 读取失败 ≠ 没有资料：这里不能说「这一类现在没有资料」 -->
            <template v-if="errorText">
              <p class="kb-empty-t">资料列表没读出来。</p>
              <p class="kb-empty-s">点上方「重新加载」再试一次；一直失败就看看「服务状态」那排灯。</p>
              <el-button size="small" type="primary" plain :loading="loading" @click="load">
                重新加载
              </el-button>
            </template>
            <template v-else>
              <p class="kb-empty-t">「{{ activeStatusLabel }}」这一类现在没有资料。</p>
              <p v-if="statusFilter !== 'all'" class="kb-empty-s">
                <template v-if="countOf('all') > 0">
                  全部资料共 {{ countOf('all') }} 份，换个状态标签就能看到。
                </template>
                <template v-else>换个状态标签就能看到其他资料。</template>
              </p>
              <p v-else-if="keyword.trim()" class="kb-empty-s">
                没有标题或文件夹含「{{ keyword.trim() }}」的资料，换个词试试。
              </p>
              <p v-else class="kb-empty-s">知识库里还没有资料，先用右上角「上传资料」加几份。</p>
              <el-button
                v-if="statusFilter !== 'all' || keyword.trim()"
                size="small"
                type="primary"
                plain
                @click="clearFilters"
              >
                看全部资料
              </el-button>
            </template>
          </div>
        </template>
      </el-table>

      <el-pagination
        v-if="!errorText && (pagingMode === 'server' ? totalCount : filtered.length) > 0"
        v-model:current-page="page"
        :page-size="pageSize"
        :total="pagingMode === 'server' ? totalCount : filtered.length"
        layout="prev, pager, next, total"
        class="kb-pager"
        @current-change="onPageChange"
      />

      <p class="kb-foot-note">
        引擎解析有延迟：刚上传或刚重传的资料会先显示「解析中」，过一会儿点「刷新」再看；
        变成「已入库」才是解析完成、摘要也生成好了。
        标着「未生成摘要」的：文件在库里，只是没有摘要文字。这类多是扫描件/纯图片 PDF
        本来就没有可读正文，引擎主动跳过，不算故障；也有一部分是当时摘要模型不可用，
        引擎会自动重试，刷新后可能就变「已入库」。
        标着「解析失败」的才需要重传。预览打开的是公众详情页（访客看到的那一页），用来核对最终效果。
      </p>
    </div>

    <el-dialog
      v-model="uploadDialog"
      :title="uploadMode === 'large' ? '上传大文件（本地引擎）' : '上传资料'"
      width="560px"
    >
      <el-form label-width="76px" label-position="left">
        <el-form-item label="文件">
          <input
            type="file"
            :accept="UPLOAD_ACCEPT"
            class="file-input"
            @change="onUploadFilePicked"
          />
          <span class="picked">{{ uploadFile ? uploadFile.name : '还没选文件' }}</span>
        </el-form-item>

        <!-- 选完文件先自检：超限就当场说清楚，+ 一键切到本地引擎 -->
        <p v-if="probing" class="probe">正在读文件信息…</p>
        <p v-else-if="probe" class="probe" :class="{ 'is-over': overLimit }">
          {{ probeLine }}
          <template v-if="overLimit">
            <br />
            超过了云解析的上限（200 MB / 200 页），<b>直接传会被打回</b>。
            请点下面的「改用本地引擎」再传。
          </template>
        </p>

        <el-form-item>
          <el-button v-if="uploadMode === 'large'" size="small" plain disabled>
            本次走本地引擎（超限兜底）
          </el-button>
          <el-button v-else size="small" plain @click="switchToLocal">改用本地引擎</el-button>
        </el-form-item>

        <el-form-item label="发布机构">
          <el-input v-model="uploadForm.org" placeholder="例如：生态环境部" clearable />
        </el-form-item>
        <el-form-item label="发布年份">
          <el-input v-model="uploadForm.year" maxlength="4" placeholder="四位数字，例如 2024" clearable />
        </el-form-item>
        <el-form-item label="类型">
          <el-select
            v-model="uploadForm.type"
            filterable
            allow-create
            default-first-option
            placeholder="选一个，或自己填"
            style="width: 100%"
          >
            <el-option v-for="t in TYPE_OPTIONS" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="领域">
          <el-select
            v-model="uploadForm.tags"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="可多选；没有想要的就直接输入新主题"
            style="width: 100%"
          >
            <el-option v-for="t in TAG_OPTIONS" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
      </el-form>

      <p class="dlg-hint">
        标签这四项不用都填。填了就会显示在资料的标签上，也会出现在书架的筛选项里。
      </p>
      <p v-if="uploadMode === 'large'" class="dlg-hint dlg-warn">
        本地引擎是兜底不是升级：复杂版式与图表的还原质量比云解析略降，而且慢
        —— 实测一份 230MB 的扫描件约 16 分钟。传完可以先关掉这个窗口，过一会儿来「刷新」看状态。
      </p>

      <template #footer>
        <el-button @click="uploadDialog = false">取消</el-button>
        <el-button
          type="primary"
          :loading="uploading"
          :disabled="uploadMode === 'normal' && overLimit"
          @click="submitUpload"
        >
          {{ uploading ? '上传中…' : uploadMode === 'large' ? '用本地引擎上传' : '开始上传' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.admin-kb {
  padding: 4px 2px 60px;
}
.kb-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.kb-title {
  margin: 0 0 6px;
  font-size: 22px;
  color: var(--zw-green-ink);
}
.kb-sub {
  margin: 0;
  font-size: 13px;
  color: var(--zw-muted);
}
.kb-actions {
  display: flex;
  gap: 8px;
  padding-top: 4px;
  flex-wrap: wrap;
}
.file-input {
  font-size: 13px;
  color: var(--zw-text);
}
.picked {
  margin-left: 10px;
  font-size: 13px;
  color: var(--zw-muted);
}
/* 读取失败条：一行说明 + 一个重试按钮，不收起下面的内容区 */
.kb-err {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 14px 0 4px;
  padding: 9px 12px;
  border: 1px solid var(--zw-amber);
  border-left-width: 3px;
  border-radius: var(--zw-radius-sm);
  background: var(--zw-amber-soft);
  font-size: 13px;
  color: var(--zw-amber-ink);
}
.kb-err-t {
  flex: 1;
  min-width: 200px;
  line-height: 1.6;
}

/* 状态筛选：一排可点的胶囊，数字跟着变 */
.kb-tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 14px 0 12px;
}
.kb-tab {
  font: inherit;
  font-size: 13px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--zw-line);
  background: var(--zw-surface);
  color: var(--zw-text);
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease;
}
.kb-tab:hover {
  border-color: var(--zw-green-soft);
  background: var(--zw-mint-2);
}
.kb-tab.is-on {
  background: var(--zw-green);
  border-color: var(--zw-green);
  color: var(--zw-surface);
}
.kb-tab.is-on b {
  color: var(--zw-surface);
}
.kb-tab b {
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
  color: var(--zw-green-deep);
}
/* 有解析失败的资料时，把它标成需要处理的样子（不是错误色，是提醒色） */
.kb-tab.is-warn {
  border-color: var(--zw-amber);
  color: var(--zw-amber-ink);
  background: var(--zw-amber-soft);
}
.kb-tab.is-warn b {
  color: var(--zw-amber-ink);
}

.kb-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.kb-kw {
  width: 240px;
}
.kb-sort {
  width: 160px;
}
.kb-size {
  width: 120px;
}
.kb-tools .count {
  font-size: 13px;
  color: var(--zw-muted);
}
.kb-refresh {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.kb-refresh .time {
  font-size: 12px;
  color: var(--zw-faint);
  font-variant-numeric: tabular-nums;
}

/* 状态列里的摘要附加标签 */
.sum-tag {
  margin-left: 4px;
}

/* 批量条 */
.kb-batch {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  padding: 8px 12px;
  border: 1px solid var(--zw-line-strong);
  border-radius: var(--zw-radius-sm);
  background: var(--zw-mint-2);
  font-size: 13px;
  color: var(--zw-text);
}
.kb-batch-note {
  font-size: 12px;
  color: var(--zw-muted);
}

.kb-table {
  background: var(--zw-surface);
}
.kb-pager {
  margin-top: 14px;
  justify-content: flex-end;
}
.kb-foot-note {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--zw-faint);
}
/* 表格空状态：0 条时给一句话 + 一个出口，别让页面只剩一块白 */
.kb-empty {
  width: 100%;
  padding: 26px 16px 22px;
  line-height: 1.7;
  text-align: center;
}
/**
 * Element Plus 会把 `#empty` 槽的内容包进 `.el-table__empty-text`，
 * 而它自带 `width: 50%; line-height: 60px`（见 element-plus/theme-chalk/el-table.css）。
 * 不收回这两个值，自定义空状态就被压成半宽、每行 60px 行高 ——
 * 看起来正是一大块"空缺"，而不是一句提示。2026-10-22 修。
 */
.kb-table :deep(.el-table__empty-text) {
  width: 100%;
  line-height: normal;
}
.kb-empty-t {
  margin: 0 0 6px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--zw-text);
}
.kb-empty-s {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--zw-muted);
}
.meta-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.meta-org {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--zw-text);
}
.meta-year {
  color: var(--zw-muted);
  font-variant-numeric: tabular-nums;
}
.no-meta {
  color: var(--zw-line-strong);
}
.folder {
  color: var(--zw-muted);
  font-size: 12px;
}

/* 上传弹窗里的自检提示 */
.probe {
  margin: 0 0 12px 76px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--zw-muted);
}
.probe.is-over {
  color: var(--zw-amber-ink);
  background: var(--zw-amber-soft);
  border-left: 3px solid var(--zw-amber);
  border-radius: 6px;
  padding: 8px 10px;
}
.dlg-hint {
  margin: 0;
  font-size: 12px;
  color: var(--zw-faint);
}
.dlg-warn {
  margin-top: 8px;
  color: var(--zw-amber-ink);
  line-height: 1.7;
}
.row-acts {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          white-space: nowrap;
        }

        .row-acts .el-button {
          margin-left: 0;
        }

        .row-acts .el-dropdown .el-button {
          margin-left: 0;
        }

        </style>
