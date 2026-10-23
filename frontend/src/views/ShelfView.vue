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
import { getDocs, getFacets, srcTableLabel, type DocListQuery } from '../api/docs'
import type { DocListResponse, FacetItem, FacetsResponse } from '../api/types'
import DocCard from '../components/DocCard.vue'

/**
 * 每页条数。
 *
 * 🔴 2026-10-22：20 → 18。卡片网格是 `auto-fill, minmax(290px, 1fr)`，版心 1160px 下
 * 正好 3 列；20 条 = 6 整行 + 2 张，最后一行右侧会空出一格，看起来像「少了一张卡」。
 * 18 能被 1 / 2 / 3 整除（窄屏 1 列、中屏 2 列、桌面 3 列），任何宽度下每页都能填满整行。
 * ⚠️ 以后改这个数字，先确认它是当前列数的整数倍，否则最后一行又会空出格子。
 */
const PAGE_SIZE = 18

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

/**
 * 「更多筛选」是否展开（装的是机构 / 年份 / 排序这三样）。
 *
 * 【2026-10-18】默认收起。原来七八个控件一次全铺开，390px 下光筛选区就占掉一屏多，
 * 首屏看不见任何一份资料 —— 而资料库页的第一件事应该是让人看见资料。
 *
 * 收起来不等于藏起来：
 *   1. 里面只要有条件生效，按钮上就挂一个数字角标（见 moreActiveCount）；
 *   2. 生效的条件照样出现在下面的「当前筛选」那一行，可以单独点掉。
 * 从地址栏带 year / orgLike / sort 进来的（分享链接）会自动展开，见 applyRouteQuery。
 */
const moreOpen = ref(false)
const page = ref(1)
const loading = ref(false)
const list = ref<DocListResponse | null>(null)
const facets = ref<FacetsResponse>({ types: [], orgs: [], years: [], tags: [], srcTables: [] })

const items = computed(() => list.value?.items ?? [])
const total = computed(() => list.value?.total ?? 0)

/**
 * 列表读取失败时的说明（2026-10-21 · T3 · P1-11）。
 * 之前 fetchList 没有 catch：接口挂了会**保留上一批数据**继续显示，
 * 用户以为看到的还是最新结果；页面也分不清「没数据」与「读不出来」。
 */
const listError = ref('')

/**
 * 【T12】上一次由我们自己写进地址栏的整条 fullPath。
 *
 * watcher 见到它就跳过 applyRouteQuery —— 状态在写地址栏时已经是对的，
 * 再按地址栏重灌一遍只会把没进 URL 的其他筛选（关键词 / 机构 / 主题…）冲掉。
 * 存整条 fullPath 而不是布尔标记：点了**已选中**的方向时 replace 是空操作、路由不会触发变化，
 * 布尔标记会一直挂着，把下一次真正的导航（从首页点主题进来）也一起吞掉。
 */
let selfPushedPath: string | null = null

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
      count: allCount.value
    },
    // 「未分类」方向桶（哨兵值 __uncategorized__）也走这里：srcTableLabel 把它翻成中文「未分类」，
    // 后端没给 label 时也不会露出内部哨兵串
    ...directions.value.map((d) => ({ value: d.value, label: srcTableLabel(d), count: countOf(d.value) }))
  ]
})

/**
 * 方向合计：facets.srcTables 的份数加起来（后端算这一维时排除了自己这一维，
 * 所以这个和 = 「符合其它筛选条件、且有方向」的份数）。
 */
const directionSum = computed(() => (facets.value.srcTables ?? []).reduce((sum, d) => sum + d.count, 0))

/**
 * 「全部」的份数 = 各方向之和（2026-10-21 · task-23 · B1 / B3）。
 *
 * 口径完全交给接口：后端 buildFacets 会把**没有方向**的资料归进「未分类」桶
 * （哨兵值 __uncategorized__），所以各桶之和 = 符合当前其它筛选条件的全部份数
 * = 页头「共 N 份」。前端不再自己拿 total 减出「未分类」——
 * 那套算法和接口口径是两套账，页头和页签的数字会对不上。
 */
const allCount = computed(() => directionSum.value)

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

/**
 * 「更多筛选」折叠区里当前生效的项数（机构关键词 / 年份 / 非默认排序）。
 *
 * 折叠态必须能看出「里面还有东西」，否则用户会以为刚设的条件丢了。
 * 排序不是筛选，但它同样藏在这个折叠区里、改了就不是默认状态，所以一并计入 ——
 * 角标表达的是「这个折叠区里有几项不是默认值」。
 */
