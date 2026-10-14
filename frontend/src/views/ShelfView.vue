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
 * T12 改动（2026-10-14）：
 *   11. 顶部标签行由「9 个类型标签」改成**3 个方向标签**（全部 / 零废弃 / 化学品与健康），
 *       类型下沉到工具栏的下拉。方向名**一律用后端给的 label**，前端不写死中文名；
 *       数据源没有方向（老快照）时整行不渲染。
 *   12. 工具栏里那个重复的「所属方向」下拉删掉了（已提升为顶部标签），
 *       「当前筛选」里也不再单列方向 chip（顶部高亮已表达同一件事）；全部清除照旧清方向。
 *   13. 跨方向切换时自动清掉失效的类型（在零废弃里选的「案例工具」到化学品下不存在，
 *       留着就是空结果）。因为 facets 是异步的，校验放在**新方向的 facets 回来之后**。
 *   14. 🔴 后端零改动：「类型跟着方向联动」是白拿的 —— `buildFacets()` 取 types 时
 *       已经带上了当前的 srcTable 筛选，选完方向 facets.types 自动只剩该方向的类型。
 *   15. 方向切换会同步地址栏（分享链接带得上），走 router.replace。
 *
 * 数据走 src/api/docs.ts → 后端 GET /api/docs、/api/docs/facets
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getDocs, getFacets, type DocListQuery } from '../api/docs'
import type { DocListResponse, FacetItem, FacetsResponse } from '../api/types'
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
 * 【T12】方向清单：**固定用「不带任何筛选」的那一份**，只进一次（见 onMounted）。
 *
 * 为什么不能直接拿 facets.srcTables 当清单：后端算某一维的筛选项时是
 * 「排除自己这一维、应用其余维度」，所以 facets.srcTables 会**跟着别的筛选一起收窄** ——
 * 实测：选了「零废弃 + 类型案例工具」后它只剩 `零废弃:50`（化学品那条连同数字一起消失，
 * 用户就没法横向切方向了）；关键词搜不到东西时它是空数组，整排标签会直接消失，
 * 只能靠「全部清除」才能回来。标签是导航控件，不能被筛没了。
 *
 * 数字仍然取当前这次 facets（含义是「点这个方向会得到多少份」）：
 * 当前筛选下没有命中的方向显示 0，切过去时 T12-C 会把失效的类型清掉，数字随即变过来。
 */
const directions = ref<FacetItem[]>([])

/**
 * 【T12】顶部方向标签：全部 / 零废弃 / 化学品与健康。
 *
 * 为什么不再是类型：类型有 8 个，一行铺开又长又挤；其中 5 个只属于化学品方向，
 * 平铺出来等于把「方向」这层结构抹平了。方向提上来做平级标签，类型下沉到工具栏。
 *
 * 两条硬要求：
 *   1. 显示名**一律用后端给的 label**（`directions[].label`），前端不写死中文名 ——
 *      方向改名只改后端 `srcTableLabel()` 一处。
 *   2. 数据源没有方向时（清单是空数组，如老快照）返回空数组 → **整行不渲染**，
 *      而不是摆一个点了筛不出东西的「全部」。
 */
const directionTabs = computed<{ value: string; label: string; count: number }[]>(() => {
  if (directions.value.length === 0) return []
  const live = facets.value.srcTables ?? []
  const countOf = (value: string): number => live.find((d) => d.value === value)?.count ?? 0
  return [
    {
      value: '',
      label: '全部',
      count: live.reduce((sum, d) => sum + d.count, 0)
    },
    ...directions.value.map((d) => ({ value: d.value, label: d.label ?? d.value, count: countOf(d.value) }))
  ]
})

/**
 * 当前方向（顶部标签是**单选**语义）。
 * 地址栏上 `srcTable` 允许多值（T8 起就能带多个，参数可重复），那种老链接取第一个高亮。
 */
const activeDirection = computed(() => selectedSrcTables.value[0] ?? '')

