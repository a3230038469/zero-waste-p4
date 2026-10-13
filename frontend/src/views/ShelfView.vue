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
 * T8 改动（2026-10-13）：
 *   6. 机构下拉**只列出现 ≥2 次的**（老库 370 → 46 项左右），并改为**可远程搜索** ——
 *      只出现一次的那 295 个机构靠输入关键字找（走 `?orgSearch=`，上限 20 条）。
 *   7. 新增「所属方向」筛选项（数据里的 `srcTable`：零废弃 / 化学品与健康），默认不过滤；
 *      数据源没有方向数据时**整块不渲染**（不摆筛不中的假选项）。
 *   8. 联合发文的长串不再甩一长串，显示成 `A + B 等N家`（后端给 label，前端只负责显示）。
 *
 * 数据走 src/api/docs.ts → 后端 GET /api/docs、/api/docs/facets
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getDocs, getFacets, searchOrgs, type DocListQuery } from '../api/docs'
import type { DocListResponse, FacetItem, FacetsResponse } from '../api/types'
import DocCard from '../components/DocCard.vue'

const PAGE_SIZE = 20

const router = useRouter()
const route = useRoute()

const activeType = ref('')
const selectedOrgs = ref<string[]>([])
const selectedYears = ref<string[]>([])
const selectedTags = ref<string[]>([])
/** 【T8】所属方向（数据原值，如 `知识查询（零废弃）`），显示名走 label */
const selectedSrcTables = ref<string[]>([])
const keyword = ref('')
const sort = ref<'year_desc' | 'newest'>('year_desc')
const page = ref(1)
const loading = ref(false)
const list = ref<DocListResponse | null>(null)
const facets = ref<FacetsResponse>({ types: [], orgs: [], years: [], tags: [], srcTables: [] })

/**
 * 【T8】机构下拉的选项。
 *
 * 后端默认只回「出现 ≥2 次」的机构（老库实测 46 个），另有 295 个机构只出现一次 ——
 * 它们靠**搜索框**找（`?orgSearch=`，上限 20 条）。所以这里的选项是动态的：
 * 不输入时 = 默认列表；一输入就换成搜索命中。
 */
const orgOptions = ref<FacetItem[]>([])
/** value -> 展示名（联合发文长串的短标签、别名主名都从这里取） */
const orgLabelMap = ref<Record<string, string>>({})
/** 用户当前输入的关键字（空 = 没在搜） */
const orgKeyword = ref('')
const orgSearching = ref(false)
/** 只认最后一次输入的回包（防止慢请求盖掉新结果） */
let orgSearchSeq = 0

const items = computed(() => list.value?.items ?? [])
const total = computed(() => list.value?.total ?? 0)

/**
 * 类型标签：库里实际存在的类型全列（不写死）。
 * 为什么不能只写死四个 —— 库里另有「研究实践报告」「各类标准」「国内政策法规」
 * 「国际公约」「科学认知」等类型（合计 100 多份），写死就永远筛不到它们。
 */
const typeTabs = computed(() => {
  const all = facets.value.types.map((t) => t.value).filter(Boolean)
  const totalAll = facets.value.types.reduce((sum, t) => sum + t.count, 0)
  return [{ value: '', label: '全部', count: totalAll }, ...all.map((v) => ({
    value: v,
    label: v,
    count: facets.value.types.find((t) => t.value === v)?.count ?? 0
  }))]
})

/** 【T8】所属方向下拉：数据源没有这一项时是空数组 → 页面不渲染它（不摆筛不中的假选项） */
const srcTableOptions = computed(() => facets.value.srcTables ?? [])

interface ActiveChip {
  /** 所属筛选维度，决定删掉它时该清哪个状态 */
  dim: 'type' | 'org' | 'year' | 'tag' | 'srcTable' | 'q'
  label: string
  value: string
}

/** 筛选项的展示名：有 label 用 label（联合发文短标签、方向中文名），否则用值本身 */
function orgLabelOf(value: string): string {
  return orgLabelMap.value[value] ?? value
}

function srcTableLabelOf(value: string): string {
  return srcTableOptions.value.find((t) => t.value === value)?.label ?? value
}

/** 把一批筛选项的展示名收进字典（默认列表与搜索命中都要收） */
function learnOrgLabels(list: FacetItem[]): void {
  const next = { ...orgLabelMap.value }
  for (const item of list) next[item.value] = item.label ?? item.value
  orgLabelMap.value = next
}

/**
 * 选项 = 服务端给的 + 已选中的。
 *
 * 为什么要把已选中的并进来：`el-select` 的标签文案是从选项列表里取的，
 * 搜过一次之后选项换成了命中列表，之前选的那几项就不在列表里了 —— 标签会退化成原始的
 * 长串（联合发文）甚至看不到。并进来就能一直显示短标签。
 */
