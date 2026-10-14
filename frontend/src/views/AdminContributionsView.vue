<script setup lang="ts">
/**
 * 老师后台 · 投稿审核 —— B09 公众上传（2026-10-13 新增）
 *
 * 路由：/admin/contributions
 * 数据源：GET /api/admin/contributions（需请求头 X-Admin-Token，与老师后台其余页面同一套口令）
 *
 * 这里管的是「访客投稿进来之后」：审核队列 → 通过（真进知识库）/ 退回（必填理由）。
 *   - 通过：后端把原件转发给已有的 /api/admin/knowledge/upload 入库，**成功才改状态**；
 *           入库失败会返回 502 且状态仍是「待审核」，页面上要把这句话原样显示出来，
 *           不能让老师以为已经通过了。
 *   - 退回：理由必填，投稿人在「我的投稿」里看得到 —— 这是投稿人唯一的反馈通路。
 *
 * ⚠️ 引擎入库后有几秒到几分钟延迟（解析进度在「资料管理」页看得到），
 *    通过后别立刻说「书架没有」。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { ADMIN_TOKEN_KEY } from '../api/admin'
import {
  approveContribution,
  fetchAdminContributions,
  openContributionFile,
  rejectContribution,
  type AdminContribution,
  type AdminContributionCounts,
  type ContributionStatus
} from '../api/contributions'
import { formatBytes } from '../utils/format'

const token = ref('')
const items = ref<AdminContribution[]>([])
const counts = ref<AdminContributionCounts>({ pending: 0, approved: 0, rejected: 0 })
const loading = ref(false)
const errorText = ref('')
const actingId = ref('')
/** 队列筛选：默认只看待审核（老师打开这一页就是来处理待审的） */
const statusFilter = ref<ContributionStatus | ''>('pending')
/** 检索词（标题/机构/文件名/投稿人）；队列长了以后这一栏是主要找稿手段 */
const keyword = ref('')

const FILTERS: { value: ContributionStatus | ''; label: string }[] = [
  { value: 'pending', label: '待审核' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已退回' },
  { value: '', label: '全部' }
]

const hasItems = computed(() => items.value.length > 0)

function errorMessage(err: unknown, fallback: string): string {
  const response = (err as { response?: { status?: number; data?: { error?: { message?: string } } } })
    .response
  if (response?.status === 403) return '口令不正确。'
  return response?.data?.error?.message ?? fallback
}

async function load(keepToken = true): Promise<void> {
  if (!token.value) {
    errorText.value = '请输入管理口令'
    return
  }
  loading.value = true
  try {
    const data = await fetchAdminContributions(token.value, {
      status: statusFilter.value,
      keyword: keyword.value.trim(),
      pageSize: 100
    })
    items.value = data.items ?? []
    counts.value = data.counts ?? { pending: 0, approved: 0, rejected: 0 }
    errorText.value = ''
    if (keepToken) localStorage.setItem(ADMIN_TOKEN_KEY, token.value)
  } catch (err) {
    errorText.value = errorMessage(err, '拉取失败，看看后端（:4000）在不在。')
    items.value = []
  } finally {
    loading.value = false
  }
}

function enterAdmin(): void {
  void load()
}

function switchFilter(value: ContributionStatus | ''): void {
  statusFilter.value = value
  void load()
}

/** 检索：回车或点「搜索」才请求（不逐字打后端） */
function search(): void {
  void load()
}

function resetKeyword(): void {
  keyword.value = ''
  void load()
}

/** el-radio-group 的 change 回调：入参是 string | number | boolean | undefined，这里收回枚举 */
function onFilterChange(value: string | number | boolean | undefined): void {
  switchFilter((value ?? '') as ContributionStatus | '')
}

/** 查看 / 下载原件（要带头，所以走后端取的 blob，见 api/contributions.ts） */
async function viewFile(row: AdminContribution): Promise<void> {
  try {
    await openContributionFile(token.value, row.id)
  } catch (err) {
    ElMessage.error(errorMessage(err, '原件打不开（可能已被清理）'))
  }
}

/** 通过：先讲清楚会做什么，再执行；入库失败时把后端的原因原样抛出来 */
async function approve(row: AdminContribution): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `「${row.title}」会真正送入知识库，通过后投稿人那边状态变「已通过」，书架上几分钟内可检索到。`,
      '确认通过这份投稿？',
      { confirmButtonText: '通过并入库', cancelButtonText: '再想想', type: 'info' }
    )
  } catch {
    return // 用户取消
  }

  actingId.value = row.id
  try {
    const res = await approveContribution(token.value, row.id)
    ElMessage.success(res.message || '已通过')
    await load()
  } catch (err) {
    // ⚠️ 这里是「没入成库」。后端已经保证状态仍是待审核，所以只要把原因显示出来
    ElMessage.error(errorMessage(err, '入库失败，状态仍是待审核'))
    await load()
  } finally {
    actingId.value = ''
  }
}

