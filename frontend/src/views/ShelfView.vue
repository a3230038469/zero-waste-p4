<script setup lang="ts">
/**
 * 资料库页（原「书架页」）—— 对外展示站版（2026-10-10 改版）
 *
 * 对外化改动：
 *   1. 页名「书架」→「资料库」，并补一段定位说明与总数，让首次到访的人知道这是什么。
 *   2. 支持从首页带筛选进来：`/shelf?tag=塑料`、`/shelf?type=政策法规`、`/shelf?q=……`
 *      （此前只认 `q`，首页的主题/类型入口点进来是「没筛选」的状态，会让人以为点错了）。
 *   3. 机构下拉改为**可搜索**：库里去重后有 370+ 个机构名，其中不少是九部门联合署名的长串，
 *      纯下拉翻不动，必须能打字过滤。
 *   4. 补**排序**（按年份 / 按最新收录）。接口本来就支持 `sort`，页面没暴露。
 *   5. 补「已选条件」回显与一键清除；卡片换成公用 DocCard（含「另有相同副本」标记）。
 *
 * 数据走 src/api/docs.ts → 后端 GET /api/docs、/api/docs/facets
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getDocs, getFacets, type DocListQuery } from '../api/docs'
import type { DocListResponse, FacetsResponse } from '../api/types'
import DocCard from '../components/DocCard.vue'

const PAGE_SIZE = 20

const router = useRouter()
const route = useRoute()

const activeType = ref('')
const selectedOrgs = ref<string[]>([])
const selectedYears = ref<string[]>([])
const selectedTags = ref<string[]>([])
const keyword = ref('')
const sort = ref<'year_desc' | 'newest'>('year_desc')
const page = ref(1)
const loading = ref(false)
/** 列表加载失败（接口错误，可重试；与「无结果」区分） */
const loadError = ref(false)
const list = ref<DocListResponse | null>(null)
const facets = ref<FacetsResponse>({ types: [], orgs: [], years: [], tags: [] })

const items = computed(() => list.value?.items ?? [])
const total = computed(() => list.value?.total ?? 0)
/**
 * 首屏还没拿到任何数据 —— 此时数字要显示「—」，不能显示 0。
 * 0 的含义是「查过了，确实没有」；加载中显示 0 等于把「还没查」说成「没有」，是误导。
 * 已有旧数据时（翻页、改筛选）保留旧数字，用户看到的是连续统计，不会闪。
 */
const firstLoadPending = computed(() => !list.value && !loadError.value)

/**
 * 类型标签：库里实际存在的类型全列（不写死）。
 * 为什么不能只写死四个 —— 库里另有「研究实践报告」「各类标准」「国内政策法规」
 * 「国际公约」「科学认知」等类型（合计 100 多份），写死就永远筛不到它们。
 */
const typeTabs = computed(() => {
  const all = facets.value.types.map((t) => t.value).filter(Boolean)
  const totalAll = facets.value.types.reduce((sum, t) => sum + t.count, 0)
  return [
    { value: '', label: '全部', count: totalAll },
    ...all.map((v) => ({
      value: v,
      label: v,
      count: facets.value.types.find((t) => t.value === v)?.count ?? 0
    }))
  ]
})

interface ActiveChip {
  /** 所属筛选维度，决定删掉它时该清哪个状态 */
  dim: 'type' | 'org' | 'year' | 'tag' | 'q'
  label: string
  value: string
}

/** 已选条件回显（给用户一个「我现在筛了什么」的确认） */
const activeChips = computed<ActiveChip[]>(() => {
  const chips: ActiveChip[] = []
  for (const v of selectedOrgs.value) chips.push({ dim: 'org', label: '机构', value: v })
  for (const v of selectedYears.value) chips.push({ dim: 'year', label: '年份', value: `${v} 年` })
  for (const v of selectedTags.value) chips.push({ dim: 'tag', label: '主题', value: v })
  if (activeType.value) chips.push({ dim: 'type', label: '类型', value: activeType.value })
  const q = keyword.value.trim()
  if (q) chips.push({ dim: 'q', label: '关键词', value: q })
  return chips
})