function mergeOrgOptions(list: FacetItem[]): FacetItem[] {
  const map = new Map<string, FacetItem>()
  for (const item of list) map.set(item.value, item)
  for (const value of selectedOrgs.value) {
    if (!map.has(value)) map.set(value, { value, count: 0, label: orgLabelOf(value) })
  }
  return [...map.values()]
}

/** 机构搜索：输入即搜（后端模糊匹配 + 别名展开），清空则回到默认列表 */
async function onOrgSearch(input: string): Promise<void> {
  const kw = input.trim()
  orgKeyword.value = kw
  if (!kw) {
    orgOptions.value = mergeOrgOptions(facets.value.orgs)
    return
  }
  const seq = (orgSearchSeq += 1)
  orgSearching.value = true
  try {
    const hits = await searchOrgs(buildQuery(), kw)
    if (seq !== orgSearchSeq) return
    learnOrgLabels(hits)
    orgOptions.value = mergeOrgOptions(hits)
  } catch {
    // 搜索失败不打断页面：保住当前选项，用户还能按已选项继续筛
  } finally {
    if (seq === orgSearchSeq) orgSearching.value = false
  }
}

/** 已选条件回显（给用户一个「我现在筛了什么」的确认） */
const activeChips = computed<ActiveChip[]>(() => {
  const chips: ActiveChip[] = []
  for (const v of selectedOrgs.value) chips.push({ dim: 'org', label: '机构', value: v })
  for (const v of selectedYears.value) chips.push({ dim: 'year', label: '年份', value: `${v} 年` })
  for (const v of selectedTags.value) chips.push({ dim: 'tag', label: '主题', value: v })
  for (const v of selectedSrcTables.value) chips.push({ dim: 'srcTable', label: '方向', value: v })
  if (activeType.value) chips.push({ dim: 'type', label: '类型', value: activeType.value })
  const q = keyword.value.trim()
  if (q) chips.push({ dim: 'q', label: '关键词', value: q })
  return chips
})

/** 已选条件的显示名（机构走字典，方向走 label，其余原样） */
function chipText(chip: ActiveChip): string {
  if (chip.dim === 'org') return orgLabelOf(chip.value)
  if (chip.dim === 'srcTable') return srcTableLabelOf(chip.value)
  return chip.value
}

/** 按「维度 + 值」删条件：用索引删会在多选里错位（下拉顺序与 chip 顺序不一定一致） */
function removeChip(chip: ActiveChip): void {
  if (chip.dim === 'org') selectedOrgs.value = selectedOrgs.value.filter((v) => v !== chip.value)
  else if (chip.dim === 'year') selectedYears.value = selectedYears.value.filter((v) => `${v} 年` !== chip.value)
  else if (chip.dim === 'tag') selectedTags.value = selectedTags.value.filter((v) => v !== chip.value)
  else if (chip.dim === 'srcTable') selectedSrcTables.value = selectedSrcTables.value.filter((v) => v !== chip.value)
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
    srcTables: selectedSrcTables.value,
    q: keyword.value.trim() || undefined,
    page: page.value,
    pageSize: PAGE_SIZE,
    sort: sort.value
  }
}

async function fetchList(): Promise<void> {
  loading.value = true
  try {
    list.value = await getDocs(buildQuery())
  } finally {
    loading.value = false
  }
}