interface ActiveChip {
  /** 所属筛选维度，决定删掉它时该清哪个状态 */
  dim: 'type' | 'orgLike' | 'year' | 'tag' | 'q'
  label: string
  value: string
}

/** 已选条件回显（给用户一个「我现在筛了什么」的确认） */
const activeChips = computed<ActiveChip[]>(() => {
  const chips: ActiveChip[] = []
  // T10：机构是文本式检索，chip 说清这是「含某词」而不是「等于某机构」
  const org = orgLike.value.trim()
  if (org) chips.push({ dim: 'orgLike', label: '机构含', value: org })
  for (const v of selectedYears.value) chips.push({ dim: 'year', label: '年份', value: `${v} 年` })
  for (const v of selectedTags.value) chips.push({ dim: 'tag', label: '主题', value: v })
  // T12：方向不再单独出 chip —— 顶部标签的高亮已经表达了同一件事，
  // 再列一条会让人以为筛了两次。全部清除（resetAll）照旧清方向。
  if (activeType.value) chips.push({ dim: 'type', label: '类型', value: activeType.value })
  const q = keyword.value.trim()
  if (q) chips.push({ dim: 'q', label: '关键词', value: q })
  return chips
})

/** 按「维度 + 值」删条件：用索引删会在多选里错位（下拉顺序与 chip 顺序不一定一致） */
function removeChip(chip: ActiveChip): void {
  if (chip.dim === 'orgLike') orgLike.value = ''
  else if (chip.dim === 'year') selectedYears.value = selectedYears.value.filter((v) => `${v} 年` !== chip.value)
  else if (chip.dim === 'tag') selectedTags.value = selectedTags.value.filter((v) => v !== chip.value)
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

/** 只刷列表（翻页时筛选项没变，不必再取一次 facets） */
async function fetchList(): Promise<void> {
  loading.value = true
  try {
    list.value = await getDocs(buildQuery())
  } finally {
    loading.value = false
  }
}

/**
 * 取筛选项，并顺手清掉在新方向下已不存在的类型。
 *
 * 【T12】切换方向后，原来选中的类型可能在新方向下压根不存在
 * （「案例工具」只在零废弃方向里，到化学品方向会被筛成空结果，用户并不知道发生了什么）。
 * 所以要等**新方向**的 facets 回来之后再校验并静默清掉 —— 拿切换前那份类型列表判断是没用的。
 *
 * ⚠️ `types` 为空**不能**当成「这个类型不存在」：那说明当前条件组合一份都没命中，
 *    此时清类型等于把用户刚选的条件悄悄吃掉。
 */
async function refreshFacets(): Promise<void> {
  facets.value = await getFacets(buildQuery())
  const typeLost =
    activeType.value !== '' &&
    facets.value.types.length > 0 &&
    !facets.value.types.some((t) => t.value === activeType.value)
  if (typeLost) {
    activeType.value = ''
    // 类型变了，主题 / 年份 / 机构的可选数量要按新类型重算一次
    facets.value = await getFacets(buildQuery())
  }
}

/** 筛选变更后刷新：**先取筛选项、再取列表**，顺序不能反（要先清失效类型再定最终条件）。 */
async function refresh(): Promise<void> {
  loading.value = true
  try {
    try {
      await refreshFacets()
    } catch {
      // 筛选项取不到不该把列表一起拖下水（错误提示已由 http 拦截器统一弹），下面照样刷列表
    }
    list.value = await getDocs(buildQuery())
  } finally {
    loading.value = false
  }
}

function onFilterChange(): void {
  page.value = 1
  void refresh()
}

/**
 * 【T12】方向切换后把方向同步进地址栏（分享链接要带得上）。
 *
 * ⚠️ 这个 replace 触发的 route 变化必须被下面的 watcher 认出来并跳过（见 selfPushedPath）：
 *   否则 applyRouteQuery 会按「地址栏里有什么」重新灌一遍状态，把没进 URL 的筛选
 *   （关键词 / 机构 / 主题…）统统清空 —— 用户刚搜完点个方向，搜索就没了。
 */
function onDirectionClick(value: string): void {
  selectedSrcTables.value = value ? [value] : []
  const query = { ...route.query }
  if (value) query.srcTable = value
  else delete query.srcTable
  // replace 而不是 push：点筛选不该在浏览历史里堆一串记录
  selfPushedPath = router.resolve({ path: '/shelf', query }).fullPath
  void router.replace({ path: '/shelf', query })
  onFilterChange()
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

onMounted(() => {
  applyRouteQuery()
  // 方向清单只取这一次（不带任何筛选），见 directions 的注释
  void getFacets({}).then((f) => {
    directions.value = f.srcTables ?? []
  })
})

/**
 * 【T12】上一次由我们自己写进地址栏的方向（整条 fullPath）。
 *
 * watcher 见到它就跳过 applyRouteQuery —— 状态在 onDirectionClick 里已经是对的，
 * 再按地址栏重灌一遍只会把没进 URL 的其他筛选（关键词 / 机构 / 主题…）冲掉。
 * 存整条 fullPath 而不是布尔标记：点了**已选中**的方向时 replace 是空操作、路由不会触发变化，
 * 布尔标记会一直挂着，把下一次真正的导航（从首页点主题进来）也一起吞掉。
 */
let selfPushedPath: string | null = null

// 已在资料库页时，从首页再次点击主题/类型入口会带新的 query 过来，必须跟着变
watch(
  () => route.fullPath,
  (fullPath) => {
    if (route.path !== '/shelf') {
      selfPushedPath = null
      return
    }
    if (selfPushedPath !== null && fullPath === selfPushedPath) {
      selfPushedPath = null
      return
    }
    selfPushedPath = null
    applyRouteQuery()
  }
)
</script>

<template>
  <div class="shelf">
    <header class="page-head">
      <p class="zw-eyebrow">资料库</p>
      <h1>全部资料</h1>
      <p class="zw-sub">
        共收录 <strong class="zw-num">{{ total }}</strong> 份资料，可按方向浏览，
        或按机构、年份、主题、类型组合筛选；除机构外的每一项下拉都标出了可命中的数量，
        机构可以输入关键字（输完按回车），会列出<b>机构名里含这个词</b>的所有资料。
      </p>
    </header>

    <!-- 【T12】方向标签（全部 / 零废弃 / 化学品与健康）。
         「类型」从这排标签上下沉到了工具栏的下拉，并跟着这里选的方向联动。
         数据源没有方向时整行不渲染，别摆一个点了筛不出东西的「全部」。 -->
    <div v-if="directionTabs.length > 0" class="type-row" role="tablist" aria-label="资料方向">
      <button
        v-for="d in directionTabs"
        :key="d.value || 'all'"
        type="button"
        role="tab"
        class="type-tab"
        :class="{ 'is-active': activeDirection === d.value }"
        :aria-selected="activeDirection === d.value"
        @click="onDirectionClick(d.value)"
      >
        {{ d.label }}
        <span class="tab-count zw-num">{{ d.count }}</span>
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
        <!-- 【T12】类型下拉**保持原样**：选项来自 facets.types，而后端取这一维的筛选项时
             已经带上了当前的方向筛选，选完方向这里自动只剩该方向的类型（后端零改动）。 -->
        <el-option v-for="f in facets.types" :key="f.value" :label="f.value" :value="f.value">
          <span class="opt-value">{{ f.value }}</span>
          <span class="opt-count">{{ f.count }}</span>
        </el-option>
      </el-select>

      <span class="filter-break" aria-hidden="true"></span>

      <!-- 第二行（辅助） -->
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

/* 【T12】方向标签（class 名沿用原来的 type-row / type-tab，样式没动，只换了渲染的数据源） */
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

/* 工具栏：两行 —— 第一行（机构 / 主题 / 类型）＋第二行（年份 / 排序 / 关键词）。
   T12 起「所属方向」下拉已删（提升为顶部标签），第二行少了一项，其余位置与行为不动。
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

/* T12：类型下拉跟着上方选中的方向变（选项本身只由后端 facets 决定） */
.filter-type {
  width: 190px;
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
