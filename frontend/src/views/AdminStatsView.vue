<script setup lang="ts">
/**
 * 数据看板 —— 2026-10-19 重设计（用户要求：按专业数据分析师视角重排版面与分析内容）
 *
 * 设计原则（每一块都先回答「分析什么 / 给谁看 / 能得出什么」，再决定图形）：
 *   1. 核心指标（含环比）—— 看总量与走势方向；给负责人。结论：站有没有在用、在涨还是在掉。
 *   2. 使用趋势 —— 看波动与节奏；给运营。结论：哪几天是高峰、有没有突然的掉落。
 *   3. 使用时段 —— 看一天内/一周内的分布；给运营。结论：什么时候有人来（决定维护与发布时机）。
 *   4. 转化漏斗 —— 看从「逛」到「拿走资料」每一步的流失；给内容与产品。结论：卡在哪一步。
 *   5. 检索质量 —— 看用户搜什么、什么搜不到；给内容。结论：下一批该补哪些资料。
 *   6. 内容热度 —— 看哪些资料真的被下载；给内容。结论：哪些资料值得置顶、哪些该替换。
 *   7. AI 问答质量 —— 看引擎答不上来的比例；给技术与内容。结论：是资料没覆盖，还是检索没召回。
 *   8. 账号活跃度 / 使用明细 —— 看「谁在用、具体干了什么」；给运营。结论：识别真用户、回访与答疑。
 *
 * 数据源有三处，口径都不动、相加不相减（这是本次唯一没改的东西）：
 *   · `GET /api/track/stats`（韶茹那块既有统计，一个字没改：事件分布 / 热词 / 下载排行 / 问答质量 / 近 14 天）
 *   · `GET /api/admin/analytics`（本次新增的聚合：区间、环比、24 小时与星期分布、漏斗、账号排行）
 *   · `GET /api/admin/usage-detail`（T11 既有：按日、按账号的三项次数）
 *   · `GET /api/admin/user-activity`（本次新增：点开账号看逐条记录，见 ActivityDrawer.vue）
 *
 * ⚠️ 缺失数据不编：没有的字段就在页面上写明「暂缺什么」，不拿假数字凑图形。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { exportCsv } from '../api/admin'
import { fetchStats, type StatsSummary, type TrackEventName } from '../api/track'
import { getOverview } from '../api/overview'
import type { DocOverview } from '../api/types'
import {
  fetchAnalytics,
  GUEST_ACTIVITY_ID,
  type AnalyticsDailyPoint,
  type AnalyticsGuestTotals,
  type AnalyticsPayload,
  type AnalyticsUserRow
} from '../api/analytics'
import ActivityDrawer from '../components/admin/ActivityDrawer.vue'

const AUTO_REFRESH_MS = 30_000

const stats = ref<StatsSummary | null>(null)
const analytics = ref<AnalyticsPayload | null>(null)
/** 资料库概览（GET /api/overview）：只用来解释「份数」的口径，不参与任何统计口径 */
const overview = ref<DocOverview | null>(null)
const errorText = ref('')
const analyticsError = ref('')
const autoRefresh = ref(false)
const exporting = ref(false)
const loading = ref(false)
/** 「这些数字怎么算的」：平时收起，点标题旁的圆圈「!」才打开（2026-10-22 用户要求） */
const glossaryOpen = ref(false)

/** 看板区间（天数）。想算「本期 vs 上期」就取两倍天数，前端切前后两段。 */
const RANGES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' }
]
const rangeDays = ref(30)

async function doExport(): Promise<void> {
  exporting.value = true
  try {
    await exportCsv('stats')
    ElMessage.success('报表已开始下载')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导出失败')
  } finally {
    exporting.value = false
  }
}

/* ------------------------------------------------------------ 1. 核心指标 */

function sum(points: AnalyticsDailyPoint[], key: keyof AnalyticsDailyPoint): number {
  return points.reduce((acc, p) => acc + Number(p[key] ?? 0), 0)
}

/** 把 2N 天的 daily 切成「本期（后 N 天）」与「上期（前 N 天）」 */
const split = computed(() => {
  const daily = analytics.value?.daily ?? []
  const n = rangeDays.value
  if (daily.length <= n) return { current: daily, previous: [] as AnalyticsDailyPoint[] }
  return { previous: daily.slice(0, daily.length - n), current: daily.slice(daily.length - n) }
})

const currentTotals = computed(() => {
  const t = analytics.value?.totals
  const cur = split.value.current
  return {
    events: cur.length ? sum(cur, 'events') : (t?.events ?? 0),
    pv: cur.length ? sum(cur, 'pv') : (t?.pv ?? 0),
    uv: cur.length ? sum(cur, 'uv') : (t?.uv ?? 0),
    searches: cur.length ? sum(cur, 'searches') : (t?.searches ?? 0),
    previews: cur.length ? sum(cur, 'previews') : (t?.previews ?? 0),
    downloads: cur.length ? sum(cur, 'downloads') : (t?.downloads ?? 0),
    asks: cur.length ? sum(cur, 'asks') : (t?.asks ?? 0)
  }
})