const moreActiveCount = computed(() => {
  let n = 0
  if (orgLike.value.trim()) n += 1
  if (selectedYears.value.length > 0) n += 1
  if (sort.value !== 'year_desc') n += 1
  return n
})

/** 有没有任何条件生效（含顶部的方向）。决定页头那句说「共 N 份」还是「当前条件下找到 N 份」。 */
const hasFilter = computed(() => activeChips.value.length > 0 || selectedSrcTables.value.length > 0)

/**
 * 页头大标题跟着方向走。
 * 选着「零废弃」时标题还写「全部资料」是自相矛盾的，会让人以为方向没生效。
 * 方向名一律用后端 label（见 directionTabs），前端不写死中文名。
 */
const pageTitle = computed(() => {
  if (!activeDirection.value) return '全部资料'
  return directionTabs.value.find((d) => d.value === activeDirection.value)?.label ?? '全部资料'
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
  listError.value = ''
  try {
    list.value = await getDocs(buildQuery())
  } catch {
    // 【T3 · P1-11】读不出来就明说读不出来，并**清掉旧列表**：
    // 留着上一批数据继续显示，会让人以为看到的还是最新结果（接口挂了也看不出区别）。
    list.value = null
    listError.value = '资料列表没能加载出来，请检查网络后重试。'
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
  } catch {
    // 【T3 · P1-11】同 fetchList：失败时清空旧数据 + 给出错误态
    list.value = null
    listError.value = '资料列表没能加载出来，请检查网络后重试。'
  } finally {
    loading.value = false
  }
}

function onFilterChange(): void {
  page.value = 1
  // 【T3 · 公-1】筛选变了就把地址栏一起改掉，刷新/分享都还留着这些条件
  syncUrl()
  void refresh()
}

/**
 * 【T3 · 公-1】把当前筛选写进地址栏。
 *
 * 键名必须和 applyRouteQuery 读回时用的**完全一致**：q / type / orgLike / year / tag / srcTable / sort / page。
 * 写之前把整条 fullPath 记进 selfPushedPath —— 不然下面那个 watcher 会按地址栏把状态重新灌一遍，
 * 没进 URL 的条件会被冲掉。
 */
function syncUrl(): void {
  const query: Record<string, string | string[]> = {}
  const q = keyword.value.trim()
  if (q) query.q = q
  if (activeType.value) query.type = activeType.value
  const org = orgLike.value.trim()
  if (org) query.orgLike = org
  if (selectedYears.value.length > 0) query.year = [...selectedYears.value]
  if (selectedTags.value.length > 0) query.tag = [...selectedTags.value]
  if (selectedSrcTables.value.length > 0) query.srcTable = [...selectedSrcTables.value]
  if (sort.value !== 'year_desc') query.sort = sort.value
  if (page.value > 1) query.page = String(page.value)
  const full = router.resolve({ path: '/shelf', query }).fullPath
  if (full === route.fullPath) return
  // replace 而不是 push：点筛选不该在浏览历史里堆一串记录
  selfPushedPath = full
  void router.replace({ path: '/shelf', query })
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
  // 【T3 · 公-1】地址栏交给 syncUrl 统一写（它会带上当前所有筛选条件，不只是方向）
  onFilterChange()
}

function onPageChange(p: number): void {
  page.value = p
  // 【T3 · 公-1】页码也写进地址栏，刷新后停在原来这一页
  syncUrl()
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
  // 地址栏里的筛选由 syncUrl 统一清掉（否则刷新又回来了）
  onFilterChange()
}

/** 零结果时引导去 AI 问答页，并把当前关键词带过去（ChatView 预填进输入框，不自动发送） */
function goAskAi(): void {
  const q = keyword.value.trim()
  void router.push(q ? { path: '/chat', query: { q } } : { path: '/chat' })
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
  // 【T3 · 公-1】页码也读回来（分享链接可能直接指到第 3 页）
  const pageQuery = route.query.page
  const pageRaw = Array.isArray(pageQuery) ? pageQuery[0] : pageQuery
  const pageNum = Number(pageRaw)
  page.value = Number.isFinite(pageNum) && pageNum > 0 ? Math.floor(pageNum) : 1

  // 分享链接里带了收在折叠区里的条件（年份 / 机构 / 排序）时自动展开 ——
  // 否则「地址栏明明有年份，界面上却找不到它在哪设的」。
  // 只在「有」的时候展开，不主动收起：用户自己点开的折叠区不该被路由变化关掉。
  if (orgLike.value.trim() !== '' || selectedYears.value.length > 0 || sort.value !== 'year_desc') {
    moreOpen.value = true
  }

  // 【T3 · 公-1】读回这条路径**不能**走 onFilterChange（它会再写一次地址栏，形成回环）：
  // 这里只负责把状态灌好并刷新一次。
  void refresh()
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
      <h1>{{ pageTitle }}</h1>
      <!-- 这里的数字是**当前筛选命中的份数**（接口返回的 total），不是全库总数 ——
           全库总数只在首页「资料分布」那一块出现，不在本页再说一遍。
           没筛任何条件时它就是全库总数，所以措辞跟着换一下，别写死「共收录」。 -->
      <p class="zw-sub">
        <!-- 【T3 · P1-11】列表读不出来时，份数是「取不到」，不是「0 份」。
             写「共 0 份资料」等于告诉读者这个库是空的，是假话。 -->
        <template v-if="listError">
          暂时取不到份数，<a class="link-plain" href="#" @click.prevent="refresh()">重新加载</a>。
        </template>
        <template v-else-if="hasFilter">
          当前条件下找到 <strong class="zw-num">{{ total }}</strong> 份资料。
        </template>
        <template v-else>
          共 <strong class="zw-num">{{ total }}</strong> 份资料。可按方向浏览，或用下方筛选缩小范围。
        </template>
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

      <!-- 「未分类」方向不用另画一个 chip：后端 facets 会把没有方向的资料归进
           __uncategorized__ 桶（label 已经是中文「未分类」），
           上面这个 v-for 会把它渲染成一个**普通可点页签** ——
           点它就是按 srcTable=__uncategorized__ 去筛，筛出来的正好是没有方向的那些。 -->
    </div>

    <!-- 筛选区：默认只露最常用的三项（关键词 / 主题领域 / 知识类型）。
         机构、年份、排序收进「更多筛选」—— 七八个控件一次全铺开，
         窄屏下光筛选区就占掉一屏，资料本身一份都看不见。
         收起状态不骗人：里面只要有条件生效，按钮上挂数字角标，
         那些条件也照样出现在下面的「当前筛选」行里，可以单独点掉。 -->
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索资料名称、机构……"
        clearable
        class="search-input"
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

      <button
        type="button"
        class="more-toggle"
        :class="{ 'is-open': moreOpen }"
        :aria-expanded="moreOpen"
        aria-controls="shelf-more-filters"
        @click="moreOpen = !moreOpen"
      >
        {{ moreOpen ? '收起筛选' : '更多筛选' }}
        <span v-if="moreActiveCount > 0" class="more-count zw-num">{{ moreActiveCount }}</span>
        <span class="more-caret" aria-hidden="true">▾</span>
      </button>
    </div>

    <!-- 更多筛选：机构 / 年份 / 排序 -->
    <div v-show="moreOpen" id="shelf-more-filters" class="toolbar toolbar--more">
      <el-input
        v-model="orgLike"
        placeholder="发布机构（输完按回车筛选）"
        clearable
        class="filter-org"
        @keyup.enter="onFilterChange"
        @clear="onFilterChange"
      />

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
      <div v-for="n in 9" :key="n" class="skeleton-card">
        <el-skeleton :rows="3" animated />
      </div>
    </div>

    <!-- 【T3 · P1-11】列表读不出来：说清是「读不到」而不是「没数据」，并给重试。
         之前 fetchList 没有 catch，接口挂了会留着上一批数据继续显示，
         用户以为看到的是最新结果，分不清「没数据」和「读不出来」。 -->
    <div v-else-if="listError" class="list-error">
      <el-result icon="error" title="资料没能加载出来" :sub-title="listError">
        <template #extra>
          <el-button type="primary" @click="refresh">重新加载</el-button>
          <el-button @click="resetAll">清除筛选条件</el-button>
        </template>
      </el-result>
    </div>

    <template v-else-if="items.length > 0">
      <div class="cards">
        <DocCard v-for="doc in items" :key="doc.id" :doc="doc" />
      </div>

      <div class="pager">
        <el-pagination
          background
          layout="total, prev, pager, next, jumper"
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
  color: #fff;
  background: rgba(255, 255, 255, 0.3); /* QA-SHF-06：4.4:1→活动态提白提对比 */
}

/* 键盘可达（QA-ALL-01）：本页自绘控件统一焦点态 */
.type-tab:focus-visible,
.more-toggle:focus-visible,
.active-chip:focus-visible,
.clear-all:focus-visible,
.link-plain:focus-visible {
  outline: 2px solid var(--zw-green);
  outline-offset: 2px;
}

/* 列表读不出来时的错误块 */
.list-error {
  padding: 28px 0;
}

/* 页头里的「重新加载」内联链接（T3 · P1-11：读不出来时页头不给假数字） */
.link-plain {
  color: var(--zw-green-deep);
  text-decoration: underline;
  cursor: pointer;
}

/* 工具栏：默认一行（关键词 / 主题 / 类型 / 更多筛选），窄屏自动换行。
   2026-10-18：原来两行八项一次全铺开，首屏看不见资料。
   机构、年份、排序收进了「更多筛选」面板（.toolbar--more），其余位置与行为不动。 */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px; /* QA-SHF-02/03：10→12，统一 8px 栅格 */
  margin-bottom: 16px; /* 14→16 */
}