/** 退回：理由必填 —— 这段话是投稿人唯一能看到的反馈 */
async function reject(row: AdminContribution): Promise<void> {
  let reason = ''
  try {
    const result = await ElMessageBox.prompt(
      `请写明退回理由（至少 2 个字，投稿人会在「我的投稿」里看到）：`,
      `退回「${row.title}」`,
      {
        confirmButtonText: '确认退回',
        cancelButtonText: '取消',
        inputPlaceholder: '例：这份资料已有收录 / 不是公开出版物，无法核实来源',
        inputValidator: (value: string) => (value && value.trim().length >= 2) || '理由至少 2 个字'
      }
    )
    reason = String(result.value ?? '').trim()
  } catch {
    return // 用户取消
  }

  actingId.value = row.id
  try {
    const res = await rejectContribution(token.value, row.id, reason)
    ElMessage.success(res.message || '已退回')
    await load()
  } catch (err) {
    ElMessage.error(errorMessage(err, '退回失败'))
  } finally {
    actingId.value = ''
  }
}

function statusTag(status: ContributionStatus): { type: 'success' | 'warning' | 'danger'; text: string } {
  if (status === 'approved') return { type: 'success', text: '已通过' }
  if (status === 'rejected') return { type: 'danger', text: '已退回' }
  return { type: 'warning', text: '待审核' }
}

function fmtTime(value: string): string {
  if (!value) return '—'
  return value.replace('T', ' ').slice(0, 16)
}

onMounted(() => {
  // 口令与老师后台其余页面共用同一个 localStorage 键，进过任何一个页面都不用重输
  const saved = localStorage.getItem(ADMIN_TOKEN_KEY) ?? ''
  if (saved) {
    token.value = saved
    void load()
  }
})
</script>