const prevTotals = computed(() => {
  const prev = split.value.previous
  return {
    events: sum(prev, 'events'),
    pv: sum(prev, 'pv'),
    uv: sum(prev, 'uv'),
    searches: sum(prev, 'searches'),
    previews: sum(prev, 'previews'),
    downloads: sum(prev, 'downloads'),
    asks: sum(prev, 'asks')
  }
})

/** 环比：上期为 0 时不给百分比（避免「+∞%」这种假数字），直接说明「上期无数据」 */
function delta(cur: number, prev: number): { text: string; tone: 'up' | 'down' | 'flat' | 'none' } {
  if (prev === 0) return { text: cur === 0 ? '上期无数据' : '上期无数据', tone: 'none' }
  const pct = ((cur - prev) / prev) * 100
  const tone: 'up' | 'down' | 'flat' = pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat'
  const sign = pct > 0 ? '+' : ''
  return { text: `较上期 ${sign}${pct.toFixed(0)}%`, tone }
}

interface Kpi {
  label: string
  value: string
  hint: string
  delta: { text: string; tone: string }
}

const kpis = computed<Kpi[]>(() => {
  const c = currentTotals.value
  const p = prevTotals.value
  const perVisitor = c.uv > 0 ? (c.pv / c.uv).toFixed(1) : '—'
  const noAnswerRate = analytics.value ? Math.round(analytics.value.asks.noAnswerRate * 100) : 0
  return [
    { label: '页面访问 PV', value: String(c.pv), hint: '打开页面的次数', delta: delta(c.pv, p.pv) },
    { label: '独立访客 UV', value: String(c.uv), hint: '按账号/会话去重的人次', delta: delta(c.uv, p.uv) },
    { label: '人均浏览', value: `${perVisitor} 页`, hint: 'PV ÷ UV，看内容有没有留住人', delta: { text: '', tone: 'none' } },
    { label: '站内检索', value: String(c.searches), hint: '搜索框提交次数', delta: delta(c.searches, p.searches) },
    { label: '在线预览', value: String(c.previews), hint: '服务端记的预览次数', delta: delta(c.previews, p.previews) },
    { label: '下载原件', value: String(c.downloads), hint: '服务端记的下载次数', delta: delta(c.downloads, p.downloads) },
    { label: 'AI 提问', value: String(c.asks), hint: '问答次数', delta: delta(c.asks, p.asks) },
    { label: '无答案率', value: `${noAnswerRate}%`, hint: '答不上来 ÷ 可判定条数', delta: { text: '', tone: 'none' } }
  ]
})

/* ------------------------------------------------------------ 2. 使用趋势 */

const METRICS = [
  { key: 'events', label: '全部事件' },
  { key: 'pv', label: '页面访问' },
  { key: 'uv', label: '独立访客' },
  { key: 'searches', label: '检索' },
  { key: 'previews', label: '预览' },
  { key: 'downloads', label: '下载' },
  { key: 'asks', label: 'AI 提问' }
] as const
type MetricKey = (typeof METRICS)[number]['key']

const metric = ref<MetricKey>('events')