async function fetchFacets(): Promise<void> {
  facets.value = await getFacets(buildQuery())
  learnOrgLabels(facets.value.orgs)
  // 用户正在搜机构 → 带着新的筛选条件重搜一次（数字才不会停在上一轮的）
  if (orgKeyword.value) await onOrgSearch(orgKeyword.value)
  else orgOptions.value = mergeOrgOptions(facets.value.orgs)
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
  selectedSrcTables.value = []
  keyword.value = ''
  orgKeyword.value = ''
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
  const { q, tag, type, org, year, srcTable, sort: sortQuery } = route.query

  keyword.value = typeof q === 'string' ? q : ''
  activeType.value = typeof type === 'string' ? type : ''

  const toList = (value: unknown): string[] =>
    typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

  selectedTags.value = toList(tag)
  selectedOrgs.value = toList(org)
  selectedYears.value = toList(year)
  // T8：所属方向也能从地址栏带进来（`/shelf?srcTable=知识查询（零废弃）`）
  selectedSrcTables.value = toList(srcTable)
  orgKeyword.value = ''
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
        共收录 <strong class="zw-num">{{ total }}</strong> 份资料，可按类型切换，
        或按机构、年份、主题、方向组合筛选；每项下拉都标出了可命中的数量，
        机构支持输入关键字搜索。
      </p>
    </header>

    <!-- 类型标签：库里实际存在的类型自动补全 -->
    <div class="type-row" role="tablist" aria-label="资料类型">
      <button
        v-for="t in typeTabs"
        :key="t.value || 'all'"
        type="button"
        role="tab"
        class="type-tab"
        :class="{ 'is-active': activeType === t.value }"
        :aria-selected="activeType === t.value"
        @click="activeType = t.value; onFilterChange()"
      >
        {{ t.label }}
        <span class="tab-count zw-num">{{ t.count }}</span>
      </button>
    </div>

    <!-- 筛选区 -->
    <div class="toolbar">
      <!-- 【T8】机构：默认只列出现 ≥2 次的（老库实测 46 个，原来 370 个没法用），
           低频机构（含联合发文长串）靠输入关键字搜（走 ?orgSearch=，上限 20 条）。
           搜索命中里联合发文显示成 `A + B 等N家`，不再甩一长串。 -->
      <el-select
        v-model="selectedOrgs"
        multiple
        filterable
        remote
        reserve-keyword
        collapse-tags
        collapse-tags-tooltip
        clearable
        :remote-method="onOrgSearch"
        :loading="orgSearching"
        placeholder="发布机构（可搜索）"
        class="filter-select"
        @change="onFilterChange"
      >
        <el-option
          v-for="f in orgOptions"
          :key="f.value"
          :label="f.label ?? f.value"
          :value="f.value"
        >
          <span class="opt-value">{{ f.label ?? f.value }}</span>
          <span v-if="f.count > 0" class="opt-count">{{ f.count }}</span>
        </el-option>
      </el-select>

      <!-- 【T8】所属方向（数据里只有两个值：零废弃 / 化学品与健康）。
           数据源没有这一项时整块不渲染，别摆一个筛不中的假选项。 -->
      <el-select
        v-if="srcTableOptions.length > 0 || selectedSrcTables.length > 0"
        v-model="selectedSrcTables"
        multiple
        collapse-tags
        collapse-tags-tooltip
        clearable
        placeholder="所属方向"
        class="filter-select filter-src"
        @change="onFilterChange"
      >
        <el-option
          v-for="f in srcTableOptions"
          :key="f.value"
          :label="f.label ?? f.value"
          :value="f.value"
        >
          <span class="opt-value">{{ f.label ?? f.value }}</span>
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
        <el-option v-for="f in facets.years" :key="f.value" :label="`${f.value} 年 (${f.count})`" :value="f.value" />
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
        {{ c.label }}：{{ chipText(c) }} <span aria-hidden="true">×</span>
      </button>
      <button type="button" class="clear-all" @click="resetAll">全部清除</button>
    </div>

    <!-- 骨架屏 -->
    <div v-if="loading" class="cards">
      <div v-for="n in 8" :key="n" class="skeleton-card">
        <el-skeleton :rows="3" animated />
      </div>
    </div>

    <template v-else-if="items.length > 0">
      <div class="cards">
        <DocCard v-for="doc in items" :key="doc.id" :doc="doc" />
      </div>

      <div class="pager">
        <el-pagination
          background
          layout="total, prev, pager, next"
          :total="total"
          :page-size="PAGE_SIZE"
          :current-page="page"
          @current-change="onPageChange"
        />
      </div>
    </template>

    <el-empty v-else description="没有匹配的资料">
      <p class="empty-tip">换一个关键词，或者放宽筛选条件试试。</p>
      <div class="empty-actions">
        <el-button @click="resetAll">清除筛选</el-button>
        <el-button type="primary" @click="goAskAi">试试问 AI</el-button>
      </div>
    </el-empty>
  </div>
</template>

<style scoped>
.page-head {
  padding: 8px 0 16px;
  max-width: 780px;
}

.page-head h1 {
  font-size: 30px;
  margin: 0 0 10px;
}

.page-head strong {
  color: var(--zw-green);
  font-size: 20px;
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
  font-size: 14px;
  padding: 7px 14px;
  border-radius: 999px;
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    background 0.16s ease,
    color 0.16s ease;
}

.type-tab:hover {
  border-color: var(--zw-green-soft);
  color: var(--zw-green-deep);
}

.type-tab.is-active {
  background: var(--zw-green);
  border-color: var(--zw-green);
  color: #fff;
}

.tab-count {
  font-size: 12px;
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

/* T8：所属方向（两个值，窄一点就够） */
.filter-src {
  width: 170px;
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
  font-size: 12px;
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
  font-size: 13px;
  color: var(--zw-muted);
}

.active-chip {
  border: 1px solid var(--zw-line-strong);
  background: #fff;
  color: var(--zw-green-deep);
  font: inherit;
  font-size: 12px;
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
  font-size: 13px;
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
  background: #fff;
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  padding: 20px;
}

.pager {
  display: flex;
  justify-content: center;
  margin-top: 28px;
}

.empty-tip {
  margin: 0 0 14px;
  font-size: 13px;
  color: var(--zw-muted);
}

.empty-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}

/* 窄屏 */
@media (max-width: 760px) {
  .filter-select,
  .filter-src,
  .filter-year,
  .filter-sort,
  .search-input {
    width: 100%;
    margin-left: 0;
  }

  .page-head h1 {
    font-size: 24px;
  }
}
</style>