/* 「更多筛选」面板：与上面那行同一套 flex 布局，只是往上贴紧一点 */
.toolbar--more {
  margin-top: -4px;
}

/* T10：机构文本式检索，机构名普遍较长，给宽一点。
   QA-SHF-02：全部对齐 8px 栅格（原 300/230/190/150/140/260 六种杂值）。 */
.filter-org {
  width: 288px;
}

.filter-tag {
  width: 232px;
}

/* T12：类型下拉跟着上方选中的方向变（选项本身只由后端 facets 决定） */
.filter-type {
  width: 192px;
}

.filter-year {
  width: 152px;
}

.filter-sort {
  width: 152px;
}

/* 关键词现在是常显三项里的第一项、靠左；
   把 margin-left:auto 让给右边的「更多筛选」按钮，让它靠右收边。 */
.search-input {
  width: 256px;
}

/* 「更多筛选」开关 */
.more-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  border: 1px solid var(--zw-line-strong);
  background: var(--zw-surface);
  color: var(--zw-text);
  font: inherit;
  font-size: 14px;
  padding: 8px 14px;
  border-radius: var(--zw-radius-sm);
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    background 0.16s ease,
    color 0.16s ease;
}

.more-toggle:hover {
  border-color: var(--zw-green-soft);
  color: var(--zw-green-deep);
}