const trend = computed(() => {
  const points = split.value.current
  const values = points.map((p) => Number(p[metric.value] ?? 0))
  const max = Math.max(1, ...values)
  const n = Math.max(1, values.length - 1)
  const coords = values.map((v, i) => ({ x: (i / n) * 100, y: 100 - (v / max) * 100, v }))
  return { points, values, max, coords, line: coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ') }
})

const trendPeak = computed(() => {
  const t = trend.value
  if (!t.points.length) return null
  const max = Math.max(...t.values)
  const idx = t.values.indexOf(max)
  return { date: t.points[idx]?.date ?? '', value: max }
})

/* ------------------------------------------------------------ 3. 使用时段 */

const hourMax = computed(() => Math.max(1, ...(analytics.value?.hourly ?? []).map((h) => h.events)))
const weekdayMax = computed(() => Math.max(1, ...(analytics.value?.weekday ?? []).map((w) => w.events)))
const weekdayTop = computed(() => {
  const list = analytics.value?.weekday ?? []
  if (!list.length) return null
  return [...list].sort((a, b) => b.events - a.events)[0] ?? null
})
const hourTop = computed(() => {
  const list = analytics.value?.hourly ?? []
  if (!list.length) return null
  return [...list].sort((a, b) => b.events - a.events)[0] ?? null
})

/* ------------------------------------------------------------ 4. 转化漏斗 */

interface FunnelRow {
  label: string
  value: number
  ofPv: number
  hint: string
}

const funnelRows = computed<FunnelRow[]>(() => {
  const f = analytics.value?.funnel
  if (!f) return []
  const rows: { label: string; value: number; hint: string }[] = [
    { label: '打开页面（PV）', value: f.pv, hint: '漏斗的底' },
    { label: '用搜索找资料', value: f.searches, hint: '主动检索 = 有明确需求' },
    { label: '在线预览', value: f.previews, hint: '先看一眼再决定要不要' },
    { label: '下载原件', value: f.downloads, hint: '真正把资料带走' },
    { label: '问 AI', value: f.asks, hint: '检索不出来时的兜底路径' }
  ]
  const base = f.pv > 0 ? f.pv : 1
  return rows.map((row) => ({
    ...row,
    ofPv: (row.value / base) * 100
  }))
})

const funnelWorst = computed(() => {
  const rows = funnelRows.value
  if (!rows.length) return null
  return [...rows].sort((a, b) => a.ofPv - b.ofPv)[0] ?? null
})

/* ------------------------------------------------------------ 6/7. 内容与问答 */

const downloadGap = computed(() => {
  const d = analytics.value?.downloads
  if (!d) return null
  return d.server - d.events
})

const noAnswerPercent = computed(() => Math.round((analytics.value?.asks.noAnswerRate ?? 0) * 100))
const zeroRatePercent = computed(() => Math.round((analytics.value?.search.zeroRate ?? 0) * 100))

/* 既有「事件分布」块（保留：它是全站事件类型的总账） */
const EVENT_LABELS: Record<TrackEventName, string> = {
  page_view: '页面访问',
  search: '搜索',
  preview: '在线预览',
  download: '下载',
  ai_ask: 'AI 提问',
  register: '注册',
  feedback_submit: '反馈提交'
}

const eventRows = computed(() => {
  const counts = stats.value?.events
  if (!counts) return []
  return (Object.keys(EVENT_LABELS) as TrackEventName[]).map((name) => ({
    name,
    label: EVENT_LABELS[name],
    count: counts[name] ?? 0
  }))
})
const eventMax = computed(() => Math.max(1, ...eventRows.value.map((row) => row.count)))

function barWidth(value: number, max: number): string {
  if (max <= 0) return '0%'
  return `${Math.max(2, Math.round((value / max) * 100))}%`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function shortDate(value: string): string {
  return value.slice(5)
}

/* ------------------------------------------------------------ 加载 */

async function load(): Promise<void> {
  loading.value = true
  errorText.value = ''
  analyticsError.value = ''
  const [s, a, o] = await Promise.allSettled([
    fetchStats(),
    fetchAnalytics(rangeDays.value * 2),
    getOverview()
  ])
  if (s.status === 'fulfilled') stats.value = s.value
  else errorText.value = s.reason instanceof Error ? s.reason.message : '读取统计失败'
  if (a.status === 'fulfilled') analytics.value = a.value
  else analyticsError.value = a.reason instanceof Error ? a.reason.message : '读取分析数据失败'
  // 概览是「锦上添花」的口径说明，失败就安静地不显示这一段（getOverview 自己会返回 null）
  overview.value = o.status === 'fulfilled' ? o.value : null
  loading.value = false
}

function pickRange(days: number): void {
  if (rangeDays.value === days) return
  rangeDays.value = days
  void load()
}

/* ------------------------------------------------------------ 7. 账号使用明细 */

/**
 * 「账号使用明细」—— 2026-10-21 新增（用户反馈：看板里看不到「谁在用」）
 *
 * 数据全都来自分析接口的 `users`（区间内按账号聚合，已按事件数排序）与 `guest`
 * （未登录访客合计）。不新开接口、不重复统计，点一行就复用「注册用户」页那张
 * 逐条记录抽屉（components/admin/ActivityDrawer.vue）。
 */
const USER_TOP = 50
const userKeyword = ref('')

const userRows = computed<AnalyticsUserRow[]>(() => {
  const rows = analytics.value?.users ?? []
  const key = userKeyword.value.trim().toLowerCase()
  const matched = key
    ? rows.filter((r) =>
        [r.name, r.org, r.userId].some((v) => String(v ?? '').toLowerCase().includes(key))
      )
    : rows
  return matched.slice(0, USER_TOP)
})

const guestTotals = computed<AnalyticsGuestTotals | null>(() => analytics.value?.guest ?? null)

/** 账号事件合计（分子） */
const accountEvents = computed(() =>
  (analytics.value?.users ?? []).reduce((acc, r) => acc + r.events, 0)
)

/** 账号事件占全站的比例（分母是区间内全站事件） */
const accountShare = computed(() => {
  const total = analytics.value?.totals.events ?? 0
  return total > 0 ? Math.round((accountEvents.value / total) * 100) : 0
})

const drawerOpen = ref(false)
const drawerAccount = ref({ id: '', name: '', org: '' })

function openUserActivity(row: AnalyticsUserRow): void {
  drawerAccount.value = { id: row.userId, name: row.name, org: row.org }
  drawerOpen.value = true
}

function openGuestActivity(): void {
  drawerAccount.value = { id: GUEST_ACTIVITY_ID, name: '游客（未登录）', org: '' }
  drawerOpen.value = true
}

/** 「最近活跃」列：只看得到日期与时分，年份放全反而挤 */
function shortSeen(iso: string): string {
  if (!iso) return '—'
  return formatTime(iso).slice(5, 16)
}

let timer: number | null = null
function stopTimer(): void {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
}
function toggleAutoRefresh(value: boolean): void {
  autoRefresh.value = value
  stopTimer()
  if (value) timer = window.setInterval(() => void load(), AUTO_REFRESH_MS)
}

onMounted(() => {
  void load()
})
onUnmounted(stopTimer)
</script>

<template>
  <section class="admin">
    <header class="head">
      <div class="head-title">
        <h1>数据看板</h1>
        <!-- 口径说明从整块正文收成一个小圆圈：不占版面，想知道怎么算的点一下 -->
        <button
          type="button"
          class="glossary-btn"
          title="这些数字怎么算的"
          aria-label="查看这些数字怎么算的"
          @click="glossaryOpen = true"
        >
          !
        </button>
      </div>
      <RouterLink to="/shelf" class="back">回到书架</RouterLink>
    </header>

    <div class="toolbar">
      <div class="ranges">
        <button
          v-for="r in RANGES"
          :key="r.days"
          type="button"
          class="range-btn"
          :class="{ 'is-on': rangeDays === r.days }"
          @click="pickRange(r.days)"
        >
          {{ r.label }}
        </button>
      </div>
      <div class="toolbar-right">
        <el-button v-if="stats" :loading="exporting" @click="doExport">导出报表 CSV</el-button>
        <div class="auto-refresh">
          <span>自动刷新</span>
          <el-switch :model-value="autoRefresh" @update:model-value="toggleAutoRefresh" />
        </div>
      </div>
    </div>

    <p v-if="errorText" class="error">统计接口读取失败：{{ errorText }}</p>
    <p v-if="analyticsError" class="error">分析接口读取失败：{{ analyticsError }}（下方带「分析接口」标记的板块会缺数据）</p>
    <p v-if="stats" class="stamp">
      数据生成于 {{ formatTime(stats.generatedAt) }} · 当前区间：近 {{ rangeDays }} 天（环比对上一段同长度区间）
      <span v-if="loading" class="loading-dot">刷新中…</span>
    </p>

    <!-- ============ 1. 核心指标 ============ -->
    <section class="block">
      <div class="block-head">
        <h2>核心指标</h2>
      </div>
      <div class="kpis">
        <div v-for="k in kpis" :key="k.label" class="kpi">
          <span class="kpi-label">{{ k.label }}</span>
          <strong class="kpi-value zw-num">{{ k.value }}</strong>
          <span class="kpi-hint">{{ k.hint }}</span>
          <span v-if="k.delta.text" class="kpi-delta" :class="`is-${k.delta.tone}`">{{ k.delta.text }}</span>
        </div>
      </div>
    </section>

    <!-- ============ 1b. 口径说明 ============
         2026-10-22 用户要求：这一整块正文平时收起，改成标题旁那个圆圈「!」，
         点开才看「这些数字怎么算的」。内容一个字没删，只是不占版面。 -->
    <el-dialog
      v-model="glossaryOpen"
      title="这些数字怎么算的"
      width="min(760px, 92vw)"
      class="glossary-dialog"
    >
      <ul class="glossary">
        <li>
          <span class="g-name">页面访问 PV / 独立访客 UV</span>
          <span class="g-text">
            PV 是「打开页面的次数」，同一个人看十次算十次；UV 是「去重后的人数」，同一个人只算一次。
            人均浏览 = PV ÷ UV，看内容有没有把人留住。
          </span>
        </li>
        <li>
          <span class="g-name">环比</span>
          <span class="g-text">
            「较上期 +12%」是拿当前区间和前一个等长区间比；上期一条数据都没有时写「上期无数据」，不编百分比。
          </span>
        </li>
        <li>
          <span class="g-name">无答案率</span>
          <span class="g-text">AI 问答里答不上来的条数 ÷ 能判定「答得上/答不上」的条数（问得太含糊的题不计入分母）。</span>
        </li>
        <li v-if="overview">
          <span class="g-name">资料份数：{{ overview.total }} 份 / 去重后 {{ overview.uniqueTotal }} 份</span>
          <span class="g-text">
            「{{ overview.total }} 份」是库里存着的份数（同一份资料重复上传过就算多份）；
            「去重后 {{ overview.uniqueTotal }} 份」是把内容相同的副本合并后的实际份数。
            两个数都不是错，区别在于要不要把重复副本算进去。
          </span>
        </li>
        <li v-if="overview">
          <span class="g-name">带主题标签的份数：{{ overview.topicCovered }} 份</span>
          <span class="g-text">
            这 {{ overview.topicCovered }} 份是打过主题标签的，它包含在上面的 {{ overview.total }} 份里面，
            不是另加的一份；也就是说还有 {{ Math.max(0, overview.total - overview.topicCovered) }} 份没打标签，
            在书架的「主题」筛选里挑不出来。
          </span>
        </li>
        <li v-if="overview && overview.duplicateGroups > 0">
          <span class="g-name">重复副本：{{ overview.duplicateGroups }} 组，共 {{ overview.duplicateCopies }} 份</span>
          <span class="g-text">这些是重复上传的副本，去重后按一份算。</span>
        </li>
        <li v-else-if="overview">
          <span class="g-name">重复副本：目前没有发现重复上传</span>
          <span class="g-text">库里每一份的内容都互不相同。</span>
        </li>
        <li>
          <span class="g-name">数据源</span>
          <span class="g-text">
            事件与趋势来自 <code>/api/track/stats</code> 与 <code>/api/admin/analytics</code>（既有口径，未做改动）；
            资料份数来自 <code>/api/overview</code>，只用来解释上面的份数，不参与任何流量统计。
          </span>
        </li>
      </ul>
    </el-dialog>

    <!-- ============ 2. 趋势 + 3. 时段 ============ -->
    <div class="grid grid-2">
      <section class="block">
        <div class="block-head">
          <h2>使用趋势</h2>
        </div>
        <div class="metric-row">
          <button
            v-for="m in METRICS"
            :key="m.key"
            type="button"
            class="metric-btn"
            :class="{ 'is-on': metric === m.key }"
            @click="metric = m.key"
          >
            {{ m.label }}
          </button>
        </div>

        <div v-if="trend.points.length" class="chart">
          <span class="chart-max zw-num">{{ trend.max }}</span>
          <svg class="chart-svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="逐日趋势">
            <polyline class="chart-area" :points="`0,100 ${trend.line} 100,100`" />
            <polyline class="chart-line" :points="trend.line" />
          </svg>
          <span class="chart-zero zw-num">0</span>
        </div>
        <div v-else class="empty-inline">分析接口暂无数据（后端 events.jsonl 还没有可读事件）。</div>

        <div v-if="trend.points.length" class="axis">
          <span>{{ trend.points[0]?.date.slice(5) }}</span>
          <span>{{ trend.points[Math.floor(trend.points.length / 2)]?.date.slice(5) }}</span>
          <span>{{ trend.points[trend.points.length - 1]?.date.slice(5) }}</span>
        </div>
        <p v-if="trendPeak" class="foot-note">
          区间峰值出现在 <b>{{ trendPeak.date }}</b>（{{ trendPeak.value }} 次）——「{{ METRICS.find((m) => m.key === metric)?.label }}」口径。
        </p>
      </section>

      <section class="block">
        <div class="block-head">
          <h2>使用时段</h2>
        </div>
        <div class="hour-chart">
          <div v-for="h in analytics?.hourly ?? []" :key="h.hour" class="hour-col" :title="`${h.hour} 点：${h.events} 次`">
            <span class="hour-bar" :style="{ height: barWidth(h.events, hourMax) }" />
          </div>
        </div>
        <div class="axis axis-hour">
          <span>0 点</span><span>6 点</span><span>12 点</span><span>18 点</span><span>23 点</span>
        </div>
        <div class="weekday-chart">
          <div v-for="w in analytics?.weekday ?? []" :key="w.weekday" class="wd-col">
            <span class="wd-bar" :style="{ height: barWidth(w.events, weekdayMax) }" />
            <span class="wd-label">{{ w.label }}</span>
          </div>
        </div>
        <p class="foot-note">
          <template v-if="hourTop && weekdayTop">
            最活跃时段：<b>{{ hourTop.hour }} 点</b>（{{ hourTop.events }} 次）；最活跃的一天：<b>{{ weekdayTop.label }}</b>（{{ weekdayTop.events }} 次）。
          </template>
          <template v-else>分析接口暂无数据。</template>
        </p>
      </section>
    </div>

    <!-- ============ 4. 漏斗 + 7. 问答质量 ============ -->
    <div class="grid grid-2">
      <section class="block">
        <div class="block-head">
          <h2>使用漏斗</h2>
        </div>
        <ul class="funnel">
          <li v-for="row in funnelRows" :key="row.label">
            <span class="fn-label">{{ row.label }}</span>
            <span class="fn-track"><span class="fn-fill" :style="{ width: `${Math.max(2, row.ofPv)}%` }" /></span>
            <span class="fn-value zw-num">{{ row.value }}</span>
            <span class="fn-pv zw-num">占 PV {{ row.ofPv.toFixed(0) }}%</span>
          </li>
        </ul>
        <p v-if="funnelWorst" class="foot-note">
          转化最低的一步：<b>{{ funnelWorst.label }}</b>（占 PV {{ funnelWorst.ofPv.toFixed(0) }}%）。
        </p>
        <p v-else class="foot-note">分析接口暂无数据。</p>
      </section>

      <section class="block">
        <div class="block-head">
          <h2>AI 问答质量</h2>
        </div>
        <ul class="facts">
          <li><span>提问总数</span><strong class="zw-num">{{ analytics?.asks.total ?? 0 }}</strong></li>
          <li><span>可判定条数</span><strong class="zw-num">{{ analytics?.asks.judged ?? 0 }}</strong></li>
          <li><span>答不上来</span><strong class="zw-num">{{ analytics?.asks.noAnswer ?? 0 }}</strong></li>
          <li><span>未判定（中途断开等）</span><strong class="zw-num">{{ analytics?.asks.unjudged ?? 0 }}</strong></li>
        </ul>
        <div class="rate">
          <span>无答案率</span>
          <el-progress :percentage="noAnswerPercent" :stroke-width="14" />
        </div>
        <el-alert
          v-if="downloadGap !== null && downloadGap !== 0"
          type="info"
          :closable="false"
          show-icon
          class="gap-alert"
          :title="`下载口径对不上：服务端 ${analytics?.downloads.server ?? 0} 次 / 前端上报 ${analytics?.downloads.events ?? 0} 次`"
          description="有请求绕过了前端页面直接调下载接口。不一定算问题，但统计时要心里有数。"
        />
      </section>
    </div>

    <!-- ============ 5. 检索质量 ============ -->
    <section class="block">
      <div class="block-head">
        <h2>检索质量：用户在找什么、什么找不到</h2>
      </div>
      <div class="grid grid-2">
        <div>
          <h3 class="sub-title">检索热词（近 {{ rangeDays }} 天）</h3>
          <el-table :data="analytics?.search.top ?? []" size="small" empty-text="这段时间还没有检索记录">
            <el-table-column type="index" label="#" width="50" />
            <el-table-column prop="term" label="关键词" />
            <el-table-column prop="count" label="次数" width="90" align="right" />
          </el-table>
        </div>
        <div>
          <h3 class="sub-title">
            搜不到结果的关键词
            <span class="sub-hint">零结果率 {{ zeroRatePercent }}%（{{ analytics?.search.zero ?? 0 }} / {{ analytics?.search.total ?? 0 }}）</span>
          </h3>
          <el-table :data="analytics?.search.zeroTerms ?? []" size="small" empty-text="没有零结果检索：现有资料基本覆盖了用户的说法">
            <el-table-column type="index" label="#" width="50" />
            <el-table-column prop="term" label="关键词" />
            <el-table-column prop="count" label="次数" width="90" align="right" />
          </el-table>
        </div>
      </div>
      <p class="foot-note">
        口径：只统计真的提交过的检索（服务端记），零结果 = 该次检索命中 0 份资料。
        测试词（如「zzzz」）也会照实列入 —— 看板不做人工清洗，避免把真实的长尾词也洗掉。
      </p>
    </section>

    <!-- ============ 6. 内容热度 + 既有事件分布 ============ -->
    <div class="grid grid-2">
      <section class="block">
        <div class="block-head">
          <h2>内容热度：下载排行</h2>
        </div>
        <el-table :data="analytics?.downloads.top ?? []" size="small" empty-text="这段时间还没有下载记录">
          <el-table-column type="index" label="#" width="50" />
          <el-table-column prop="fileName" label="文件名" show-overflow-tooltip />
          <el-table-column prop="docId" label="资料" width="90" show-overflow-tooltip />
          <el-table-column prop="count" label="次数" width="80" align="right" />
        </el-table>
      </section>

      <section class="block">
        <div class="block-head">
          <h2>全站事件总账</h2>
        </div>
        <ul class="bars">
          <li v-for="row in eventRows" :key="row.name">
            <span class="bar-label">{{ row.label }}</span>
            <span class="bar-track"><span class="bar-fill" :style="{ width: barWidth(row.count, eventMax) }" /></span>
            <span class="bar-count zw-num">{{ row.count }}</span>
          </li>
        </ul>
        <p class="foot-note">数据源：<code>/api/track/stats</code>（既有统计接口，口径未改动）。统计接口生成于 {{ stats ? formatTime(stats.generatedAt) : '—' }}。</p>
      </section>
    </div>

    <!-- ============ 7. 账号使用明细 ============ -->
    <section class="block">
      <div class="block-head">
        <h2>账号使用明细（近 {{ rangeDays }} 天）</h2>
      </div>

      <div class="user-toolbar">
        <p class="user-sum">
          有活动的账号 <b class="zw-num">{{ analytics?.users.length ?? 0 }}</b> 个 · 账号事件占全站
          <b class="zw-num">{{ accountShare }}%</b>（其余为未登录游客）
        </p>
        <el-input
          v-model="userKeyword"
          class="user-search"
          size="small"
          clearable
          placeholder="搜账号名 / 机构"
        />
      </div>

      <el-table
        :data="userRows"
        size="small"
        empty-text="这段时间还没有账号在站内活动"
        class="clickable-table"
        @row-click="openUserActivity"
      >
        <el-table-column label="账号" min-width="130" show-overflow-tooltip>
          <template #default="{ row }">{{ row.name || row.userId }}</template>
        </el-table-column>
        <el-table-column label="机构" min-width="130" show-overflow-tooltip>
          <template #default="{ row }">{{ row.org || '—' }}</template>
        </el-table-column>
        <el-table-column prop="events" label="事件" width="72" align="right" />
        <el-table-column prop="pv" label="浏览" width="68" align="right" />
        <el-table-column prop="searches" label="检索" width="68" align="right" />
        <el-table-column prop="previews" label="预览" width="68" align="right" />
        <el-table-column prop="downloads" label="下载" width="68" align="right" />
        <el-table-column prop="asks" label="提问" width="68" align="right" />
        <el-table-column label="最近活跃" width="112">
          <template #default="{ row }">{{ shortSeen(row.lastSeen) }}</template>
        </el-table-column>
      </el-table>

      <p v-if="(analytics?.users.length ?? 0) > USER_TOP && !userKeyword.trim()" class="foot-note">
        只列出事件数前 {{ USER_TOP }} 个账号；更全的名单在「注册用户」页。
      </p>

      <div v-if="guestTotals && guestTotals.events > 0" class="guest-line">
        <span class="guest-name">游客（未登录）</span>
        <span class="guest-metrics">
          事件 {{ guestTotals.events }} · 浏览 {{ guestTotals.pv }} · 检索 {{ guestTotals.searches }} ·
          预览 {{ guestTotals.previews }} · 下载 {{ guestTotals.downloads }} · 提问 {{ guestTotals.asks }}
        </span>
        <el-button text size="small" @click="openGuestActivity">查看记录</el-button>
      </div>

      <p class="foot-note">
        数据源：<code>/api/admin/analytics</code>。游客是未登录访客的合计，单列不混进账号排行；
        点任意一行可看这个账号的逐条记录。
      </p>
    </section>

    <!-- 近 14 天（既有块，保留） -->
    <section v-if="stats" class="block">
      <div class="block-head">
        <h2>近 {{ stats.daily.length }} 天事件量（既有口径）</h2>
      </div>
      <div class="trend">
        <div v-for="point in stats.daily" :key="point.date" class="trend-col" :title="`${point.date}：${point.events} 条`">
          <div class="trend-bar" :style="{ height: barWidth(point.events, Math.max(1, ...stats.daily.map((d) => d.events))) }" />
          <span class="trend-date">{{ shortDate(point.date) }}</span>
        </div>
      </div>
    </section>

    <!-- 账号逐条记录抽屉（与分析接口同口径，供上面「账号使用明细」用） -->
    <ActivityDrawer
      v-model:open="drawerOpen"
      :user-id="drawerAccount.id"
      :name="drawerAccount.name"
      :org="drawerAccount.org"
      :days="rangeDays"
    />
</section>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.head h1 {
  margin: 0 0 6px;
  font-size: 22px;
  color: var(--zw-ink);
}
/* 标题 + 口径说明入口（圆圈「!」）排一行 */
.head-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.head-title h1 {
  margin: 0;
}
/* 2026-10-22：口径说明从整块正文收成这一颗小圆圈，hover/聚焦才显色 */
.glossary-btn {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--zw-line-strong);
  border-radius: 50%;
  background: var(--zw-surface);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  color: var(--zw-muted);
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease, color 0.16s ease;
}
.glossary-btn:hover {
  border-color: var(--zw-green-soft);
  background: var(--zw-mint);
  color: var(--zw-green-deep);
}
.glossary-btn:focus-visible {
  outline: 2px solid var(--zw-green);
  outline-offset: 2px;
}
.back {
  font-size: 13px;
  color: var(--zw-green-deep);
  text-decoration: none;
  white-space: nowrap;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.ranges {
  display: flex;
  gap: 6px;
  padding: 3px;
  background: var(--zw-mint-2);
  border: 1px solid var(--zw-line);
  border-radius: 999px;
}
.range-btn {
  font: inherit;
  font-size: 13px;
  padding: 4px 14px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--zw-text);
  cursor: pointer;
}
.range-btn.is-on {
  background: var(--zw-green);
  color: #fff;
  font-weight: 600;
}
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 14px;
}
.auto-refresh {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--zw-muted);
}