<template>
  <section class="admin-contrib">
    <header class="head">
      <div>
        <h2 class="title">投稿审核</h2>
        <p class="sub">
          访客投来的资料先进这里。<b>通过</b>才会真正进知识库（书架才搜得到），<b>退回</b>必须写理由。
        </p>
      </div>
    </header>

    <nav class="admin-nav">
      <router-link to="/admin/knowledge">资料管理</router-link>
      <router-link to="/admin/users">注册用户</router-link>
      <router-link to="/admin/contributions">投稿审核</router-link>
      <router-link to="/admin/stats">数据看板</router-link>
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

    <template v-if="!errorText">
      <div class="stat-row">
        <span>待审核 <b class="warn">{{ counts.pending }}</b></span>
        <span class="dot">·</span>
        <span>已通过 <b class="ok">{{ counts.approved }}</b></span>
        <span class="dot">·</span>
        <span>已退回 <b class="bad">{{ counts.rejected }}</b></span>
      </div>

      <div class="filter-row">
        <el-radio-group :model-value="statusFilter" @change="onFilterChange">
          <el-radio-button v-for="f in FILTERS" :key="f.label" :value="f.value">{{ f.label }}</el-radio-button>
        </el-radio-group>
        <div class="filter-right">
          <el-input
            v-model="keyword"
            class="search-box"
            clearable
            placeholder="搜标题 / 机构 / 投稿人"
            @keyup.enter="search"
            @clear="search"
          />
          <el-button :loading="loading" @click="search">搜索</el-button>
          <el-button v-if="keyword" text @click="resetKeyword">清空</el-button>
          <el-button text :loading="loading" @click="load()">刷新</el-button>
        </div>
      </div>

      <el-empty v-if="!loading && !hasItems" description="这个状态下暂时没有投稿" />

      <el-table v-else v-loading="loading" :data="items" class="ct-table">
        <el-table-column label="标题" min-width="200">
          <template #default="{ row }">
            <div class="cell-title">{{ row.title }}</div>
            <div v-if="row.note" class="cell-note">{{ row.note }}</div>
          </template>
        </el-table-column>

        <el-table-column label="投稿人" width="150">
          <template #default="{ row }">
            <div>{{ row.userName || '—' }}</div>
            <div class="cell-sub">{{ row.userOrg || row.userPhone || '' }}</div>
          </template>
        </el-table-column>

        <el-table-column label="元数据" min-width="180">
          <template #default="{ row }">
            <div class="cell-sub">
              {{ [row.org, row.year, row.type, row.tags].filter(Boolean).join(' · ') || '—' }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="原件" width="150">
          <template #default="{ row }">
            <button type="button" class="link-btn" @click="viewFile(row)">{{ row.fileName }}</button>
            <div class="cell-sub">{{ formatBytes(row.size) }}</div>
          </template>
        </el-table-column>

        <el-table-column label="提交时间" width="140">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>

        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status).type" size="small">{{ statusTag(row.status).text }}</el-tag>
            <div v-if="row.status === 'rejected'" class="cell-sub reason">{{ row.reason }}</div>
            <div v-else-if="row.status === 'approved'" class="cell-sub">{{ fmtTime(row.reviewedAt) }}</div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'pending'">
              <el-button
                type="primary"
                size="small"
                :loading="actingId === row.id"
                @click="approve(row)"
              >
                通过
              </el-button>
              <el-button size="small" :disabled="actingId === row.id" @click="reject(row)">退回</el-button>
            </template>
            <span v-else class="cell-sub">已处理</span>
          </template>
        </el-table-column>
      </el-table>
    </template>
  </section>
</template>

<style scoped>
.admin-contrib {
  max-width: var(--zw-max);
  margin: 0 auto;
  padding: 28px 20px 56px;
}

.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.title {
  margin: 0 0 8px;
  font-size: 22px;
  color: var(--zw-ink);
}

.sub {
  margin: 0;
  max-width: 52em;
  font-size: 13px;
  line-height: 1.8;
  color: var(--zw-muted);
}

.admin-nav {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin: 18px 0;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--zw-line);
}

.admin-nav a {
  font-size: 13px;
  color: var(--zw-muted);
  text-decoration: none;
}

.admin-nav a:hover,
.admin-nav a.router-link-active {
  color: var(--zw-green-deep);
}

.admin-nav a.router-link-active {
  font-weight: 600;
}

.token-card {
  margin-bottom: 18px;
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
}

.token-row {
  display: flex;
  gap: 10px;
}

.err {
  margin: 10px 0 0;
  font-size: 13px;
  color: #c0392b;
}

.stat-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--zw-muted);
}

.stat-row b {
  font-size: 16px;
}

.warn {
  color: var(--zw-amber);
}

.ok {
  color: var(--zw-green);
}

.bad {
  color: #c0392b;
}

.dot {
  color: var(--zw-faint);
}

.filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.filter-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 搜索框固定一档宽度：太窄打不完一个机构名，太宽会把状态筛选挤到第二行 */
.search-box {
  width: 220px;
}

.ct-table {
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  overflow: hidden;
}

.cell-title {
  font-size: 13px;
  color: var(--zw-ink);
}

.cell-note {
  margin-top: 2px;
  font-size: 12px;
  color: var(--zw-muted);
  line-height: 1.6;
}

.cell-sub {
  font-size: 12px;
  color: var(--zw-faint);
}

.reason {
  color: #c0392b;
}

.link-btn {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 13px;
  color: var(--zw-green);
  cursor: pointer;
  text-align: left;
  text-decoration: underline;
  word-break: break-all;
}
</style>
