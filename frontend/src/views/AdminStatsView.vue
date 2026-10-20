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
import {
  fetchAnalytics,
  type AnalyticsDailyPoint,
  type AnalyticsPayload
} from '../api/analytics'

const AUTO_REFRESH_MS = 30_000

const stats = ref<StatsSummary | null>(null)
const analytics = ref<AnalyticsPayload | null>(null)
const errorText = ref('')
const analyticsError = ref('')
const autoRefresh = ref(false)
const exporting = ref(false)
const loading = ref(false)

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
  stepRate: number | null
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
  return rows.map((row, index) => ({
    ...row,
    ofPv: (row.value / base) * 100,
    stepRate: index === 0 || rows[index - 1].value === 0 ? null : (row.value / rows[index - 1].value) * 100
  }))
})

const funnelWorst = computed(() => {
  const rows = funnelRows.value.filter((r) => r.stepRate !== null)
  if (!rows.length) return null
  return [...rows].sort((a, b) => (a.stepRate ?? 0) - (b.stepRate ?? 0))[0] ?? null
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
  const [s, a] = await Promise.allSettled([fetchStats(), fetchAnalytics(rangeDays.value * 2)])
  if (s.status === 'fulfilled') stats.value = s.value
  else errorText.value = s.reason instanceof Error ? s.reason.message : '读取统计失败'
  if (a.status === 'fulfilled') analytics.value = a.value
  else analyticsError.value = a.reason instanceof Error ? a.reason.message : '读取分析数据失败'
  loading.value = false
}

function pickRange(days: number): void {
  if (rangeDays.value === days) return
  rangeDays.value = days
  void load()
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
      <div>
        <h1>数据看板</h1>
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
            <span class="fn-rate zw-num">
              {{ row.stepRate === null ? '基准' : `${row.stepRate.toFixed(0)}%` }}
            </span>
          </li>
        </ul>
        <p v-if="funnelWorst" class="foot-note">
          流失最大的一步：<b>{{ funnelWorst.label }}</b>（相对上一步只有 {{ (funnelWorst.stepRate ?? 0).toFixed(0) }}%）。
          括号里的百分比是「相对上一步」，不是相对 PV。
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