.error {
  margin: 0;
  font-size: 13px;
  color: var(--zw-danger);
}
.stamp {
  margin: 0;
  font-size: 12px;
  color: var(--zw-faint);
}
.loading-dot {
  margin-left: 8px;
  color: var(--zw-green-deep);
}

.block {
  background: var(--zw-surface);
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  box-shadow: var(--zw-shadow-sm);
  padding: 16px 18px 18px;
}
.block-head {
  margin-bottom: 14px;
}
.block-head h2 {
  margin: 0 0 6px;
  font-size: 15px;
  color: var(--zw-green-deep);
}
.grid {
  display: grid;
  gap: 18px;
}
.grid-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.sub-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--zw-text);
}
.sub-hint {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--zw-faint);
}

.kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.kpi {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 14px;
  background: var(--zw-mint-2);
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius-sm);
}
.kpi-label {
  font-size: 12.5px;
  color: var(--zw-muted);
}
.kpi-value {
  font-size: 22px;
  color: var(--zw-ink);
  line-height: 1.2;
}
.kpi-hint {
  font-size: 11.5px;
  color: var(--zw-faint);
}
.kpi-delta {
  margin-top: 2px;
  font-size: 11.5px;
}
.kpi-delta.is-up {
  color: var(--zw-green-deep);
}
.kpi-delta.is-down {
  color: var(--zw-danger);
}
.kpi-delta.is-flat,
.kpi-delta.is-none {
  color: var(--zw-faint);
}

