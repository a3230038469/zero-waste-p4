<script setup lang="ts">
/**
 * 老师后台 · 访客反馈 —— 2026-10-14 新增
 *
 * 路由：/admin/feedback
 * 数据源：GET /api/admin/feedback（需请求头 X-Admin-Token）
 *
 * 为什么必须有一页 UI：
 *   反馈接口做完了，如果只有 API、没有页面，那这个功能等于只收不读 ——
 *   管理老师不可能用 curl 去看访客说了什么。收得进来、看得见、能导出跟进，三者缺一不可。
 *
 * 页面口径：
 *   - 提交者**匿名**，所以列表里没有「谁」，只有「怎么联系回去」（选填的联系方式）；
 *   - 针对某份资料的反馈会给一个跳转，点进去直接看那份资料，不用自己去资料库找；
 *   - 联系方式在这里显示（管理员要用来回访），但这条底线不能破：
 *     反馈的任何字段都不进对外页面。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { ADMIN_TOKEN_KEY, exportCsv, fetchFeedbackList, type AdminFeedbackItem } from '../api/admin'

const PAGE_SIZE = 20

const token = ref('')
const items = ref<AdminFeedbackItem[]>([])
const loading = ref(false)
const exporting = ref(false)
const errorText = ref('')

/** 按反馈类型筛选；空串 = 全部 */
const kindFilter = ref('')
/** 只看看留了联系方式的（这些是等着回复的工单） */
const onlyContact = ref(false)
const page = ref(1)

/** 从数据里抽出出现过的类型，避免前端再硬编码一张类型表 */
const kindOptions = computed(() => {
  const seen = new Map<string, string>()
  for (const item of items.value) seen.set(item.kind, item.kindLabel)
  return [...seen].map(([value, label]) => ({ value, label }))
})

const filtered = computed(() =>
  items.value.filter((item) => {
    if (kindFilter.value && item.kind !== kindFilter.value) return false
    if (onlyContact.value && !item.contact.trim()) return false
    return true
  })
)

const pageItems = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return filtered.value.slice(start, start + PAGE_SIZE)
})

/** 未留联系方式的条数：这些没法回访，只能靠内容本身判断要不要跟进 */
const noContactCount = computed(() => items.value.filter((i) => !i.contact.trim()).length)

/** 本地时间 `YYYY-MM-DD HH:mm`；后端给的是 ISO */
function shortTime(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value || '—'
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function doExport(): Promise<void> {
  if (!token.value) {
    errorText.value = '请先输入管理口令'
    return
  }
  exporting.value = true
  try {
    await exportCsv(token.value, 'feedback')
    ElMessage.success('反馈已开始下载')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导出失败')
  } finally {
    exporting.value = false
  }
}

async function load(): Promise<void> {
  if (!token.value) {
    errorText.value = '请输入管理口令'
    return
  }
  loading.value = true
  try {
    const data = await fetchFeedbackList(token.value)
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

onMounted(() => {
  const saved = localStorage.getItem(ADMIN_TOKEN_KEY)
  if (saved) {
    token.value = saved
    void load()
  }
})
</script>

<template>
  <section class="admin-feedback">
    <header class="head">
      <div>
        <h2 class="title">访客反馈</h2>
        <p class="sub">
          访客在「关于项目」页或资料详情页提交的反馈。提交是匿名的，只有对方自愿留下的联系方式。
        </p>
      </div>
      <el-button v-if="items.length" :loading="exporting" @click="doExport">
        导出反馈 CSV
      </el-button>
    </header>

    <nav class="admin-nav">
      <router-link to="/admin/knowledge">资料管理</router-link>
      <router-link to="/admin/users">注册用户</router-link>
      <router-link to="/admin/feedback">访客反馈</router-link>
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
      <div class="stat">
        <span>共 <b>{{ items.length }}</b> 条反馈</span>
        <span class="dot">·</span>
        <span>其中 <b>{{ noContactCount }}</b> 条没留联系方式</span>
      </div>

      <div class="bar">
        <el-select v-model="kindFilter" placeholder="全部类型" clearable class="kind-select">
          <el-option v-for="k in kindOptions" :key="k.value" :label="k.label" :value="k.value" />
        </el-select>
        <el-checkbox v-model="onlyContact" label="只看留了联系方式的" border />
        <span class="count">筛出 {{ filtered.length }} 条</span>
      </div>

      <div class="list">
        <article v-for="item in pageItems" :key="item.id" class="item">
          <div class="item-head">
            <span class="tag">{{ item.kindLabel }}</span>
            <span class="time">{{ shortTime(item.ts) }}</span>
            <span v-if="item.contact" class="contact">可回访：{{ item.contact }}</span>
            <span v-else class="no-contact">未留联系方式</span>
          </div>

          <p class="message">{{ item.message }}</p>

          <div class="item-foot">
            <RouterLink v-if="item.docId" :to="`/doc/${item.docId}`" class="doc-link">
              关于《{{ item.docTitle || item.docId }}》→
            </RouterLink>
            <span class="path">来自 {{ item.path || '—' }}</span>
          </div>
        </article>
      </div>

      <el-pagination
        v-model:current-page="page"
        :page-size="PAGE_SIZE"
        :total="filtered.length"
        layout="prev, pager, next, total"
        class="pager"
      />
    </template>

    <el-card v-else-if="!loading && token && !errorText" shadow="never" class="empty-card">
      <p class="empty-text">
        口令对了，但还没有收到反馈。等访客在「关于项目」页或资料详情页提交后，会出现在这里。
      </p>
    </el-card>
  </section>
</template>

<style scoped>
.admin-feedback {
  max-width: 1180px;
  margin: 0 auto;
  padding: 20px 16px 60px;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.title {
  margin: 0 0 6px;
  font-size: 22px;
  color: var(--zw-green-ink);
}
.sub {
  margin: 0;
  font-size: 13px;
  color: var(--zw-muted);
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
.stat {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 10px;
  font-size: 14px;
  color: var(--zw-text);
}
.stat .dot {
  color: var(--zw-line-strong);
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.kind-select {
  width: 160px;
}
.bar .count {
  font-size: 13px;
  color: var(--zw-muted);
}
/* 用卡片列表而不是表格：反馈正文长短不一，塞进表格单元格里会被截断 */
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.item {
  border: 1px solid var(--zw-line);
  border-radius: 10px;
  background: var(--zw-surface);
  padding: 13px 16px;
}
.item-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
}
.tag {
  font-weight: 600;
  color: var(--zw-green-deep);
  background: var(--zw-mint);
  border-radius: 999px;
  padding: 2px 10px;
}
.time {
  color: var(--zw-faint);
}
.contact {
  margin-left: auto;
  color: var(--zw-teal);
}
.no-contact {
  margin-left: auto;
  color: var(--zw-faint);
}
.message {
  margin: 9px 0 9px;
  font-size: 14px;
  line-height: 1.8;
  color: var(--zw-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.item-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
}
.doc-link {
  color: var(--zw-green);
}
.path {
  color: var(--zw-faint);
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
.empty-card {
  margin-top: 14px;
  border-radius: 10px;
}
.empty-text {
  margin: 0;
  font-size: 14px;
  color: var(--zw-muted);
}
</style>
