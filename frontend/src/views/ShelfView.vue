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
 * T10 改动（2026-10-14）：
 *   9. 「机构」从下拉多选改成**文本式输入框**：输完按回车才筛（不是边输边筛），
 *      语义 =「发布机构名称里含这个关键词」的所有资料都列出来（可能命中多家机构）。
 *      为什么改：老库 371 个机构值里 296 个只出现一次，下拉只有 42 项，
 *      想找「太平洋」这类**出现在长联合发文串里**的机构，下拉根本点不到。
 *      🔴 原来的远程搜索（`?orgSearch=`）与 orgOptions/orgKeyword 等逻辑**已整体删干净**，
 *         `api/docs.ts` 的 `searchOrgs` 也一并删了（全局确认无人引用）。
 *   10. 筛选区改成**两行**：第一行（常用）机构输入框 + 主题 + 类型；
 *       第二行（辅助）所属方向 + 年份 + 排序 + 关键词。窄屏自动换行，不出横向滚动条。
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
/**
 * 【T10】机构文本式检索：输入的关键词，**按回车才生效**（不是边输边筛）。
 * 空串 = 不按机构过滤。语义 = 机构名里含这个词（后端 `?orgLike=`）。
 */
const orgLike = ref('')
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
  dim: 'type' | 'orgLike' | 'year' | 'tag' | 'srcTable' | 'q'
  label: string
  value: string
}

function srcTableLabelOf(value: string): string {
  return srcTableOptions.value.find((t) => t.value === value)?.label ?? value
}

/** 已选条件回显（给用户一个「我现在筛了什么」的确认） */
const activeChips = computed<ActiveChip[]>(() => {
  const chips: ActiveChip[] = []
  // T10：机构是文本式检索，chip 说清这是「含某词」而不是「等于某机构」
  const org = orgLike.value.trim()
  if (org) chips.push({ dim: 'orgLike', label: '机构含', value: org })
  for (const v of selectedYears.value) chips.push({ dim: 'year', label: '年份', value: `${v} 年` })
  for (const v of selectedTags.value) chips.push({ dim: 'tag', label: '主题', value: v })
  for (const v of selectedSrcTables.value) chips.push({ dim: 'srcTable', label: '方向', value: v })
  if (activeType.value) chips.push({ dim: 'type', label: '类型', value: activeType.value })
  const q = keyword.value.trim()
  if (q) chips.push({ dim: 'q', label: '关键词', value: q })
  return chips
})

/** 已选条件的显示名（方向走 label，其余原样） */
function chipText(chip: ActiveChip): string {
  if (chip.dim === 'srcTable') return srcTableLabelOf(chip.value)
  return chip.value
}

/** 按「维度 + 值」删条件：用索引删会在多选里错位（下拉顺序与 chip 顺序不一定一致） */
function removeChip(chip: ActiveChip): void {
  if (chip.dim === 'orgLike') orgLike.value = ''
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
    orgLike: orgLike.value.trim() || undefined,
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
  orgLike.value = ''
  selectedYears.value = []
  selectedTags.value = []
  selectedSrcTables.value = []
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
  const { q, tag, type, orgLike: orgLikeQuery, year, srcTable, sort: sortQuery } = route.query

  keyword.value = typeof q === 'string' ? q : ''
  activeType.value = typeof type === 'string' ? type : ''

  const toList = (value: unknown): string[] =>
    typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

  selectedTags.value = toList(tag)
  // T10：机构文本式检索也能从地址栏带进来（`/shelf?orgLike=太平洋`）
  orgLike.value = typeof orgLikeQuery === 'string' ? orgLikeQuery : ''
  selectedYears.value = toList(year)
  // T8：所属方向也能从地址栏带进来（`/shelf?srcTable=知识查询（零废弃）`）
  selectedSrcTables.value = toList(srcTable)
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
        或按机构、年份、主题、方向组合筛选；除机构外的每一项下拉都标出了可命中的数量，
        机构可以输入关键字（输完按回车），会列出<b>机构名里含这个词</b>的所有资料。
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

    <!-- 筛选区：两行（第一行常用、第二行辅助），窄屏自动换行 -->
    <div class="toolbar">
      <!-- 第一行（常用） -->
      <el-input
        v-model="orgLike"
        placeholder="发布机构（输完按回车筛选）"
        clearable
        class="filter-org"
        @keyup.enter="onFilterChange"
        @clear="onFilterChange"
      />

      <el-select
        v-model="selectedTags"
        multiple
        filterable
        collapse-tags
        collapse-tags-tooltip
        clearable
        placeholder="主题领域"
        class="filter-tag"
        @change="onFilterChange"
      >
        <el-option v-for="f in facets.tags" :key="f.value" :label="f.value" :value="f.value">
          <span class="opt-value">{{ f.value }}</span>
          <span class="opt-count">{{ f.count }}</span>
        </el-option>
      </el-select>

      <el-select
        v-model="activeType"
        placeholder="知识类型"
        clearable
        class="filter-type"
        @change="onFilterChange"
      >
        <el-option v-for="f in facets.types" :key="f.value" :label="f.value" :value="f.value">
          <span class="opt-value">{{ f.value }}</span>
          <span class="opt-count">{{ f.count }}</span>
        </el-option>
      </el-select>

      <span class="filter-break" aria-hidden="true"></span>

      <!-- 第二行（辅助） -->
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
        class="filter-src"
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
        class="filter-year"
        @change="onFilterChange"
      >
        <el-option v-for="f in facets.years" :key="f.value" :label="`${f.value} 年 (${f.count})`" :value="f.value" />
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

/* 工具栏：两行 —— 第一行（机构 / 主题 / 类型）＋第二行（方向 / 年份 / 排序 / 关键词）。
   用 grid 的显式两行 + flex 回退，窄屏（≤1100px）起自动收成单列，不出横向滚动条。 */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}

/* T10：机构文本式检索。第一项给宽一点（机构名普遍较长），且这一行不加 margin-left:auto，
   否则第一行会被顶到右边、看起来和第二行没对齐。 */
.filter-org {
  width: 300px;
}

/* 行分隔：flex 的一个零宽换行点 —— 保证第一行 / 第二行严格分开，
   且窄屏时它自然消失，下面所有项继续靠 flex-wrap 自然换行。 */
.filter-break {
  width: 100%;
  height: 0;
  flex: 0 0 100%;
}

.filter-tag {
  width: 230px;
}

.filter-type {
  width: 190px;
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

/* 窄屏：全部撑满一行（filter-wrap 负责换行，这里只管宽度） */
@media (max-width: 760px) {
  .filter-org,
  .filter-tag,
  .filter-type,
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