.metric-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.metric-btn {
  font: inherit;
  font-size: 12.5px;
  padding: 3px 11px;
  border: 1px solid var(--zw-line-strong);
  border-radius: 999px;
  background: var(--zw-surface);
  color: var(--zw-text);
  cursor: pointer;
}
.metric-btn.is-on {
  background: var(--zw-mint);
  border-color: var(--zw-green-soft);
  color: var(--zw-green-deep);
  font-weight: 600;
}

.chart {
  position: relative;
  height: 150px;
  padding: 6px 30px 6px 0;
  background: linear-gradient(180deg, #fbfdfb, #ffffff);
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius-sm);
}
.chart-svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.chart-line {
  fill: none;
  stroke: var(--zw-green);
  stroke-width: 1.2;
  vector-effect: non-scaling-stroke;
}
.chart-area {
  fill: rgba(46, 125, 50, 0.09);
  stroke: none;
}
.chart-max,
.chart-zero {
  position: absolute;
  right: 6px;
  font-size: 11px;
  color: var(--zw-faint);
}
.chart-max {
  top: 4px;
}
.chart-zero {
  bottom: 4px;
}

.axis {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 11px;
  color: var(--zw-faint);
}
.axis-hour span {
  text-align: center;
}

.hour-chart {
  display: grid;
  grid-template-columns: repeat(24, minmax(0, 1fr));
  align-items: end;
  gap: 2px;
  height: 96px;
  padding-bottom: 2px;
  border-bottom: 1px solid var(--zw-line);
}
.hour-col {
  display: flex;
  align-items: flex-end;
  height: 100%;
}
.hour-bar {
  width: 100%;
  min-height: 2px;
  border-radius: 2px 2px 0 0;
  background: linear-gradient(180deg, var(--zw-green-soft), var(--zw-green));
}