/** 切换类型标签：抽成方法而不是模板内联两句，避免格式化工具折行时把分号吞掉导致编译报错 */
function selectType(value: string): void {
  activeType.value = value
  onFilterChange()
}

/** 按「维度 + 值」删条件：用索引删会在多选里错位（下拉顺序与 chip 顺序不一定一致） */
function removeChip(chip: ActiveChip): void {
  if (chip.dim === 'org') selectedOrgs.value = selectedOrgs.value.filter((v) => v !== chip.value)
  else if (chip.dim === 'year')
    selectedYears.value = selectedYears.value.filter((v) => `${v} 年` !== chip.value)
  else if (chip.dim === 'tag')
    selectedTags.value = selectedTags.value.filter((v) => v !== chip.value)
  else if (chip.dim === 'type') activeType.value = ''
  else keyword.value = ''
  onFilterChange()
}

function buildQuery(): DocListQuery {
  return {
    type: activeType.value || undefined,
    orgs: selectedOrgs.value,
    years: selectedYears.value,
    tags: selectedTags.value,
    q: keyword.value.trim() || undefined,
    page: page.value,
    pageSize: PAGE_SIZE,
    sort: sort.value
  }
}

async function fetchList(): Promise<void> {
  loading.value = true
  loadError.value = false
  try {
    list.value = await getDocs(buildQuery())
  } catch {
    // 接口失败与「筛选无结果」是两回事：前者给重试，后者才引导换条件。
    // 没有这一分支时失败也会落到底部的「没有匹配的资料」，用户会被带偏。
    loadError.value = true
  } finally {
    loading.value = false
  }
}

async function fetchFacets(): Promise<void> {
  facets.value = await getFacets(buildQuery())
}

function onFilterChange(): void {
  page.value = 1
  void fetchList()
  void fetchFacets()
}

function onPageChange(p: number): void {
  page.value = p
  void fetchList()
}

function resetAll(): void {
  activeType.value = ''
  selectedOrgs.value = []
  selectedYears.value = []
  selectedTags.value = []
  keyword.value = ''
  sort.value = 'year_desc'
  // 地址栏里的筛选也要清掉，否则刷新又回来了
  void router.replace({ path: '/shelf' })
  onFilterChange()
}

/** 零结果时引导去首页问 AI（首页有问答入口） */
function goAskAi(): void {
  void router.push('/')
}

/** 把地址栏参数灌进筛选状态。首页的主题/类型入口就是靠这一步生效的。 */
function applyRouteQuery(): void {
  const { q, tag, type, org, year, sort: sortQuery } = route.query

  keyword.value = typeof q === 'string' ? q : ''
  activeType.value = typeof type === 'string' ? type : ''

  const toList = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : []

  selectedTags.value = toList(tag)
  selectedOrgs.value = toList(org)
  selectedYears.value = toList(year)
  sort.value = sortQuery === 'newest' ? 'newest' : 'year_desc'
  page.value = 1

  onFilterChange()
}

onMounted(applyRouteQuery)

// 已在资料库页时，从首页再次点击主题/类型入口会带新的 query 过来，必须跟着变
watch(
  () => route.query,
  () => {
    if (route.path === '/shelf') applyRouteQuery()
  }
)
</script>

