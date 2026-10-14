<script setup lang="ts">
/**
 * 老师后台 · 资料管理 —— 2026-10-08 本地演示版新增
 *
 * 路由：/admin/knowledge
 * 数据源：GET /api/admin/knowledge（需请求头 X-Admin-Token）
 *
 * 已接：列出全部资料、上传（可一并填标签）、删除、下载、问答设置（T3，2026-10-10）、
 *   解析失败行的「重新上传」（T6，2026-10-12：后端取回原件→删旧→重传→补回标签）、
 *   智能体设置（T7，2026-10-13：网页问答的「大脑」= 引擎里那个智能体，配置在这里改）。
 *   上传后引擎在后台解析，状态先显示「处理中」。
 *   删除成功后延迟 3 秒再刷新 —— 引擎删除有几秒延迟，列表会短暂仍返回它。
 *
 * 2026-10-11 合并适配（第三方）：本站改造新增了全局设计令牌（src/styles/global.css），
 *   本页原先的硬编码色值（#1f3a24 / #6b7d6b / #8a9a8a …）与之是两套体系，
 *   会让 T3 新增的「问答设置」卡片看起来像另一个站拼进来的。
 *   已把色值统一收敛到 var(--zw-*)，视觉不变、以后调色只需改一处。
 *
 * 2026-10-13（T7）：「问答设置」卡片**升级为「智能体设置」**。
 *   原因：网站的提示词 / 模型 / 长度上限 / 兜底文案已经搬进引擎的智能体了，
 *   在这里再选「回答方式（风格）」只会和智能体的 system_prompt 打架 —— 风格项已下线。
 *   保存后把后端的「四项回读校验」逐项显示出来（哪一项没过就写哪一项）。
 *
 * 2026-10-14（T10）：「智能体设置」卡片**整体搬到「设置」页**（/admin/settings）。
 *   本页改成一个小提示卡 + 「去设置页 →」按钮，脚本区的智能体相关状态与方法已删干净
 *   （含 fetchAgentConfig / saveAgentConfig / AgentCheck / AgentConfigPayload 四个 import）。
 *   🔴 搬走时**只动了智能体这一块**：上传、上传对话框、列表、删除、重新上传、
 *      口令输入、分页、统计条全部原样保留，没改一行。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import {
  ADMIN_TOKEN_KEY,
  UPLOAD_ACCEPT,
  deleteKnowledge,
  exportCsv,
  fetchKnowledgeList,
  reuploadKnowledge,
  uploadKnowledge,
  type AdminKnowledgeItem
} from '../api/admin'

const PAGE_SIZE = 20

const token = ref('')
const items = ref<AdminKnowledgeItem[]>([])
const loading = ref(false)
const errorText = ref('')
const keyword = ref('')
const page = ref(1)
const exporting = ref(false)

/**
 * 导出资料台账（CSV）。
 *
 * ⚠️ 导的是**对外站的完整台账**（后端读 DOCS_SOURCE 那套数据，本地模式下 617 份），
 * 不是本页当前的关键词筛选结果 —— 所以按钮写「全量」二字，免得老师以为导出的是筛出来的那些。
 * 两个口径也可能不等：本页列的是引擎里的资料，台账取的是对外站的数据源。
 */
async function doExport(): Promise<void> {
  if (!token.value) {
    errorText.value = '请先输入管理口令'
    return
  }
  exporting.value = true
  try {
    await exportCsv(token.value, 'knowledge')
    ElMessage.success('台账已开始下载')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导出失败')
  } finally {
    exporting.value = false
  }
}

/** 关键词过滤（标题或所在文件夹） */
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return items.value
  return items.value.filter(
    (x) => x.title.toLowerCase().includes(kw) || x.folderPath.toLowerCase().includes(kw)
  )
})

/** 前端分页（600 条量级，够用） */
const pageItems = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return filtered.value.slice(start, start + PAGE_SIZE)
})

/** 已入库 / 解析失败 / 有标签 */
const storedCount = computed(() => items.value.filter((x) => x.parseStatus === 'completed').length)
const failedCount = computed(() => items.value.filter((x) => x.parseStatus === 'failed').length)
const taggedCount = computed(() => items.value.filter((x) => hasMeta(x)).length)

/** 一条资料有没有机构/年份/类型标签 */
function hasMeta(row: AdminKnowledgeItem): boolean {
  return Boolean(row.meta && (row.meta.org || row.meta.year || row.meta.type))
}