.weekday-chart {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  align-items: end;
  gap: 8px;
  height: 96px;
  margin-top: 12px;
}
.wd-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  height: 100%;
}
.wd-bar {
  width: 60%;
  min-height: 2px;
  border-radius: 3px 3px 0 0;
  background: var(--zw-teal);
  opacity: 0.85;
}
.wd-label {
  font-size: 11px;
  color: var(--zw-muted);
}

.funnel {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.funnel li {
  display: grid;
  grid-template-columns: 118px minmax(0, 1fr) 64px 56px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.fn-label {
  color: var(--zw-text);
}
.fn-track {
  display: block;
  height: 16px;
  background: var(--zw-mint-2);
  border-radius: 999px;
  overflow: hidden;
}
.fn-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--zw-green-light), var(--zw-green));
}
.fn-value {
  text-align: right;
  color: var(--zw-ink);
}
.fn-rate {
  text-align: right;
  font-size: 12px;
  color: var(--zw-faint);
}

.facts {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;
}
.facts li {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: var(--zw-muted);
  border-bottom: 1px dashed var(--zw-line);
  padding-bottom: 6px;
}
.facts strong {
  color: var(--zw-ink);
}
.rate {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--zw-muted);
}
.gap-alert {
  margin-top: 12px;
}

.bars {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bars li {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr) 56px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.bar-label {
  color: var(--zw-text);
}
.bar-track {
  display: block;
  height: 14px;
  background: var(--zw-mint-2);
  border-radius: 999px;
  overflow: hidden;
}
.bar-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--zw-green-soft), var(--zw-green));
}
.bar-count {
  text-align: right;
  color: var(--zw-ink);
}

