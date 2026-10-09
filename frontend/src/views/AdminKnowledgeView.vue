<script setup lang="ts">
/**
 * 老师后台 · 资料管理 —— 2026-10-08 本地演示版新增
 *
 * 路由：/admin/knowledge
 * 数据源：GET /api/admin/knowledge（需请求头 X-Admin-Token）
 *
 * 已接：列出全部资料、上传新资料（上传后引擎在后台解析，状态先变「处理中」）。
 * 全部已接：列出全部资料、上传（可一并填标签）、删除、下载。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import {
  ADMIN_TOKEN_KEY,
  UPLOAD_ACCEPT,
  deleteKnowledge,
  fetchKnowledgeList,
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

function statusTag(status: string): { type: 'success' | 'warning' | 'danger' | 'info'; text: string } {
  if (status === 'completed') return { type: 'success', text: '已入库' }
  if (status === 'failed') return { type: 'danger', text: '解析失败' }
  if (status === 'processing') return { type: 'warning', text: '处理中' }
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
const uploadForm = ref({ org: '', year: '', type: '', tags: '' })
const uploading = ref(false)

function openUpload(): void {
  if (!token.value) {
    errorText.value = '先输入口令、点「进入」，再上传'
    return
  }
  uploadFile.value = null
  uploadForm.value = { org: '', year: '', type: '', tags: '' }
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
    const result = await uploadKnowledge(token.value, uploadFile.value, uploadForm.value)
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
        <el-button type="primary" @click="openUpload">上传资料</el-button>
      </div>
    </header>

    <nav class="admin-nav">
      <router-link to="/admin/knowledge">资料管理</router-link>
      <router-link to="/admin/users">注册用户</router-link>
      <router-link to="/admin/stats">数据看板</router-link>
    </nav>

    <el-card shadow="never" class="token-card">
      <div class="token-row">
        <el-input
          v-model="token"
          type="password"
          show-password
          placeholder="管理口令（backend/.env 里的 ADMIN_STATS_TOKEN）"
          @keyup.enter="load"
        />
        <el-button type="primary" :loading="loading" @click="load">进入</el-button>
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
        <el-table-column label="操作" width="132" align="center" fixed="right">
          <template #default="scope">
            <el-button link type="primary" size="small" @click="download(scope.row)">下载</el-button>
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
          <el-input v-model="uploadForm.tags" placeholder="主题词，多个用逗号隔开" clearable />
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
  color: #1f3a24;
}
.kb-sub {
  margin: 0;
  font-size: 13px;
  color: #5f6f5f;
}
.kb-actions {
  padding-top: 4px;
}
.file-input {
  font-size: 13px;
  color: #33473a;
}
.picked {
  margin-left: 10px;
  font-size: 13px;
  color: #6b7d6b;
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
  color: #b26a00;
}
.admin-nav {
  display: flex;
  gap: 18px;
  margin: 12px 0 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid #e6ece6;
  font-size: 14px;
}
.admin-nav a {
  color: #5f6f5f;
  text-decoration: none;
  padding: 2px 2px 6px;
  border-bottom: 2px solid transparent;
}
.admin-nav a:hover {
  color: #1f3a24;
}
.admin-nav a.router-link-active {
  color: #1f3a24;
  font-weight: 500;
  border-bottom-color: #2e7d32;
}
.kb-stat {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 10px;
  font-size: 14px;
  color: #33473a;
}
.kb-stat .ok {
  color: #2e7d32;
}
.kb-stat .bad {
  color: #c45656;
}
.kb-stat .dot {
  color: #b9c6b9;
}
.kb-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.kb-bar .count {
  font-size: 13px;
  color: #6b7d6b;
}
.kb-table {
  background: #fff;
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
  color: #33473a;
}
.meta-year {
  color: #6b7d6b;
  font-variant-numeric: tabular-nums;
}
.no-meta {
  color: #b9c6b9;
}
.dlg-hint {
  margin: 0;
  font-size: 12px;
  color: #8a9a8a;
}
</style>
