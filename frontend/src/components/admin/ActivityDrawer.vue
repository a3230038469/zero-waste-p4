<script setup lang="ts">
/**
 * 使用明细抽屉 —— 2026-10-19 新增（数据看板重设计 · 第 3 件事）
 *
 * 干什么：点一个账号 → 逐条看它干了什么（AI 提问原文、预览/下载了哪份资料、检索了什么词、看了哪些页面）。
 * 数据源：`GET /api/admin/user-activity`（服务端埋点 events.jsonl），**只读、只展示，不做任何写操作**。
 * 边界：未知账号 / 范围内没记录 → 明确空态，不报错；记录多 → 分页「加载更多」，不一次性拉全量。
 *
 * ⚠️ 埋点带账号（userId）是 2026-10-14（T11）才上线的，更早的记录全在「游客」行里，追不回来；
 *    空态文案里要把这句讲清楚，别让人以为数据丢了。
 */
import { computed, ref, watch } from 'vue'
import {
  fetchUserActivity,
  GUEST_ACTIVITY_ID,
  type ActivityEventFilter,
  type UserActivityItem
} from '../../api/analytics'

const props = withDefaults(
  defineProps<{
    open: boolean
    /** 账号 id；游客组传 '__guest__'（见 GUEST_ACTIVITY_ID） */
    userId: string
    name?: string
    org?: string
    /** 默认回溯天数 */
    days?: number
  }>(),
  { name: '', org: '', days: 90 }
)

const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const PAGE_SIZE = 20

const FILTERS: { value: ActivityEventFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'ai_ask', label: 'AI 提问' },
  { value: 'preview', label: '在线预览' },
  { value: 'download', label: '下载' },
  { value: 'search', label: '检索' },
  { value: 'page_view', label: '浏览页面' }
]

const items = ref<UserActivityItem[]>([])
const total = ref(0)
const page = ref(1)
const filter = ref<ActivityEventFilter>('all')
const loading = ref(false)
const loadingMore = ref(false)
const errorText = ref('')
/** 后端补的账号名/机构（接口返回的比列表页更权威，列表页可能只有名字） */
const account = ref({ name: '', org: '' })

const isGuest = computed(() => props.userId === GUEST_ACTIVITY_ID)
const shownName = computed(() => account.value.name || props.name || (isGuest.value ? '游客' : '未知账号'))
const shownOrg = computed(() => account.value.org || props.org)
const hasMore = computed(() => items.value.length < total.value)