/**
 * 引擎解析状态 → 表格里显示的文字。
 *
 * ⚠️ 引擎「还在处理」不止一个值：实测有 pending / processing / finalizing 三种
 * （重新上传、新上传的资料都会经过它们）。别只认 `processing` —— 漏一个老师
 * 就会在表格里看到一串英文（2026-10-12 实测踩中）。
 */
function statusTag(status: string): { type: 'success' | 'warning' | 'danger' | 'info'; text: string } {
  if (status === 'completed') return { type: 'success', text: '已入库' }
  if (status === 'failed') return { type: 'danger', text: '解析失败' }
  if (status === 'pending' || status === 'processing' || status === 'finalizing') {
    return { type: 'warning', text: '处理中' }
  }
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

async function load(): Promise<void> {
  if (!token.value) {
    errorText.value = '请输入管理口令'
    return
  }
  loading.value = true
  try {
    const data = await fetchKnowledgeList(token.value)
    items.value = data.items ?? []
    errorText.value = ''
    page.value = 1
    localStorage.setItem(ADMIN_TOKEN_KEY, token.value)
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    errorText.value =
      response?.status === 403
        ? '口令不正确。'
        : (response?.data?.error?.message ?? '拉取失败，看看后端（:4000）在不在。')
    items.value = []
  } finally {
    loading.value = false
  }
}

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
    await deleteKnowledge(token.value, row.id)
    ElMessage.success(`「${row.title}」已删除`)
    // 引擎删除有短暂延迟（列表接口会先返回它一会儿），等 3 秒再刷新，免得老师以为没删掉
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await load()
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    const message = response?.data?.error?.message ?? '删除失败，看看后端（:4000）在不在'
    if (response?.status === 404) {
      ElMessage.warning(message)
      await load()
    } else {
      ElMessage.error(message)
    }
  } finally {
    deletingId.value = ''
  }
}

/* ---------------- 重新上传（T6：解析失败 → 删旧重传） ---------------- */

/** 正在重新上传的那一行 id；空串 = 没有。用它做 loading，只转这一行不转全表 */
const reuploadingId = ref('')

async function confirmReupload(row: AdminKnowledgeItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `「${row.title}」上次解析失败了。要重新上传吗？` +
        '系统会从引擎里取回原件、删掉这份失败的、再原样传一遍，机构/年份/类型标签都会保留。',
      '重新上传',
      { type: 'warning', confirmButtonText: '重新上传', cancelButtonText: '取消' }
    )
  } catch {
    return // 用户点了取消
  }

  reuploadingId.value = row.id
  try {
    const result = await reuploadKnowledge(token.value, row.id)
    ElMessage.success('已重新上传，引擎正在解析')
    // 标签没带回来时**额外**说明一句，别让老师以为标签还在
    if (result.metaNote) ElMessage.warning(result.metaNote)
    // 链路上刚删过旧记录，而引擎删除有几秒延迟（列表会短暂仍返回它），
    // 等一下再刷新，免得表格里同时出现新旧两份、以为重传了两遍
    await new Promise((resolve) => setTimeout(resolve, 2000))
    await load()
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    const message = response?.data?.error?.message ?? '重新上传失败，看看后端（:4000）在不在'
    if (response?.status === 404) {
      ElMessage.warning(message)
      await load()
    } else {
      ElMessage.error(message)
    }
  } finally {
    reuploadingId.value = ''
  }
}

/* ---------------- 上传资料（带标签） ---------------- */

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
const uploadFile = ref<File | null>(null)
const uploadForm = ref({ org: '', year: '', type: '', tags: [] as string[] })
const uploading = ref(false)
/** 「领域」多选的候选值：从库里现有主题现拉，避免手打导致主题词对不齐 */
const TAG_OPTIONS = ref<string[]>([])

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

function openUpload(): void {
  if (!token.value) {
    errorText.value = '先输入口令、点「进入」，再上传'
    return
  }
  uploadFile.value = null
  uploadForm.value = { org: '', year: '', type: '', tags: [] }
  void loadTagOptions()
  uploadDialog.value = true
}

function onUploadFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement
  uploadFile.value = input.files?.[0] ?? null
}

