<script setup lang="ts">
/**
 * 数据概览 —— 新增页（2026-10-10）
 *
 * 这一页是「信息分享」的核心：把知识库里有什么、集中在哪些年份与议题上，
 * 用真实数据画出来，而不是靠一句「内容丰富」带过。
 *
 * 数据源：GET /api/overview（服务端统计，一次拿全）。
 * 图表全部用 CSS/SVG 手写：
 *   - 不引入图表库：这一页只有柱状与条形两种图，为它装一个 echarts 是给项目背包袱；
 *   - 手写还能顺带把「数值」直接标在图上，比 hover 才知道数字更友好（也更可访问）。
 *
 * ⚠️ 百分比、合计一律由**真实数字现算**，页面里没有一个是写死的。
 */
import { computed, onMounted, ref } from 'vue'
import { getOverview } from '../api/overview'
import type { DocOverview, FacetItem } from '../api/types'
import { formatBytes, formatCount, formatYearSpan } from '../utils/format'

const overview = ref<DocOverview | null>(null)
const loading = ref(true)
const failed = ref(false)

async function load(): Promise<void> {
  loading.value = true
  try {
    const data = await getOverview()
    overview.value = data
    failed.value = data === null
  } finally {
    loading.value = false
  }
}

/** 年份柱图：柱高按「该年份数 / 最大份数」算，最小留 6% 以免 0 值看不出来 */
const yearBars = computed(() => {
  const buckets = overview.value?.yearBuckets ?? []
  const max = Math.max(1, ...buckets.map((b) => b.count))
  return buckets.map((b) => ({
    ...b,
    height: `${Math.max(6, Math.round((b.count / max) * 100))}%`,
    share: b.count / max
  }))
})

const yearTotal = computed(() => yearBars.value.reduce((sum, b) => sum + b.count, 0))

/** 横向条形：算好百分比宽度与占比文案 */
function toBars(items: FacetItem[], limit: number): { value: string; count: number; width: string; share: string }[] {
  const sliced = items.slice(0, limit)
  const max = Math.max(1, ...sliced.map((i) => i.count))
  const total = items.reduce((sum, i) => sum + i.count, 0) || 1
  return sliced.map((i) => ({
    value: i.value,
    count: i.count,
    width: `${Math.max(2, Math.round((i.count / max) * 100))}%`,
    share: `${((i.count / total) * 100).toFixed(1)}%`
  }))
}

const typeBars = computed(() => toBars(overview.value?.types ?? [], 12))
const topicBars = computed(() => toBars(overview.value?.topics ?? [], 12))
const orgBars = computed(() => toBars(overview.value?.topOrgs ?? [], 10))

/** 顶部口径卡片 */
const metrics = computed(() => {
  const d = overview.value
  if (!d) return []
  return [
    { label: '收录资料', value: formatCount(d.total), unit: '份', note: `去重后 ${formatCount(d.uniqueTotal)} 份` },
    { label: '资料体积', value: formatBytes(d.totalBytes), unit: '', note: '全部原件合计' },
    { label: '覆盖年份', value: formatYearSpan(d.yearRange), unit: '', note: `另有 ${d.yearUnknown} 份年份待补` },
    { label: '发布机构', value: formatCount(d.orgCount), unit: '家', note: '含联合发布' },
    { label: '知识类型', value: formatCount(d.typeCount), unit: '类', note: '政策 / 报告 / 标准…' },
    { label: '主题领域', value: formatCount(d.topicCount), unit: '类', note: `已标注 ${formatCount(d.topicCovered)} 份` }
  ]
})