.more-toggle.is-open {
  background: var(--zw-mint-2);
  border-color: var(--zw-green-soft);
  color: var(--zw-green-deep);
}

/* 折叠区里有几项不是默认值。收起来时这是唯一看得见的提示，别省。 */
.more-count {
  font-size: 12px;
  color: var(--zw-green-deep);
  background: var(--zw-mint);
  border-radius: 999px;
  padding: 1px 7px;
}

.more-caret {
  font-size: 11px;
  line-height: 1;
  transition: transform 0.16s ease;
}

.more-toggle.is-open .more-caret {
  transform: rotate(180deg);
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

/* QA-SHF-04：骨架数量与列数同步 —— 桌面 minmax(290px) 在 1160 版心是 3 列=9 格，
   原固定 8 张，加载完成网格会跳动。9 张对齐桌面网格；手机 640 以下列变 1，
   8/9 张在窄屏下多几张影响不大，保持单值不 branch。 */
.pager {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 24px; /* QA-SHF-03：28→24，4/8 刻度 */
}

/* 窄屏（2026-10-18 修）：分页条 + 「Total 603」在 390px 下必然超宽 ——
   Element Plus 的分页不折行，实测把整页撑到 429px、右侧出现真的横向滚动条
   （手机上图库标题被切掉一截）。份数在页头与筛选区已经说过一遍，
   这里把那截文字让出来，只留翻页按钮；再兜一层换行，窄到 320px 也不撑破。 */
@media (max-width: 640px) {
  .pager :deep(.el-pagination__total) {
    display: none;
  }

  .pager :deep(.el-pagination) {
    flex-wrap: wrap;
    justify-content: center;
    row-gap: 6px;
  }
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

/* 窄屏：全部撑满一行（靠 .toolbar 的 flex-wrap 换行，这里只管宽度） */
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

  /* 窄屏下「更多筛选」也撑满一行，好点 */
  .more-toggle {
    width: 100%;
    justify-content: center;
    margin-left: 0;
  }

  .page-head h1 {
    font-size: 24px;
  }
}
</style>