<template>
  <div class="shelf">
    <header class="page-head">
      <p class="zw-eyebrow">资料库</p>
      <h1>全部资料</h1>
      <p class="zw-sub">
        共收录
        <strong class="zw-num">{{ loadError || firstLoadPending ? '—' : total }}</strong>
        份资料，可按类型切换， 或按机构、年份、主题组合筛选；每项下拉都标出了可命中的数量。
      </p>
    </header>

    <!-- 类型标签：库里实际存在的类型自动补全。
         加载失败时藏起来——否则会显示一排 0，让人误以为库里没数据 -->
    <div v-if="!loadError" class="type-row" role="tablist" aria-label="资料类型">
      <button
        v-for="t in typeTabs"
        :key="t.value || 'all'"
        type="button"
        role="tab"
        class="type-tab"
        :class="{ 'is-active': activeType === t.value }"
        :aria-selected="activeType === t.value"
        @click="selectType(t.value)"
      >
        {{ t.label }}
        <span class="tab-count zw-num">{{ firstLoadPending ? '—' : t.count }}</span>
      </button>
    </div>

    <!-- 筛选区（加载失败时一并隐藏，空下拉同样会误导） -->
    <div v-if="!loadError" class="toolbar">
      <el-select
        v-model="selectedOrgs"
        multiple
        filterable
        collapse-tags
        collapse-tags-tooltip
        clearable
        placeholder="发布机构"
        class="filter-select"
        @change="onFilterChange"
      >
        <el-option v-for="f in facets.orgs" :key="f.value" :label="f.value" :value="f.value">
          <span class="opt-value">{{ f.value }}</span>
          <span class="opt-count">{{ f.count }}</span>
        </el-option>
      </el-select>

      <el-select
        v-model="selectedYears"
        multiple
        filterable
        collapse-tags
        clearable
        placeholder="年份"
        class="filter-select filter-year"
        @change="onFilterChange"
      >
        <el-option
          v-for="f in facets.years"
          :key="f.value"
          :label="`${f.value} 年 (${f.count})`"
          :value="f.value"
        />
      </el-select>

      <el-select
        v-model="selectedTags"
        multiple
        filterable
        collapse-tags
        clearable
        placeholder="主题领域"
        class="filter-select"
        @change="onFilterChange"
      >
        <el-option v-for="f in facets.tags" :key="f.value" :label="f.value" :value="f.value">
          <span class="opt-value">{{ f.value }}</span>
          <span class="opt-count">{{ f.count }}</span>
        </el-option>
      </el-select>

      <el-select v-model="sort" class="filter-sort" @change="onFilterChange">
        <el-option label="按年份排序" value="year_desc" />
        <el-option label="按最新收录" value="newest" />
      </el-select>

      <el-input
        v-model="keyword"
        placeholder="搜索资料名称、机构……"
        clearable
        class="search-input"
        @keyup.enter="onFilterChange"
        @clear="onFilterChange"
      />
    </div>

    <!-- 已选条件 -->
    <div v-if="activeChips.length" class="active-row">
      <span class="active-label">当前筛选：</span>
      <button
        v-for="(c, i) in activeChips"
        :key="`${c.dim}-${c.value}-${i}`"
        type="button"
        class="active-chip"
        @click="removeChip(c)"
      >
        {{ c.label }}：{{ c.value }} <span aria-hidden="true">×</span>
      </button>
      <button type="button" class="clear-all" @click="resetAll">全部清除</button>
    </div>

    <!-- 骨架屏 -->
    <div v-if="loading" class="cards">
      <div v-for="n in 8" :key="n" class="skeleton-card">
        <el-skeleton :rows="3" animated />
      </div>
    </div>

    <!-- 接口失败：可重试的错误态（区别于「没有匹配的资料」） -->
    <div v-else-if="loadError" class="zw-error load-error">
      <p class="zw-error__title">资料列表加载失败</p>
      <p class="zw-error__desc">网络或服务暂时不可用，稍后重试一般就能恢复。</p>
      <button type="button" class="zw-error__retry" @click="onFilterChange">重试</button>
    </div>

    <template v-else-if="items.length > 0">
      <div class="cards">
        <DocCard v-for="doc in items" :key="doc.id" :doc="doc" />
      </div>

      <div class="pager">
        <!-- pager-count 收到 5：375 宽下 9 个页码 + 总数会撑出横向滚动 -->
        <el-pagination
          background
          :pager-count="5"
          layout="total, prev, pager, next"
          :total="total"
          :page-size="PAGE_SIZE"
          :current-page="page"
          @current-change="onPageChange"
        />
      </div>
    </template>

    <!-- 空态：走站内 zw-empty 规范（与 404、错误态同一套留白与字号），不用 el-empty 默认插画 -->
    <div v-else class="zw-empty">
      <svg class="empty-ico" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <circle cx="21" cy="21" r="11" stroke="currentColor" stroke-width="2" />
        <path d="M29.5 29.5 38 38" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <p class="zw-empty__title">没有匹配的资料</p>
      <p class="zw-empty__desc">换一个关键词，或者放宽筛选条件试试。</p>
      <div class="empty-actions">
        <el-button @click="resetAll">清除筛选</el-button>
        <el-button type="primary" @click="goAskAi">试试问 AI</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-head {
  padding: 8px 0 16px;
  max-width: 780px;
}

