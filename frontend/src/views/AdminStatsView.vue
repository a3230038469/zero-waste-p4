<script setup lang="ts">
/**
 * 管理统计页 —— 负责人：韶茹（埋点统计配套的后台页）
 *
 * 路由：/admin/stats
 * 数据源：GET /api/track/stats（需 X-Admin-Token，口令存在浏览器本地，不写进代码）
 *
 * 设计取舍：
 *  - 不引图表库（ECharts 会往公众端 bundle 里塞几百 KB），条形图直接用 div 宽度画；
 *  - 口径都在后端算好，本页只负责展示，避免「看板算法」和「接口算法」两份实现漂移。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { ADMIN_TOKEN_KEY, fetchUsageDetail, type UsageDetailPayload } from '../api/admin'
import { fetchStats, type StatsSummary, type TrackEventName } from '../api/track'

/** 口令在 localStorage 的键名（与资料管理 / 注册用户两页共用；不在这里另写一份字面量，
 *  否则改键名时三个后台页会各存一份口令，老师得反复输） */
const TOKEN_KEY = ADMIN_TOKEN_KEY

/** 自动刷新间隔（毫秒） */
const AUTO_REFRESH_MS = 30_000

const token = ref('')
const stats = ref<StatsSummary | null>(null)
const loading = ref(false)
const errorText = ref('')
const autoRefresh = ref(false)

let timer: number | null = null

/** 事件名 -> 中文标签 */
const EVENT_LABELS: Record<TrackEventName, string> = {
  page_view: '页面访问',
  search: '搜索',
  preview: '在线预览',
  download: '下载',
  ai_ask: 'AI 提问',
  register: '注册',
  feedback_submit: '反馈提交'
}

/** 事件分布（按数量降序，只显示发生过的） */
const eventRows = computed(() => {
  const data = stats.value
  if (!data) return []
  return (Object.keys(EVENT_LABELS) as TrackEventName[])
    .map((name) => ({ name, label: EVENT_LABELS[name], count: data.events[name] ?? 0 }))
    .sort((a, b) => b.count - a.count)
})

/** 条形图基准值 */
const eventMax = computed(() => Math.max(1, ...eventRows.value.map((row) => row.count)))
const dailyMax = computed(() => Math.max(1, ...(stats.value?.daily ?? []).map((d) => d.events)))

/** 下载口径是否对得上（服务端 vs 前端埋点） */
const downloadGap = computed(() => {
  const data = stats.value
  if (!data) return null
  return data.downloads.events - data.downloads.server
})

/** 无答案率的百分比展示 */
const noAnswerPercent = computed(() =>
  stats.value ? Math.round(stats.value.asks.noAnswerRate * 1000) / 10 : 0
)

function barWidth(value: number, max: number): string {
  if (value <= 0) return '0%'
  return `${Math.max(2, Math.round((value / max) * 100))}%`
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 只保留「月-日」，趋势图横轴用 */
function shortDate(value: string): string {
  return value.slice(5)
}

async function load(): Promise<void> {
  if (!token.value) {
    errorText.value = '请输入看板口令（后端 backend/.env 里的 ADMIN_STATS_TOKEN）'
    return
  }
  loading.value = true
  try {
    stats.value = await fetchStats(token.value)
    errorText.value = ''
    localStorage.setItem(TOKEN_KEY, token.value)
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: { error?: { code?: string; message?: string } } } })
      .response
    const code = response?.data?.error?.code
    if (code === 'ADMIN_NOT_CONFIGURED') {
      errorText.value = '服务端还没配 ADMIN_STATS_TOKEN（看板已关闭）。请在 backend/.env 里配好再重启后端。'
    } else if (code === 'ADMIN_FORBIDDEN' || response?.status === 403) {
      errorText.value = '口令不正确。'
    } else {
      errorText.value = response?.data?.error?.message ?? '拉取失败，看看后端是否已启动（:4000）。'
    }
    stats.value = null
  } finally {
    loading.value = false
  }
}

function applyToken(): void {
  void load()
}

