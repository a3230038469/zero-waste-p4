<script setup lang="ts">
/**
 * 老师后台 · 资料管理 —— 2026-10-08 本地演示版新增
 *
 * 路由：/admin/knowledge
 * 数据源：GET /api/admin/knowledge（需管理员账号登录态）
 *
 * 已接：列出全部资料、上传（可一并填标签）、删除、下载、解析失败行的「重新上传」。
 *   上传后引擎在后台解析，状态先显示「处理中」。
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
 *   2. **筛选改成状态组**：全部 / 已入库 / 处理中 / **解析失败** / 无标签，
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
  UPLOAD_ACCEPT,
  deleteKnowledge,
  exportCsv,
  fetchKnowledgeList,
  reuploadKnowledge,
  uploadKnowledge,
  type AdminKnowledgeItem
} from '../api/admin'
import { LARGE_FILE_LIMIT_BYTES, LARGE_PAGE_LIMIT, countPdfPages, isPdf } from '../utils/pdf'

const items = ref<AdminKnowledgeItem[]>([])
const errorText = ref('')
const keyword = ref('')
const page = ref(1)
const pageSize = ref(20)
const exporting = ref(false)
const loading = ref(false)
/** 上次成功拉到数据的时间（引擎解析有延迟，老师需要知道看到的是几点钟的快照） */
const lastLoadedAt = ref('')

/* ---------------- 状态筛选（数字即按钮） ---------------- */

type StatusKey = 'all' | 'completed' | 'processing' | 'failed' | 'untagged'

const STATUS_TABS: { key: StatusKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'completed', label: '已入库' },
  { key: 'processing', label: '处理中' },
  { key: 'failed', label: '解析失败' },
  { key: 'untagged', label: '无标签' }
]

const statusFilter = ref<StatusKey>('all')

/**
 * 引擎「还在处理」不止一个值：实测有 pending / processing / finalizing 三种
 * （重新上传、新上传的资料都会经过它们）。别只认 `processing` ——
 * 漏一个老师就会在表格里看到一串英文（2026-10-12 实测踩中）。
 */
function isProcessing(status: string): boolean {
  return status === 'pending' || status === 'processing' || status === 'finalizing'
}

function matchStatus(row: AdminKnowledgeItem, key: StatusKey): boolean {
  if (key === 'all') return true
  if (key === 'completed') return row.parseStatus === 'completed'
  if (key === 'processing') return isProcessing(row.parseStatus)
  if (key === 'failed') return row.parseStatus === 'failed'
  return !hasMeta(row)
}