/** 最近更新年份：给年份图一个数据落点说明 */
const busiestYear = computed(() => {
  const buckets = (overview.value?.yearBuckets ?? []).filter((b) => /^\d{4}$/.test(b.value))
  if (buckets.length === 0) return null
  return buckets.reduce((best, b) => (b.count > best.count ? b : best))
})

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="insights">
    <header class="page-head">
      <p class="zw-eyebrow">数据概览</p>
      <h1>知识库里都有什么</h1>
      <p class="zw-sub">
        以下所有数字均来自知识库实时统计（接口 <code>GET /api/overview</code>），
        不是示意数据。统计口径见页面底部说明。
      </p>
    </header>

    <el-skeleton v-if="loading" :rows="8" animated />

    <el-empty v-else-if="failed || !overview" description="暂时取不到统计数据">
      <el-button type="primary" @click="load">重新加载</el-button>
    </el-empty>

    <template v-else>
      <!-- 口径卡片 -->
      <section class="metric-grid">
        <div v-for="m in metrics" :key="m.label" class="metric zw-card">
          <span class="metric-label">{{ m.label }}</span>
          <span class="metric-value zw-num">
            {{ m.value }}<em v-if="m.unit">{{ m.unit }}</em>
          </span>
          <span class="metric-note">{{ m.note }}</span>
        </div>
      </section>

      <!-- 年份分布 -->
      <section class="zw-section--tight">
        <div class="sec-head">
          <div>
            <h2 class="zw-h2">按年份分布</h2>
            <p class="zw-sub">
              近十年资料逐年列出，更早的并入「更早」一项；另有 {{ overview.yearUnknown }} 份台账未填年份，未计入图中。
            </p>
          </div>
          <span v-if="busiestYear" class="peak">
            收录最多：{{ busiestYear.value }} 年 · {{ busiestYear.count }} 份
          </span>
        </div>

        <div class="chart-card zw-card">
          <div class="year-chart" role="img" aria-label="各年份收录份数柱状图">
            <div v-for="b in yearBars" :key="b.value" class="year-col">
              <span class="year-count zw-num">{{ b.count }}</span>
              <div class="year-track">
                <div class="year-bar" :style="{ height: b.height }" :title="`${b.value}：${b.count} 份 · ${formatBytes(b.bytes)}`" />
              </div>
              <span class="year-label">{{ b.value }}</span>
            </div>
          </div>
          <p class="chart-foot">
            图中合计 {{ formatCount(yearTotal) }} 份（不含未填年份的 {{ overview.yearUnknown }} 份）。
          </p>
        </div>
      </section>

      <!-- 类型 / 主题 -->
      <section class="zw-section--tight two-col">
        <div class="panel zw-card">
          <h2 class="zw-h2">按资料类型</h2>
          <p class="zw-sub">同一份资料只归一类。</p>
          <ul class="bar-list">
            <li v-for="b in typeBars" :key="b.value">
              <span class="bar-name" :title="b.value">{{ b.value }}</span>
              <span class="bar-track"><span class="bar-fill tone-type" :style="{ width: b.width }" /></span>
              <span class="bar-value zw-num">{{ b.count }}</span>
              <span class="bar-share zw-num">{{ b.share }}</span>
            </li>
          </ul>
        </div>

        <div class="panel zw-card">
          <h2 class="zw-h2">按主题领域</h2>
          <p class="zw-sub">一份资料可同时归属多个主题，故合计大于总份数。</p>
          <ul class="bar-list">
            <li v-for="b in topicBars" :key="b.value">
              <span class="bar-name" :title="b.value">{{ b.value }}</span>
              <span class="bar-track"><span class="bar-fill tone-topic" :style="{ width: b.width }" /></span>
              <span class="bar-value zw-num">{{ b.count }}</span>
              <span class="bar-share zw-num">{{ b.share }}</span>
            </li>
          </ul>
        </div>
      </section>

      <!-- 机构 -->
      <section class="zw-section--tight">
        <h2 class="zw-h2">发布机构 Top 10</h2>
        <p class="zw-sub">
          按份数排序，仅列前 10 家；全部 {{ formatCount(overview.orgCount) }} 家机构可在
          <RouterLink to="/shelf">资料库</RouterLink>的机构筛选中检索。
        </p>
        <ul class="bar-list bar-list--wide">
          <li v-for="b in orgBars" :key="b.value">
            <span class="bar-name" :title="b.value">{{ b.value }}</span>
            <span class="bar-track"><span class="bar-fill tone-org" :style="{ width: b.width }" /></span>
            <span class="bar-value zw-num">{{ b.count }}</span>
          </li>
        </ul>
      </section>

      <!-- 口径说明 -->
      <section id="notes" class="notes zw-card zw-card--pad">
        <h2 class="zw-h2">统计口径与已知局限</h2>
        <ul>
          <li>
            <strong>「收录资料」= 文件份数</strong>，不是台账条目数。台账中一行可能挂着 2–3 个文件，
            统计按文件算。
          </li>
          <li>
            <strong>去重口径</strong>：库中有 {{ overview.duplicateGroups }} 组、
            共 {{ overview.duplicateCopies }} 份资料内容完全相同（按文件逐字节比对得出）。
            本页「收录资料」按原始份数计，卡片上会标注「另有相同副本」。是否撤下重复件待业务方确认。
          </li>
          <li>
            <strong>主题标注覆盖</strong>：{{ formatCount(overview.topicCovered) }} / {{ formatCount(overview.total) }} 份有主题标签。
            该部分标签来自原始台账的「知识领域」列；化学品子库在原台账中没有这一列，已按子库归属统一标注。
          </li>
          <li>
            <strong>机构数为去重计数</strong>：多部门联合发布的文件会把全部署名机构作为一个机构名计入，
            因此「机构数」偏大属正常。
          </li>
          <li>统计时间：{{ new Date(overview.generatedAt).toLocaleString('zh-CN') }}（每次打开本页实时计算）。</li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.insights {
  display: flex;
  flex-direction: column;
}