function clearToken(): void {
  token.value = ''
  stats.value = null
  errorText.value = ''
  localStorage.removeItem(TOKEN_KEY)
}

function toggleAutoRefresh(value: boolean): void {
  autoRefresh.value = value
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
  if (value) {
    timer = window.setInterval(() => {
      void load()
      void loadUsage()
    }, AUTO_REFRESH_MS)
    ElMessage.success(`已开启自动刷新（每 ${AUTO_REFRESH_MS / 1000} 秒）`)
  }
}

/* ------------------------------------------------------------------ *
 * 使用明细（T11-C，本轮**只在末尾新增**这一块）
 * ------------------------------------------------------------------ *
 *
 * 🔴 本块与韶茹写的顶部指标 / 趋势 / 热词 / 热门文件**完全独立**：
 *    - 独立接口 GET /api/admin/usage-detail（不动 GET /api/track/stats 的口径）；
 *    - 独立状态（日期 / 加载 / 报错），不碰 stats / eventRows / daily 等既有变量；
 *    - 独立表格样式前缀 `.usage-*`，不覆盖任何既有类。
 */
/** 本地时区的 YYYY-MM-DD（与后端切天口径一致；toISOString 会差 8 小时，不能用） */
function todayKey(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const usageDate = ref(todayKey())
const usage = ref<UsageDetailPayload | null>(null)
const usageLoading = ref(false)
const usageError = ref('')

/** 账号列显示名：后端已把 null 显示成「游客」，这里只兜住「有 id 但查不到用户」的情况 */
function usageAccountName(row: UsageDetailPayload['rows'][number]): string {
  if (row.name) return row.name
  return row.userId ? `未登记账号（${row.userId.slice(0, 8)}…）` : '游客'
}

async function loadUsage(): Promise<void> {
  if (!token.value) return
  usageLoading.value = true
  usageError.value = ''
  try {
    usage.value = await fetchUsageDetail(token.value, usageDate.value)
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: { error?: { message?: string } } } })
      .response
    usageError.value = response?.data?.error?.message ?? '使用明细拉取失败，看看后端（:4100/:4000）在不在。'
    usage.value = null
  } finally {
    usageLoading.value = false
  }
}

/** 合计行（含游客，因为游客的使用次数同样是站点被用掉的能力） */
const usageTotals = computed(
  () => usage.value?.totals ?? { ai_ask: 0, preview: 0, download: 0 }
)
const usageTotalSum = computed(
  () => usageTotals.value.ai_ask + usageTotals.value.preview + usageTotals.value.download
)

onMounted(() => {
  const saved = localStorage.getItem(TOKEN_KEY)
  if (saved) {
    token.value = saved
    void load()
    void loadUsage()
  }
})

onUnmounted(() => {
  if (timer !== null) window.clearInterval(timer)
})
</script>