async function submitUpload(): Promise<void> {
  if (!uploadFile.value) {
    ElMessage.warning('先选一个文件')
    return
  }
  uploading.value = true
  const name = uploadFile.value.name
  try {
    // 「领域」多选在界面上是数组，提交时拼成逗号分隔字符串（后端与引擎存的就是字符串）
    const payload = { ...uploadForm.value, tags: uploadForm.value.tags.join(',') }
    const result = await uploadKnowledge(token.value, uploadFile.value, payload)
    // 标签没写成功时如实说，不糊弄成「已完成」
    if (result.metaSaved) {
      ElMessage.success(`「${name}」已上传，机构/年份/类型标签也写好了`)
    } else if (result.metaNote) {
      ElMessage.warning(`「${name}」已上传。${result.metaNote}`)
    } else {
      ElMessage.success(`「${name}」已上传，引擎正在后台解析`)
    }
    uploadDialog.value = false
    await load()
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    ElMessage.error(response?.data?.error?.message ?? '上传失败，看看后端（:4000）在不在')
  } finally {
    uploading.value = false
  }
}

onMounted(() => {
  const saved = localStorage.getItem(ADMIN_TOKEN_KEY)
  if (saved) {
    token.value = saved
    void load()
  }
})

/* ------------------------------------------------------------------ *
 * T10（2026-10-14）：「智能体设置」卡片**已整体搬到「设置」页**
 * ------------------------------------------------------------------ *
 * 原来的 `agentLoading/agentSaving/agentForm/agentSaved/agentChecks/loadAgent/
 * submitAgent/applyAgentView/…` 连同模板与样式整块移到
 * `frontend/src/views/AdminSettingsView.vue`（**逻辑一个字没改**）。
 * 原因：这一页讲的是「资料」，把「问答的大脑」塞在这儿本来就别扭；
 * 现在「设置」页专门放系统设置，导航也多了一项。
 * 本页现在只留一个小卡片提示 + 一个跳转按钮，上传/列表/删除/重新上传等
 * 功能全部原样保留、没动过。
 */

