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

import { fetchStats, type StatsSummary, type TrackEventName } from '../api/track'

/** 口令在 localStorage 的键名 */
const TOKEN_KEY = 'zwp.adminToken'

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
    }, AUTO_REFRESH_MS)
    ElMessage.success(`已开启自动刷新（每 ${AUTO_REFRESH_MS / 1000} 秒）`)
  }
}

onMounted(() => {
  const saved = localStorage.getItem(TOKEN_KEY)
  if (saved) {
    token.value = saved
    void load()
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
  color: #8a9a8a;
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
  color: #8a9a8a;
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
</style>