<template>
  <section class="admin">
    <header class="head">
      <div>
        <h1>数据看板</h1>
        <p class="sub">访客行为、搜索结果、资料热度与 AI 答不上来的问题，都在这块看板上。</p>
      </div>
      <RouterLink to="/shelf" class="back">回到书架</RouterLink>
    </header>

    <nav class="admin-nav">
      <RouterLink to="/admin/knowledge">资料管理</RouterLink>
      <RouterLink to="/admin/users">注册用户</RouterLink>
      <RouterLink to="/admin/stats">数据看板</RouterLink>
    </nav>

    <!-- 口令门 -->
    <el-card shadow="never" class="token-card">
      <div class="token-row">
        <el-input
          v-model="token"
          type="password"
          show-password
          placeholder="看板口令（ADMIN_STATS_TOKEN）"
          class="token-input"
          @keyup.enter="applyToken"
        />
        <el-button type="primary" :loading="loading" @click="applyToken">查看看板</el-button>
        <el-button v-if="stats" @click="clearToken">清除口令</el-button>
        <div class="auto-refresh">
          <span>自动刷新</span>
          <el-switch :model-value="autoRefresh" @update:model-value="toggleAutoRefresh" />
        </div>
      </div>
      <p v-if="errorText" class="error">{{ errorText }}</p>
    </el-card>

    <template v-if="stats">
      <!-- 顶部指标 -->
      <div class="kpis">
        <div class="kpi">
          <span class="kpi-label">事件总数</span>
          <strong class="kpi-value">{{ stats.totals.events }}</strong>
        </div>
        <div class="kpi">
          <span class="kpi-label">页面访问 PV</span>
          <strong class="kpi-value">{{ stats.totals.pv }}</strong>
        </div>
        <div class="kpi">
          <span class="kpi-label">独立访客 UV</span>
          <strong class="kpi-value">{{ stats.totals.uv }}</strong>
        </div>
        <div class="kpi">
          <span class="kpi-label">下载（服务端口径）</span>
          <strong class="kpi-value">{{ stats.downloads.server }}</strong>
        </div>
        <div class="kpi">
          <span class="kpi-label">AI 提问</span>
          <strong class="kpi-value">{{ stats.asks.total }}</strong>
        </div>
        <div class="kpi">
          <span class="kpi-label">无答案率</span>
          <strong class="kpi-value">{{ noAnswerPercent }}%</strong>
        </div>
      </div>

      <p class="stamp">数据生成于 {{ formatTime(stats.generatedAt) }}</p>

      <div class="grid">
        <!-- 事件分布 -->
        <el-card shadow="never" class="panel">
          <template #header><span class="panel-title">事件分布</span></template>
          <ul class="bars">
            <li v-for="row in eventRows" :key="row.name">
              <span class="bar-label">{{ row.label }}</span>
              <span class="bar-track">
                <span class="bar-fill" :style="{ width: barWidth(row.count, eventMax) }" />
              </span>
              <span class="bar-count">{{ row.count }}</span>
            </li>
          </ul>
        </el-card>

        <!-- 近 14 天趋势 -->
        <el-card shadow="never" class="panel">
          <template #header><span class="panel-title">近 {{ stats.daily.length }} 天事件量</span></template>
          <div class="trend">
            <div v-for="point in stats.daily" :key="point.date" class="trend-col" :title="`${point.date}：${point.events} 条`">
              <div class="trend-bar" :style="{ height: barWidth(point.events, dailyMax) }" />
              <span class="trend-date">{{ shortDate(point.date) }}</span>
            </div>
          </div>
        </el-card>
      </div>

      <div class="grid">
        <!-- Top 搜索词 -->
        <el-card shadow="never" class="panel">
          <template #header><span class="panel-title">搜索热词 Top 10</span></template>
          <el-table :data="stats.topSearchTerms" size="small" empty-text="还没有搜索记录">
            <el-table-column type="index" label="#" width="50" />
            <el-table-column prop="term" label="关键词" />
            <el-table-column prop="count" label="次数" width="90" align="right" />
          </el-table>
        </el-card>

        <!-- 零结果词：最该补资料的信号 -->
        <el-card shadow="never" class="panel">
          <template #header>
            <span class="panel-title">搜不到结果的关键词</span>
            <span class="panel-hint">这些词最该去补资料</span>
          </template>
          <el-table :data="stats.zeroResultSearchTerms" size="small" empty-text="暂无零结果搜索">
            <el-table-column type="index" label="#" width="50" />
            <el-table-column prop="term" label="关键词" />
            <el-table-column prop="count" label="次数" width="90" align="right" />
          </el-table>
        </el-card>
      </div>

      <div class="grid">
        <!-- 下载排行 -->
        <el-card shadow="never" class="panel">
          <template #header>
            <span class="panel-title">下载排行 Top 10</span>
            <span class="panel-hint">口径 = 后端下载接口（服务端记）</span>
          </template>
          <el-table :data="stats.topDownloads" size="small" empty-text="还没有下载记录">
            <el-table-column type="index" label="#" width="50" />
            <el-table-column prop="fileName" label="文件名" show-overflow-tooltip />
            <el-table-column prop="docId" label="资料" width="90" />
            <el-table-column prop="count" label="次数" width="90" align="right" />
          </el-table>
        </el-card>

        <!-- 提问质量 -->
        <el-card shadow="never" class="panel">
          <template #header><span class="panel-title">问答质量</span></template>
          <ul class="facts">
            <li><span>提问总数</span><strong>{{ stats.asks.total }}</strong></li>
            <li><span>可判定条数</span><strong>{{ stats.asks.judged }}</strong></li>
            <li><span>答不上来</span><strong>{{ stats.asks.noAnswer }}</strong></li>
            <li><span>未判定（中途断开等）</span><strong>{{ stats.asks.unjudged }}</strong></li>
          </ul>
          <div class="rate">
            <span>无答案率</span>
            <el-progress :percentage="noAnswerPercent" :stroke-width="14" />
          </div>
          <p class="note">
            无答案率 = 答不上来 ÷ 可判定条数。这个数字偏高，说明资料没覆盖到用户真正想问的问题，
            或者引擎没检索到——两类原因要分开排查。
          </p>
        </el-card>
      </div>

      <el-alert
        v-if="downloadGap !== null && downloadGap !== 0"
        type="info"
        :closable="false"
        show-icon
        class="gap-alert"
        :title="`下载口径对不上：服务端 ${stats.downloads.server} 次 / 前端上报 ${stats.downloads.events} 次`"
        description="有请求绕过了前端页面直接调下载接口（比如 curl 或第三方工具）。这不一定算问题，但统计时要心里有数。"
      />

      <!-- 🔴 T11-C 新增：使用明细（本轮只在末尾加这一块，既有统计一个字没动） -->
      <el-card shadow="never" class="panel usage-block">
        <template #header>
          <span class="panel-title">使用明细</span>
          <span class="panel-hint">每个账号的 AI 问答 / 预览 / 下载三项次数（口径 = 服务端埋点）</span>
        </template>

        <div class="usage-toolbar">
          <div class="usage-date">
            <span class="usage-date-label">日期</span>
            <el-date-picker
              v-model="usageDate"
              type="date"
              value-format="YYYY-MM-DD"
              format="YYYY-MM-DD"
              :clearable="false"
              style="width: 170px"
              @change="loadUsage"
            />
            <el-button :loading="usageLoading" @click="loadUsage">查询</el-button>
            <el-button text @click="usageDate = todayKey(); loadUsage()">回到今天</el-button>
          </div>
          <div class="usage-sum">
            <span>当日合计</span>
            <strong class="zw-num">AI 问答 {{ usageTotals.ai_ask }}</strong>
            <strong class="zw-num">预览 {{ usageTotals.preview }}</strong>
            <strong class="zw-num">下载 {{ usageTotals.download }}</strong>
            <strong class="zw-num usage-sum-total">共 {{ usageTotalSum }} 次</strong>
          </div>
        </div>

        <p v-if="usageError" class="usage-error">{{ usageError }}</p>

        <el-table
          v-else
          v-loading="usageLoading"
          :data="usage?.rows ?? []"
          size="small"
          :empty-text="`${usage?.date ?? usageDate} 没有使用记录`"
        >
          <el-table-column label="账号" min-width="200">
            <template #default="{ row }">
              <span :class="row.userId === null ? 'usage-guest' : 'usage-user'">
                {{ usageAccountName(row) }}
              </span>
              <span v-if="row.org" class="usage-org">{{ row.org }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="ai_ask" label="AI 问答" width="110" align="right" />
          <el-table-column prop="preview" label="预览" width="100" align="right" />
          <el-table-column prop="download" label="下载" width="100" align="right" />
          <el-table-column prop="total" label="合计" width="100" align="right" />
        </el-table>

        <p class="usage-note">
          口径说明：只统计 <code>ai_ask</code> / <code>preview</code> / <code>download</code> 三类事件，
          <b>AI 问答与预览/下载都由服务端接口自动记录</b>，绕过页面直接调接口也算。
          「游客」= 未登录的用户（存储层记的是空值，不是账号）。
          ⚠️ 埋点带账号是 2026-10-14（T11）才上线的，<b>此前的历史记录全部落在「游客」行里</b>，
          追不回来。
        </p>
      </el-card>
    </template>
  </section>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.head h1 {
  margin: 0 0 6px;
  font-size: 22px;
  color: var(--zw-green);
}
.sub {
  margin: 0;
  color: #5b6b5b;
  font-size: 14px;
}
.back {
  color: var(--zw-green);
  text-decoration: none;
  font-size: 14px;
  white-space: nowrap;
}
.token-card :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
.token-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.token-input {
  max-width: 320px;
}
.auto-refresh {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: #5b6b5b;
  margin-left: auto;
}
.error {
  margin: 0;
  color: #c0392b;
  font-size: 14px;
}
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.kpi {
  background: #fff;
  border: 1px solid #e4ece4;
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kpi-label {
  font-size: 13px;
  color: #6b7b6b;
}
.kpi-value {
  font-size: 24px;
  color: var(--zw-green);
  font-variant-numeric: tabular-nums;
}
.stamp {
  margin: 0;
  font-size: 13px;
  color: #7b8b7b;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 16px;
}
.panel :deep(.el-card__header) {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.panel-title {
  font-weight: 600;
  color: #2b3a2b;
}
.panel-hint {
  font-size: 12px;
  color: var(--zw-faint);
  font-weight: 400;
}
.bars {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bars li {
  display: grid;
  grid-template-columns: 82px 1fr 44px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.bar-label {
  color: #4b5b4b;
}
.bar-track {
  background: #eef4ee;
  border-radius: 999px;
  height: 14px;
  overflow: hidden;
}
.bar-fill {
  display: block;
  height: 100%;
  background: var(--zw-green-light);
  border-radius: 999px;
  transition: width 0.3s ease;
}
.bar-count {
  text-align: right;
  color: #2b3a2b;
  font-variant-numeric: tabular-nums;
}
.trend {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 150px;
  overflow-x: auto;
}
.trend-col {
  flex: 1 0 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
  gap: 6px;
}
.trend-bar {
  width: 100%;
  min-height: 2px;
  background: var(--zw-green-light);
  border-radius: 4px 4px 0 0;
}
.trend-date {
  font-size: 11px;
  color: var(--zw-faint);
  white-space: nowrap;
}
.facts {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.facts li {
  display: flex;
  justify-content: space-between;
  font-size: 14px;
  color: #4b5b4b;
  border-bottom: 1px dashed #e4ece4;
  padding-bottom: 6px;
}
.rate {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  color: #4b5b4b;
}
.rate :deep(.el-progress) {
  flex: 1;
}
.note {
  margin: 12px 0 0;
  font-size: 12px;
  color: #7b8b7b;
  line-height: 1.6;
}
@media (max-width: 600px) {
  .auto-refresh {
    margin-left: 0;
  }
  .bars li {
    grid-template-columns: 72px 1fr 36px;
  }
}

/* ---- 使用明细（T11-C 新增；样式前缀全用 .usage-*，不覆盖任何既有类） ---- */
.usage-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.usage-date {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.usage-date-label {
  font-size: 13px;
  color: var(--zw-muted);
}
.usage-sum {
  display: flex;
  align-items: baseline;
  gap: 14px;
  font-size: 13px;
  color: var(--zw-muted);
  flex-wrap: wrap;
}
.usage-sum strong {
  color: var(--zw-green);
  font-variant-numeric: tabular-nums;
}
.usage-sum-total {
  padding-left: 10px;
  border-left: 1px dashed var(--zw-line);
}
.usage-error {
  margin: 0 0 10px;
  font-size: 13px;
  color: #c45656;
}
.usage-guest {
  color: var(--zw-faint);
}
.usage-user {
  color: var(--zw-ink);
}
.usage-org {
  margin-left: 8px;
  font-size: 12px;
  color: var(--zw-faint);
}
.usage-note {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--zw-faint);
}
</style>