function countOf(key: StatusKey): number {
  return items.value.filter((row) => matchStatus(row, key)).length
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

/** 关键词（标题或文件夹）→ 状态 → 排序 */
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = items.value.filter((row) => {
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

/** 前端分页（600 条量级，够用） */
const pageItems = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

function setStatus(key: StatusKey): void {
  statusFilter.value = key
  page.value = 1
}

/**
 * 引擎解析状态 → 表格里显示的文字。
 */
function statusTag(status: string): { type: 'success' | 'warning' | 'danger' | 'info'; text: string } {
  if (status === 'completed') return { type: 'success', text: '已入库' }
  if (status === 'failed') return { type: 'danger', text: '解析失败' }
  if (isProcessing(status)) return { type: 'warning', text: '处理中' }
  return { type: 'info', text: status || '未知' }
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
    const data = await fetchKnowledgeList()
    items.value = data.items ?? []
    errorText.value = ''
    page.value = 1
    selected.value = []
    const now = new Date()
    lastLoadedAt.value = now.toTimeString().slice(0, 8)
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    errorText.value =
      response?.status === 403
        ? '当前账号不是管理员。'
        : (response?.data?.error?.message ?? '拉取失败，看看后端（:4000）在不在。')
    items.value = []
  } finally {
    loading.value = false
  }
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
 * 用 fetch + blob 而不是直接开链接 —— 这样接口报错时能弹提示，
 * 而不是让浏览器把错误 JSON 当文件下载下来。
 */
async function download(row: AdminKnowledgeItem): Promise<void> {
  const base = import.meta.env.VITE_API_BASE ?? 'http://localhost:4000/api'
  try {
    const res = await fetch(`${base}/docs/${encodeURIComponent(row.id)}/download`)
    if (!res.ok) {
      ElMessage.error(`下载失败（${res.status}），这份资料可能已经被删掉了`)
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  } catch {
    ElMessage.error('下载失败，看看后端（:4000）在不在')
  }
}

/* ---------------- 删除资料 ---------------- */

const deletingId = ref('')

function errorMessageOf(err: unknown, fallback: string): string {
  const response = (
    err as { response?: { status?: number; data?: { error?: { message?: string } } } }
  ).response
  return response?.data?.error?.message ?? fallback
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
    const message = errorMessageOf(err, '删除失败，看看后端（:4000）在不在')
    const status = (err as { response?: { status?: number } }).response?.status
    if (status === 404) {
      ElMessage.warning(message)
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
    const message = errorMessageOf(err, '重新上传失败，看看后端（:4000）在不在')
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

/** 拉取库里已有的主题词，作为「领域」多选下拉的选项（拉不到就留空，仍可自己输入） */
async function loadTagOptions(): Promise<void> {
  try {
    const res = await fetch('/api/docs/facets')
    const data = (await res.json()) as { tags?: { value: string }[] }
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
    if (result.metaSaved) {
      ElMessage.success(`「${name}」已上传，机构/年份/类型标签也写好了`)
    } else if (result.metaNote) {
      ElMessage.warning(`「${name}」已上传。${result.metaNote}`)
    } else {
      ElMessage.success(`「${name}」已上传，引擎正在后台解析`)
    }
    if (localEngine) {
      ElMessage.info('这次走的是本地引擎（超限文件兜底），解析会慢很多，可以先去忙别的。')
    }
    uploadDialog.value = false
    await load()
  } catch (err) {
    ElMessage.error(errorMessageOf(err, '上传失败，看看后端（:4000）在不在'))
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

    <p v-if="errorText" class="err">{{ errorText }}</p>

    <template v-if="items.length">
      <!-- 状态筛选：数字本身就是按钮，点一下即筛。「解析失败」是老师最常找的那一类 -->
      <div class="kb-tabs">
        <button
          v-for="tab in STATUS_TABS"
          :key="tab.key"
          class="kb-tab"
          :class="{ 'is-on': statusFilter === tab.key, 'is-warn': tab.key === 'failed' && countOf('failed') > 0 }"
          @click="setStatus(tab.key)"
        >
          {{ tab.label }}
          <b>{{ countOf(tab.key) }}</b>
        </button>
      </div>

      <div class="kb-tools">
        <el-input
          v-model="keyword"
          class="kb-kw"
          placeholder="搜标题或文件夹"
          clearable
          @input="page = 1"
        />
        <el-select v-model="sortBy" class="kb-sort" @change="page = 1">
          <el-option v-for="s in SORT_OPTIONS" :key="s.key" :label="s.label" :value="s.key" />
        </el-select>
        <el-select v-model="pageSize" class="kb-size" @change="page = 1">
          <el-option v-for="n in [20, 50, 100]" :key="n" :label="`每页 ${n} 条`" :value="n" />
        </el-select>
        <span class="count">筛出 {{ filtered.length }} 份</span>
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
        :data="pageItems"
        size="small"
        border
        class="kb-table"
        row-key="id"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="42" />
        <el-table-column type="index" label="#" width="52" />
        <el-table-column prop="title" label="资料标题" min-width="250" show-overflow-tooltip />
        <el-table-column label="标签（机构 · 年份 · 类型）" min-width="230">
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
        <el-table-column label="文件夹" min-width="150" show-overflow-tooltip>
          <template #default="scope">
            <span class="folder" :title="scope.row.folderPath">{{ scope.row.folderPath || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="文件" width="66" align="center">
          <template #default="scope">{{ scope.row.fileType || '—' }}</template>
        </el-table-column>
        <el-table-column label="大小" width="84" align="right">
          <template #default="scope">{{ formatSize(scope.row.size) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="92" align="center">
          <template #default="scope">
            <el-tooltip
              v-if="scope.row.parseStatus === 'failed'"
              content="解析失败：点右侧「更多 → 重新上传」，大文件请选「重新上传（本地引擎）」"
              placement="top"
            >
              <el-tag size="small" :type="statusTag(scope.row.parseStatus).type">
                {{ statusTag(scope.row.parseStatus).text }}
              </el-tag>
            </el-tooltip>
            <el-tag v-else size="small" :type="statusTag(scope.row.parseStatus).type">
              {{ statusTag(scope.row.parseStatus).text }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="入库时间" width="104" align="center">
          <template #default="scope">{{ shortDate(scope.row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="184" align="center" fixed="right">
          <template #default="scope">
            <el-button
              link
              type="primary"
              size="small"
              :loading="reuploadingId === scope.row.id"
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
                  <el-dropdown-item command="reupload" divided>重新上传</el-dropdown-item>
                  <el-dropdown-item command="reupload-local">
                    重新上传（本地引擎，超限文件用）
                  </el-dropdown-item>
                  <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="filtered.length"
        layout="prev, pager, next, total"
        class="kb-pager"
      />

      <p class="kb-foot-note">
        引擎解析有延迟：刚上传或刚重传的资料会先显示「处理中」，过一会儿点「刷新」再看。
        预览打开的是公众详情页（访客看到的那一页），用来核对最终效果。
      </p>
    </template>

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
.err {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--zw-amber);
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
</style>