function fmt(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 事件 → 标签配色（只给三档语义：问答 / 取资料 / 其他） */
function toneOf(event: string): string {
  if (event === 'ai_ask') return 'is-ask'
  if (event === 'preview' || event === 'download') return 'is-doc'
  if (event === 'search') return 'is-search'
  return 'is-page'
}

function noAnswerText(value: boolean | null): string {
  if (value === true) return '答不上来'
  if (value === false) return '有答案'
  return '未判定'
}

async function load(reset: boolean): Promise<void> {
  if (loading.value || loadingMore.value) return
  if (reset) {
    page.value = 1
    items.value = []
    total.value = 0
    errorText.value = ''
    loading.value = true
  } else {
    loadingMore.value = true
  }
  try {
    const res = await fetchUserActivity({
      userId: props.userId,
      event: filter.value,
      page: page.value,
      pageSize: PAGE_SIZE,
      days: props.days
    })
    total.value = res.total
    account.value = { name: res.name || '', org: res.org || '' }
    items.value = page.value === 1 ? res.items : [...items.value, ...res.items]
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误'
    errorText.value = `读使用明细失败：${message}`
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

function loadMore(): void {
  if (!hasMore.value || loadingMore.value) return
  page.value += 1
  void load(false)
}

function pickFilter(value: ActivityEventFilter): void {
  if (filter.value === value) return
  filter.value = value
  void load(true)
}

function close(): void {
  emit('update:open', false)
}

/** 每次打开（或换账号）都重新拉第一页，避免看到上一个人的数据 */
watch(
  () => [props.open, props.userId] as const,
  ([open]) => {
    if (open) {
      filter.value = 'all'
      void load(true)
    }
  },
  { immediate: true }
)
</script>

<template>
  <el-drawer
    :model-value="open"
    :size="620"
    direction="rtl"
    :with-header="false"
    class="activity-drawer"
    @update:model-value="emit('update:open', $event)"
  >
    <div class="ad">
      <header class="ad-head">
        <div class="ad-who">
          <span class="ad-name">{{ shownName }}</span>
          <span v-if="isGuest" class="ad-guest">未登录</span>
          <span v-if="shownOrg" class="ad-org">{{ shownOrg }}</span>
        </div>
        <button class="ad-close" type="button" aria-label="关闭" @click="close">✕</button>
      </header>

      <div class="ad-filters">
        <button
          v-for="f in FILTERS"
          :key="f.value"
          type="button"
          class="ad-chip"
          :class="{ 'is-on': filter === f.value }"
          @click="pickFilter(f.value)"
        >
          {{ f.label }}
        </button>
        <span class="ad-range">近 {{ days }} 天</span>
      </div>

      <p v-if="errorText" class="ad-error">{{ errorText }}</p>

      <div v-else-if="loading" class="ad-loading">读取中…</div>

      <div v-else-if="items.length === 0" class="ad-empty">
        <strong>这个账号在近 {{ days }} 天内没有{{ filter === 'all' ? '' : '这一类' }}记录。</strong>
        <span>
          可能是它注册后还没用过，也可能只是这段时间没来。
          另外：埋点带账号是 2026-10-14 才上线的，更早的浏览/提问都记在「游客」那一组里，追不回来。
        </span>
      </div>

      <ol v-else class="ad-list">
        <li v-for="(item, index) in items" :key="`${item.ts}-${index}`" class="ad-item">
          <span class="ad-time zw-num">{{ fmt(item.ts) }}</span>
          <span class="ad-tag" :class="toneOf(item.event)">{{ item.label }}</span>
          <span class="ad-detail" :title="item.detail">{{ item.detail || item.path || '—' }}</span>
          <span v-if="item.event === 'ai_ask'" class="ad-flag" :class="{ 'is-bad': item.noAnswer === true }">
            {{ noAnswerText(item.noAnswer) }}
          </span>
        </li>
      </ol>

      <footer v-if="!loading && items.length > 0" class="ad-foot">
        <span class="ad-count">已显示 {{ items.length }} / {{ total }} 条</span>
        <el-button v-if="hasMore" size="small" :loading="loadingMore" @click="loadMore">加载更多</el-button>
        <span v-else class="ad-end">没有更多了</span>
      </footer>
    </div>
  </el-drawer>
</template>

<style scoped>
.ad {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 18px 20px 20px;
}

.ad-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ad-who {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.ad-name {
  font-size: 17px;
  font-weight: 600;
  color: var(--zw-ink);
}
.ad-guest {
  font-size: 12px;
  color: var(--zw-muted);
  background: var(--zw-mint-2);
  border: 1px solid var(--zw-line);
  border-radius: 999px;
  padding: 1px 8px;
}
.ad-org {
  font-size: 13px;
  color: var(--zw-muted);
}
.ad-close {
  border: 0;
  background: none;
  color: var(--zw-muted);
  font-size: 16px;
  cursor: pointer;
  line-height: 1;
  padding: 4px;
}
.ad-close:hover {
  color: var(--zw-ink);
}


.ad-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.ad-chip {
  font: inherit;
  font-size: 13px;
  padding: 4px 12px;
  border: 1px solid var(--zw-line-strong);
  border-radius: 999px;
  background: var(--zw-surface);
  color: var(--zw-text);
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}
.ad-chip:hover {
  border-color: var(--zw-green-soft);
  background: var(--zw-mint-2);
}
.ad-chip.is-on {
  background: var(--zw-green);
  border-color: var(--zw-green);
  color: #fff;
  font-weight: 600;
}
.ad-range {
  margin-left: auto;
  font-size: 12px;
  color: var(--zw-faint);
}

.ad-error {
  color: var(--zw-danger);
  font-size: 13px;
}
.ad-loading {
  padding: 24px 0;
  text-align: center;
  color: var(--zw-muted);
  font-size: 13px;
}

.ad-empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 18px 16px;
  border: 1px dashed var(--zw-line-strong);
  border-radius: var(--zw-radius-sm);
  background: #fbfdfb;
  font-size: 13px;
  line-height: 1.75;
  color: var(--zw-muted);
}
.ad-empty strong {
  color: var(--zw-text);
  font-weight: 600;
}

.ad-list {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.ad-item {
  display: grid;
  grid-template-columns: 84px 76px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--zw-line);
  font-size: 13px;
}
.ad-time {
  color: var(--zw-faint);
  font-size: 12px;
}
.ad-tag {
  justify-self: start;
  font-size: 11.5px;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.ad-tag.is-ask {
  color: var(--zw-green-deep);
  background: var(--zw-mint);
}
.ad-tag.is-doc {
  color: var(--zw-teal);
  background: var(--zw-teal-soft);
}
.ad-tag.is-search {
  color: var(--zw-amber-ink);
  background: var(--zw-amber-soft);
}
.ad-tag.is-page {
  color: var(--zw-muted);
  background: #f1f4f1;
}
.ad-detail {
  color: var(--zw-text);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ad-flag {
  font-size: 11.5px;
  color: var(--zw-muted);
  white-space: nowrap;
}
.ad-flag.is-bad {
  color: var(--zw-danger);
}

.ad-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 12px;
  margin-top: 4px;
  border-top: 1px solid var(--zw-line);
}
.ad-count,
.ad-end {
  font-size: 12px;
  color: var(--zw-faint);
}

@media (max-width: 640px) {
  .ad {
    padding: 14px 14px 16px;
  }
  .ad-item {
    grid-template-columns: 74px minmax(0, 1fr) auto;
  }
  .ad-tag {
    display: none;
  }
}
</style>