.trend {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 130px;
}
.trend-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  height: 100%;
}
.trend-bar {
  width: 70%;
  min-height: 2px;
  border-radius: 3px 3px 0 0;
  background: linear-gradient(180deg, var(--zw-green-light), var(--zw-green));
}
.trend-date {
  font-size: 10.5px;
  color: var(--zw-faint);
}

.clickable-table :deep(.el-table__row) {
  cursor: pointer;
}

/* ---- 7. 账号使用明细 ---- */
.user-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.user-sum {
  margin: 0;
  font-size: 12.5px;
  color: var(--zw-muted);
}
.user-search {
  width: 220px;
}
.guest-line {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--zw-line);
  font-size: 12.5px;
  color: var(--zw-muted);
}
.guest-name {
  color: var(--zw-green-deep);
  font-weight: 600;
}
.guest-metrics {
  flex: 1;
  min-width: 240px;
}

.foot-note {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--zw-faint);
}
.empty-inline {
  padding: 24px 0;
  font-size: 13px;
  color: var(--zw-muted);
}
code {
  background: #eef4ee;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 12px;
}

/* 口径说明列表 */
.glossary {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.glossary li {
  display: grid;
  grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
  gap: 12px;
  align-items: baseline;
  font-size: 13px;
  line-height: 1.8;
}
.g-name {
  color: var(--zw-ink);
  font-weight: 600;
}
.g-text {
  color: var(--zw-muted);
}
@media (max-width: 720px) {
  .glossary li {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
}

@media (max-width: 1100px) {
  .kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 900px) {
  .grid-2 {
    grid-template-columns: minmax(0, 1fr);
  }
  .funnel li {
    grid-template-columns: 96px minmax(0, 1fr) 52px 48px;
  }
  .facts {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