/** 「进入」按钮：拉资料列表 */
async function enterAdmin(): Promise<void> {
  await load()
}
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
        <el-button type="primary" @click="openUpload">上传资料</el-button>
      </div>
    </header>

    <nav class="admin-nav">
      <router-link to="/admin/knowledge">资料管理</router-link>
      <router-link to="/admin/contributions">投稿审核</router-link>
      <router-link to="/admin/users">注册用户</router-link>
      <router-link to="/admin/feedback">访客反馈</router-link>
      <router-link to="/admin/stats">数据看板</router-link>
      <router-link to="/admin/settings">设置</router-link>
    </nav>

    <el-card shadow="never" class="token-card">
      <div class="token-row">
        <el-input
          v-model="token"
          type="password"
          show-password
          placeholder="管理口令（backend/.env 里的 ADMIN_STATS_TOKEN）"
          @keyup.enter="enterAdmin"
        />
        <el-button type="primary" :loading="loading" @click="enterAdmin">进入</el-button>
      </div>
      <p v-if="errorText" class="err">{{ errorText }}</p>
    </el-card>

    <template v-if="items.length">
      <div class="kb-stat">
        <span>共 <b>{{ items.length }}</b> 份</span>
        <span class="dot">·</span>
        <span>已入库 <b class="ok">{{ storedCount }}</b></span>
        <span v-if="failedCount" class="dot">·</span>
        <span v-if="failedCount">解析失败 <b class="bad">{{ failedCount }}</b></span>
        <span class="dot">·</span>
        <span>已带标签 <b class="ok">{{ taggedCount }}</b></span>
      </div>

      <!-- T10：「智能体设置」已搬到「设置」页（见上面脚本区的说明）。
           这里只留一个小提示卡 + 跳转按钮；资料的上传/列表/删除/重新上传都在下面，一处没动。 -->
      <el-card shadow="never" class="qa-card">
        <div class="qa-head">
          <h3 class="qa-title">智能体设置</h3>
        </div>
        <p class="qa-lead">
          网站问答的「大脑」（提示词、回答模型、长度上限、答不上来时说什么）已经搬到
          <b>设置页</b>，和解析引擎设置、一键自检放在一起。到那边改完，下次提问立刻生效。
        </p>
        <div class="qa-foot">
          <router-link to="/admin/settings">
            <el-button type="primary">去设置页 →</el-button>
          </router-link>
        </div>
      </el-card>

      <div class="kb-bar">
        <el-input v-model="keyword" placeholder="按标题或文件夹筛选" clearable />
        <span class="count">筛出 {{ filtered.length }} 份</span>
      </div>

      <el-table :data="pageItems" size="small" border class="kb-table">
        <el-table-column type="index" label="#" width="52" />
        <el-table-column prop="title" label="资料标题" min-width="250" show-overflow-tooltip />
        <el-table-column label="标签（机构 · 年份 · 类型）" min-width="250">
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
        <el-table-column label="文件" width="70" align="center">
          <template #default="scope">{{ scope.row.fileType || '—' }}</template>
        </el-table-column>
        <el-table-column label="大小" width="86" align="right">
          <template #default="scope">{{ formatSize(scope.row.size) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="92" align="center">
          <template #default="scope">
            <el-tag size="small" :type="statusTag(scope.row.parseStatus).type">
              {{ statusTag(scope.row.parseStatus).text }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="入库时间" width="108" align="center">
          <template #default="scope">{{ shortDate(scope.row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="196" align="center" fixed="right">
          <template #default="scope">
            <el-button link type="primary" size="small" @click="download(scope.row)">下载</el-button>
            <el-button
              v-if="scope.row.parseStatus === 'failed'"
              link
              type="warning"
              size="small"
              :loading="reuploadingId === scope.row.id"
              @click="confirmReupload(scope.row)"
            >
              重新上传
            </el-button>
            <el-button
              link
              type="danger"
              size="small"
              :loading="deletingId === scope.row.id"
              @click="confirmDelete(scope.row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        :page-size="PAGE_SIZE"
        :total="filtered.length"
        layout="prev, pager, next, total"
        class="kb-pager"
      />
    </template>

    <el-dialog v-model="uploadDialog" title="上传资料" width="540px">
      <el-form label-width="76px" label-position="left">
        <el-form-item label="文件">
          <input
            ref="uploadInput"
            type="file"
            :accept="UPLOAD_ACCEPT"
            class="file-input"
            @change="onUploadFilePicked"
          />
          <span class="picked">{{ uploadFile ? uploadFile.name : '还没选文件' }}</span>
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
        这四项不用都填。填了就会显示在资料的标签上，也会出现在书架的筛选项里。
      </p>
      <template #footer>
        <el-button @click="uploadDialog = false">取消</el-button>
        <el-button type="primary" :loading="uploading" @click="submitUpload">
          {{ uploading ? '上传中…' : '开始上传' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.admin-kb {
  max-width: 1100px;
  margin: 0 auto;
  padding: 20px 16px 60px;
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
  padding-top: 4px;
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
.token-card {
  margin: 14px 0;
  border-radius: 10px;
}
.token-row {
  display: flex;
  gap: 8px;
}
.err {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--zw-amber);
}
.admin-nav {
  display: flex;
  gap: 18px;
  margin: 12px 0 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--zw-line);
  font-size: 14px;
}
.admin-nav a {
  color: var(--zw-muted);
  text-decoration: none;
  padding: 2px 2px 6px;
  border-bottom: 2px solid transparent;
}
.admin-nav a:hover {
  color: var(--zw-green-ink);
}
.admin-nav a.router-link-active {
  color: var(--zw-green-ink);
  font-weight: 500;
  border-bottom-color: var(--zw-green);
}
.kb-stat {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 10px;
  font-size: 14px;
  color: var(--zw-text);
}
.kb-stat .ok {
  color: var(--zw-green);
}
.kb-stat .bad {
  color: var(--zw-danger);
}
.kb-stat .dot {
  color: var(--zw-line-strong);
}
.kb-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
/* T10：智能体设置搬到「设置」页后，本页只剩这张跳转小卡片用到的样式。
   （原先那套 qa-grid / qa-checks 等样式已随之删除，没有留死样式。） */
.qa-card {
  margin: 0 0 14px;
  border-radius: 10px;
}
.qa-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.qa-title {
  margin: 0;
  font-size: 15px;
  color: var(--zw-green-ink);
}
.qa-lead {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--zw-text);
}
.qa-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}
.kb-bar .count {
  font-size: 13px;
  color: var(--zw-muted);
}
.kb-table {
  background: var(--zw-surface);
}
.kb-pager {
  margin-top: 14px;
  justify-content: flex-end;
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
.dlg-hint {
  margin: 0;
  font-size: 12px;
  color: var(--zw-faint);
}
</style>