.page-head h1 {
  font-size: var(--zw-fs-h1);
  margin: 0 0 10px;
}

.page-head strong {
  color: var(--zw-green);
  font-size: var(--zw-fs-h3);
  margin: 0 3px;
}

/* 类型标签 */
.type-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.type-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--zw-line);
  background: var(--zw-surface);
  color: var(--zw-text);
  font: inherit;
  font-size: var(--zw-fs-body);
  padding: 7px 14px;
  border-radius: 999px;
  cursor: pointer;
  transition:
    border-color var(--zw-dur-fast) var(--zw-ease),
    background var(--zw-dur-fast) var(--zw-ease),
    color var(--zw-dur-fast) var(--zw-ease);
}

.type-tab:hover {
  border-color: var(--zw-green-soft);
  color: var(--zw-green-deep);
}

.type-tab.is-active {
  background: var(--zw-green);
  border-color: var(--zw-green);
  color: var(--zw-surface);
}

.tab-count {
  font-size: var(--zw-fs-xs);
  color: var(--zw-muted);
  background: var(--zw-mint-2);
  border-radius: 999px;
  padding: 1px 7px;
}

.type-tab.is-active .tab-count {
  color: #eaf5ea;
  background: rgba(255, 255, 255, 0.22);
}

/* 工具栏 */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}

.filter-select {
  width: 220px;
}

.filter-year {
  width: 150px;
}

.filter-sort {
  width: 140px;
}

.search-input {
  width: 260px;
  margin-left: auto;
}

/* Element Plus 下拉项：左值右计数 */
.opt-value {
  float: left;
}

.opt-count {
  float: right;
  color: var(--zw-faint);
  font-size: var(--zw-fs-xs);
}

/* 已选条件 */
.active-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 18px;
  padding: 10px 14px;
  background: var(--zw-mint-2);
  border-radius: var(--zw-radius-sm);
}

.active-label {
  font-size: var(--zw-fs-sm);
  color: var(--zw-muted);
}

.active-chip {
  border: 1px solid var(--zw-line-strong);
  background: var(--zw-surface);
  color: var(--zw-green-deep);
  font: inherit;
  font-size: var(--zw-fs-xs);
  padding: 3px 10px;
  border-radius: 999px;
  cursor: pointer;
}

.active-chip:hover {
  border-color: var(--zw-green);
}

.clear-all {
  border: 0;
  background: none;
  font: inherit;
  font-size: var(--zw-fs-sm);
  color: var(--zw-muted);
  text-decoration: underline;
  cursor: pointer;
  margin-left: auto;
}

.clear-all:hover {
  color: var(--zw-green-deep);
}

/* 卡片网格 */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 16px;
}

.skeleton-card {
  background: var(--zw-surface);
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  padding: 20px;
}

/* 加载失败卡片：跟骨架屏卡片同样的外框，保持网格节奏 */
.load-error {
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  background: var(--zw-surface);
  box-shadow: var(--zw-shadow-sm);
}

.pager {
  display: flex;
  justify-content: center;
  margin-top: 28px;
}

.empty-ico {
  width: 44px;
  height: 44px;
  color: var(--zw-green-soft);
}

.empty-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--zw-space-3);
  justify-content: center;
}

/* 窄屏 */
@media (max-width: 760px) {
  .filter-select,
  .filter-year,
  .filter-sort,
  .search-input {
    width: 100%;
    margin-left: 0;
  }

  .page-head h1 {
    font-size: var(--zw-fs-h2);
  }

  /* 窄屏藏掉「共 N 条」，否则分页条连同总数会撑出横向滚动 */
  .pager :deep(.el-pagination__total) {
    display: none;
  }

  .pager {
    overflow-x: auto;
    padding-bottom: var(--zw-space-1);
  }
}
</style>