.page-head {
  padding: 12px 0 4px;
  max-width: 760px;
}

.page-head h1 {
  font-size: 32px;
  margin: 0 0 12px;
}

.page-head code {
  font-size: 13px;
  background: var(--zw-mint);
  color: var(--zw-green-deep);
  border-radius: 5px;
  padding: 1px 6px;
}

/* ---------------- 口径卡片 ---------------- */

.metric-grid {
  display: grid;
  /* 168px 是为了在 1160 版心下正好排成一行 6 格（降一档就会变成 5+1 的别扭排布） */
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: 14px;
  margin: 24px 0 8px;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 18px 20px;
}

.metric-label {
  font-size: 13px;
  color: var(--zw-muted);
}

.metric-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--zw-green-deep);
  line-height: 1.15;
}

.metric-value em {
  font-style: normal;
  font-size: 13px;
  font-weight: 500;
  color: var(--zw-muted);
  margin-left: 3px;
}

.metric-note {
  font-size: 12px;
  color: var(--zw-faint);
}

/* ---------------- 区块头 ---------------- */

.sec-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.peak {
  font-size: 13px;
  color: var(--zw-green-deep);
  background: var(--zw-mint);
  border-radius: 999px;
  padding: 5px 14px;
  white-space: nowrap;
}

/* ---------------- 年份柱图 ---------------- */

.chart-card {
  padding: 22px 20px 14px;
}

.year-chart {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 260px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.year-col {
  flex: 1 1 0;
  min-width: 46px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  height: 100%;
  justify-content: flex-end;
}

.year-count {
  font-size: 12px;
  color: var(--zw-muted);
}

.year-track {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.year-bar {
  width: 70%;
  max-width: 40px;
  border-radius: 6px 6px 2px 2px;
  background: linear-gradient(180deg, var(--zw-green-soft), var(--zw-green));
  transition: height 0.5s cubic-bezier(0.2, 0.8, 0.3, 1);
}

.year-bar:hover {
  background: linear-gradient(180deg, var(--zw-green), var(--zw-green-deep));
}

.year-label {
  font-size: 12px;
  color: var(--zw-muted);
  white-space: nowrap;
}

.chart-foot {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--zw-faint);
}

/* ---------------- 条形列表 ---------------- */

.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.panel {
  padding: 22px 22px 18px;
}

.panel .zw-sub {
  margin-bottom: 14px;
}

.bar-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.bar-list li {
  display: grid;
  grid-template-columns: 132px 1fr 46px 50px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.bar-list--wide li {
  grid-template-columns: 300px 1fr 46px;
}

.bar-name {
  color: var(--zw-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bar-track {
  height: 10px;
  border-radius: 999px;
  background: #eef3ee;
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.5s cubic-bezier(0.2, 0.8, 0.3, 1);
}

.tone-type {
  background: linear-gradient(90deg, var(--zw-green-soft), var(--zw-green));
}

.tone-topic {
  background: linear-gradient(90deg, #7fc4c2, var(--zw-teal));
}

.tone-org {
  background: linear-gradient(90deg, #e6c88a, var(--zw-amber));
}

.bar-value {
  text-align: right;
  color: var(--zw-ink);
  font-weight: 600;
}

.bar-share {
  text-align: right;
  color: var(--zw-faint);
  font-size: 12px;
}

/* ---------------- 口径说明 ---------------- */

.notes {
  margin-top: 32px;
}

.notes ul {
  margin: 10px 0 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.notes li {
  font-size: 13px;
  line-height: 1.8;
  color: var(--zw-text);
}

.notes strong {
  color: var(--zw-ink);
}

@media (max-width: 860px) {
  .two-col {
    grid-template-columns: 1fr;
  }

  .bar-list li {
    grid-template-columns: 96px 1fr 40px 46px;
  }

  .bar-list--wide li {
    grid-template-columns: 130px 1fr 40px;
  }
}

@media (max-width: 640px) {
  .page-head h1 {
    font-size: 25px;
  }

  .year-chart {
    height: 200px;
  }

  .bar-list li {
    grid-template-columns: 84px 1fr 34px;
  }

  .bar-share {
    display: none;
  }
}
</style>
