<script setup lang="ts">
/**
 * 老师后台 · 访客反馈 —— 2026-10-14 新增
 *
 * 路由：/admin/feedback
 * 数据源：GET /api/admin/feedback（需管理员账号登录态）
 *
 * 为什么必须有一页 UI：
 *   反馈接口做完了，如果只有 API、没有页面，那这个功能等于只收不读 ——
 *   管理老师不可能用 curl 去看访客说了什么。收得进来、看得见、能导出跟进，三者缺一不可。
 *
 * 页面口径：
 *   - 提交者**匿名**（反馈表不记身份），所以列表里没有「必须要有的谁」，
 *     只有「怎么联系回去」（选填的联系方式）；埋点来源的旧反馈能带出提交账号；
 *   - 2026-10-19 起后端把**两个来源**合并返回：
 *       source='form'  = 进了反馈表的（现在唯一正路）；
 *       source='event' = 历史上只记了埋点、没进反馈表的旧反馈 —— 不并进来老师就会漏；
 *   - 针对某份资料的反馈会给一个跳转，点进去直接看那份资料，不用自己去资料库找；
 *   - 联系方式在这里显示（管理员要用来回访），但这条底线不能破：
 *     反馈的任何字段都不进对外页面。
 *
 * 2026-10-19：管理台鉴权从共用口令改成管理员账号，本页口令输入框与口令状态一并删除。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { exportCsv, fetchFeedbackList, type AdminFeedbackItem } from '../api/admin'

const PAGE_SIZE = 20

const items = ref<AdminFeedbackItem[]>([])
const loading = ref(false)
const exporting = ref(false)
const errorText = ref('')

/** 按反馈类型筛选；空串 = 全部 */
const kindFilter = ref('')
/** 按来源筛选：全部 / 反馈表 / 历史埋点 */
const sourceFilter = ref('')
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
    if (sourceFilter.value && item.source !== sourceFilter.value) return false
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
  exporting.value = true
  try {
    await exportCsv('feedback')
    ElMessage.success('反馈已开始下载')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导出失败')
  } finally {
    exporting.value = false
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const data = await fetchFeedbackList()
    items.value = data.items ?? []
    errorText.value = ''
    page.value = 1
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

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="admin-feedback">
    <header class="head">
      <div>
        <h2 class="title">访客反馈</h2>
        <p class="sub">
          访客在首页、资料详情页、我要投稿页提交的反馈。提交不记身份，只有对方自愿留下的联系方式；
          带「历史埋点」标记的是弹窗时代只记了统计、没进反馈表的旧记录，一并列在这里，不漏掉。
        </p>
      </div>
      <el-button v-if="items.length" :loading="exporting" @click="doExport">
        导出反馈 CSV
      </el-button>
    </header>

    <p v-if="errorText" class="err">{{ errorText }}</p>

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
        <el-select v-model="sourceFilter" placeholder="全部来源" clearable class="source-select">
          <el-option label="反馈表" value="form" />
          <el-option label="历史埋点" value="event" />
        </el-select>
        <el-checkbox v-model="onlyContact" label="只看留了联系方式的" border />
        <span class="count">筛出 {{ filtered.length }} 条</span>
      </div>

      <div class="list">
        <article v-for="item in pageItems" :key="item.id" class="item">
          <div class="item-head">
            <span class="tag">{{ item.kindLabel }}</span>
            <span v-if="item.reasonLabel" class="tag tag--reason">{{ item.reasonLabel }}</span>
            <span v-if="item.source === 'event'" class="tag tag--legacy">历史埋点</span>
            <span class="time">{{ shortTime(item.ts) }}</span>
            <span v-if="item.contact" class="contact">可回访：{{ item.contact }}</span>
            <span v-else class="no-contact">未留联系方式</span>
          </div>

          <p class="message">{{ item.message || '（没有写文字）' }}</p>

          <div class="item-foot">
            <RouterLink v-if="item.docId" :to="`/doc/${item.docId}`" class="doc-link">
              关于《{{ item.docTitle || item.docId }}》→
            </RouterLink>
            <span class="path">来自 {{ item.path || '—' }}</span>
            <span class="who">{{ item.userName ? `由 ${item.userName} 提交` : '未登录提交' }}</span>
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

    <el-card v-else-if="!loading && !errorText" shadow="never" class="empty-card">
      <p class="empty-text">
        还没有收到反馈。访客在首页、资料详情页或我要投稿页提交后，会出现在这里。
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
.source-select {
  width: 140px;
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
/* 细分原因：比粗分组弱一档，一眼能看出用户当初点的是哪个选项 */
.tag--reason {
  font-weight: 500;
  color: var(--zw-teal);
  background: var(--zw-teal-soft);
}
/* 历史埋点：只有统计、没进反馈表的旧记录，标出来免得和正式工单混淆 */
.tag--legacy {
  font-weight: 500;
  color: var(--zw-amber-ink);
  background: var(--zw-amber-soft);
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
.who {
  margin-left: auto;
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
