<script setup lang="ts">
/**
 * 首页 —— 对外展示站版（2026-10-10 重写）
 *
 * 原版是「搜索框 + 示例问题」的极简工具页：能用，但对外来访的公众、基金会伙伴、
 * 研究者看不出「这是什么、有什么、谁在做」。重写后按对外展示的逻辑分六块：
 *   1. 首屏      —— 一句话讲清项目定位 + 检索入口（最常用的动作放最上面）
 *   2. 数据速览  —— 份数 / 年份跨度 / 机构数 / 主题数（全部来自 GET /api/overview，不写死）
 *   3. 主题导航  —— 按知识领域进资料库（最贴合「我想找某类资料」的心智）
 *   4. 类型入口  —— 按资料类型进（政策法规 / 研究报告 / 标准规范 / 实践工具…）
 *   5. 最新收录  —— 让人看到库是活的
 *   6. 关于 + 问答 —— 交代这是谁办的，并把 AI 问答摆出来
 *
 * ⚠️ 所有数字都动态取，取不到就显示「—」：绝不把某个数字写死在页面上，
 *    数据一变页面就对不上了（上一版首页已经在这一点上踩过）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { getOverview } from '../api/overview'
import type { DocOverview } from '../api/types'
import DocCard from '../components/DocCard.vue'
import HomeAskWidget from '../components/HomeAskWidget.vue'
import { formatCount, formatYearSpan } from '../utils/format'

const router = useRouter()
const keyword = ref('')

function onSearch(): void {
  const q = keyword.value.trim()
  void router.push(q ? { path: '/shelf', query: { q } } : { path: '/shelf' })
}

/* ---------------- 整库概览（数据速览 + 主题 + 类型 + 最新） ---------------- */

const overview = ref<DocOverview | null>(null)
const loading = ref(true)

async function loadOverview(): Promise<void> {
  loading.value = true
  try {
    overview.value = await getOverview()
  } finally {
    loading.value = false
  }
}

/** 数据速览三项：份数 / 年份跨度 / 发布机构数。取不到一律显示「—」，不留空白格。 */
const stats = computed(() => {
  const data = overview.value
  return [
    { label: '收录资料', value: data ? formatCount(data.total) : '—', unit: '份' },
    { label: '覆盖年份', value: data ? formatYearSpan(data.yearRange) : '—', unit: '' },
    { label: '发布机构', value: data ? formatCount(data.orgCount) : '—', unit: '家' },
    { label: '主题领域', value: data ? formatCount(data.topicCount) : '—', unit: '类' }
  ]
})

/** 主题导航：取前 12 个主题（按份数倒序），点进资料库并带上筛选 */
const topTopics = computed(() => (overview.value?.topics ?? []).slice(0, 12))

/** 类型入口：库里实际存在的类型全列（不是写死的四个） */
const typeEntries = computed(() => overview.value?.types ?? [])

const latest = computed(() => overview.value?.latest ?? [])

/* ---------------- 快捷提问 ---------------- */

const SAMPLE_QUESTIONS = [
  '厨余垃圾怎么就地处理？',
  '社区堆肥需要注意什么？',
  '一次性塑料制品有哪些替代方案？',
  '「无废城市」建设有哪些要求？'
]

const widgetRef = ref<InstanceType<typeof HomeAskWidget> | null>(null)
const widgetOpen = ref(false)
const pendingCount = ref(0)
const asking = computed(() => pendingCount.value > 0)

/** 点击示例问题：送进问答窗口并自动发送（串行与防丢由问答窗口负责） */
async function onAskSample(question: string): Promise<void> {
  pendingCount.value += 1
  try {
    await widgetRef.value?.askWith(question)
  } catch {
    // 降级提示由挂件面板内部统一呈现
  } finally {
    pendingCount.value = Math.max(0, pendingCount.value - 1)
  }
}

/** 主题/类型入口统一走资料库，并把筛选条件写进地址栏（可分享、可收藏） */
function goShelf(query: Record<string, string>): void {
  void router.push({ path: '/shelf', query })
}

onMounted(() => {
  void loadOverview()
})
</script>

<template>
  <div class="home">
    <!-- 1. 首屏 -->
    <section class="hero">
      <p class="zw-eyebrow">六尺巷基金会 · 零废弃知识库</p>
      <h1>
        把零废弃的知识<br />
        <span class="hl">整理成每个人都能用的资料库</span>
      </h1>
      <p class="hero-lead">
        我们系统收录零废弃与废弃物管理领域的政策法规、研究报告、标准规范与实践工具，
        来源公开、条目可溯。你可以按主题浏览、按关键词检索，也可以直接向 AI 助手提问。
      </p>

      <div class="search-row">
        <el-input
          v-model="keyword"
          placeholder="搜索资料名称、政策文件、发布机构……"
          size="large"
          clearable
          class="search-input"
          @keyup.enter="onSearch"
        >
          <template #prefix>
            <span class="search-icon" aria-hidden="true">🔍</span>
          </template>
        </el-input>
        <el-button type="primary" size="large" class="search-btn" @click="onSearch">搜索</el-button>
      </div>

      <div class="hot-terms">
        <span class="hot-label">常见检索：</span>
        <button v-for="t in ['零废弃', '垃圾分类', '塑料', '无废城市', '化学品']" :key="t" class="hot-chip" type="button" @click="goShelf({ tag: t })">
          {{ t }}
        </button>
      </div>
    </section>

    <!-- 2. 数据速览 -->
    <section class="stats-strip zw-card" aria-label="知识库规模">
      <div v-for="s in stats" :key="s.label" class="stat">
        <span class="stat-label">{{ s.label }}</span>
        <span class="stat-value zw-num">
          {{ s.value }}<em v-if="s.unit">{{ s.unit }}</em>
        </span>
      </div>
      <RouterLink to="/insights" class="stat-more">查看数据概览 →</RouterLink>
    </section>

    <!-- 3. 主题导航 -->
    <section class="zw-section--tight">
      <div class="sec-head">
        <div>
          <h2 class="zw-h2">按主题找资料</h2>
          <p class="zw-sub">知识库里的每份资料都归入了一个零废弃议题，沿议题往下看即可。</p>
        </div>
        <RouterLink to="/shelf" class="sec-link">全部资料 →</RouterLink>
      </div>
      <div v-if="topTopics.length" class="topic-grid">
        <button
          v-for="t in topTopics"
          :key="t.value"
          type="button"
          class="topic-chip"
          @click="goShelf({ tag: t.value })"
        >
          <span class="topic-name">{{ t.value }}</span>
          <span class="topic-count zw-num">{{ t.count }}</span>
        </button>
      </div>
      <el-skeleton v-else-if="loading" :rows="2" animated />
      <p v-else class="zw-sub">暂时取不到主题数据，可直接前往<a href="/shelf">资料库</a>浏览。</p>
    </section>

    <!-- 4. 类型入口 -->
    <section class="zw-section--tight">
      <div class="sec-head">
        <div>
          <h2 class="zw-h2">按资料类型找</h2>
          <p class="zw-sub">政策文件用来对照要求，研究报告用来找依据，实践工具可以直接拿去用。</p>
        </div>
      </div>
      <div v-if="typeEntries.length" class="type-grid">
        <button
          v-for="t in typeEntries"
          :key="t.value"
          type="button"
          class="type-card"
          @click="goShelf({ type: t.value })"
        >
          <span class="type-name">{{ t.value }}</span>
          <span class="type-count zw-num">{{ t.count }} 份</span>
        </button>
      </div>
    </section>

    <!-- 5. 最新收录 -->
    <section v-if="latest.length" class="zw-section--tight">
      <div class="sec-head">
        <div>
          <h2 class="zw-h2">最近收录</h2>
          <p class="zw-sub">知识库持续更新，以下为最近入库的资料。</p>
        </div>
        <RouterLink to="/shelf" class="sec-link">浏览全部 →</RouterLink>
      </div>
      <div class="doc-grid">
        <DocCard v-for="doc in latest" :key="doc.id" :doc="doc" />
      </div>
    </section>

    <!-- 6. 关于 + AI 问答 -->
    <section class="about-ask">
      <div class="about-box zw-card zw-card--pad">
        <h2 class="zw-h2">关于这个知识库</h2>
        <p class="zw-sub">
          零废弃知识库由六尺巷基金会建设并开放给公众使用，收录零废弃与废弃物管理领域的公开资料，
          供社区工作者、行业从业者、研究者与关心环境的公众查阅。
        </p>
        <ul class="about-list">
          <li>资料来源于公开出版物、政府公开文件与公开研究报告，条目方向可溯</li>
          <li>提供分类浏览、四维筛选、关键词检索与 AI 问答四种使用方式</li>
          <li>使用与引用说明、数据口径与联系方式，见「关于项目」页</li>
        </ul>
        <RouterLink to="/about" class="about-link">了解项目与数据说明 →</RouterLink>
      </div>

      <div class="ask-box">
        <h2 class="zw-h2">不确定怎么找？直接问</h2>
        <p class="zw-sub">AI 助手会从知识库中检索内容作答，访客无需注册即可提问。</p>
        <div class="ask-samples">
          <button
            v-for="q in SAMPLE_QUESTIONS"
            :key="q"
            type="button"
            class="sample-chip"
            :disabled="asking"
            @click="onAskSample(q)"
          >
            {{ q }}
          </button>
        </div>
        <el-button type="primary" class="ask-open" @click="widgetOpen = true">打开 AI 助手</el-button>
      </div>
    </section>

    <HomeAskWidget ref="widgetRef" v-model:open="widgetOpen" />
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
}

/* ---------------- 首屏 ---------------- */

.hero {
  padding: 32px 0 12px;
  max-width: 780px;
}

.hero h1 {
  font-size: 40px;
  line-height: 1.32;
  margin: 0 0 18px;
  letter-spacing: -0.02em;
}

.hero h1 .hl {
  color: var(--zw-green-deep);
  background: linear-gradient(transparent 62%, rgba(102, 187, 106, 0.32) 62%);
  padding-bottom: 2px;
}

.hero-lead {
  font-size: 16px;
  line-height: 1.9;
  color: var(--zw-muted);
  margin: 0 0 26px;
  max-width: 40em;
}

.search-row {
  display: flex;
  gap: 10px;
  max-width: 640px;
}

.search-input {
  flex: 1;
}

.search-icon {
  font-size: 14px;
  opacity: 0.55;
}

.search-btn {
  padding-left: 26px;
  padding-right: 26px;
}

.hot-terms {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.hot-label {
  font-size: 13px;
  color: var(--zw-faint);
}

.hot-chip {
  border: 1px dashed var(--zw-line-strong);
  background: rgba(255, 255, 255, 0.7);
  color: var(--zw-muted);
  font: inherit;
  font-size: 13px;
  padding: 4px 12px;
  border-radius: 999px;
  cursor: pointer;
  transition:
    color 0.16s ease,
    border-color 0.16s ease,
    background 0.16s ease;
}

.hot-chip:hover {
  color: var(--zw-green-deep);
  border-color: var(--zw-green);
  background: #fff;
}

/* ---------------- 数据速览 ---------------- */

.stats-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr) auto;
  align-items: center;
  gap: 16px;
  margin: 28px 0 8px;
  padding: 20px 24px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 16px;
  border-right: 1px solid var(--zw-line);
}

.stat:last-of-type {
  border-right: 0;
}

.stat-label {
  font-size: 13px;
  color: var(--zw-muted);
}

.stat-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--zw-green-deep);
  line-height: 1.2;
}

.stat-value em {
  font-style: normal;
  font-size: 13px;
  font-weight: 500;
  color: var(--zw-muted);
  margin-left: 3px;
}

.stat-more {
  font-size: 13px;
  color: var(--zw-green);
  text-decoration: none;
  white-space: nowrap;
}

.stat-more:hover {
  text-decoration: underline;
}

/* ---------------- 区块头 ---------------- */

.sec-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.sec-link {
  font-size: 14px;
  color: var(--zw-green);
  text-decoration: none;
  white-space: nowrap;
}

.sec-link:hover {
  text-decoration: underline;
}

/* ---------------- 主题 ---------------- */

.topic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}

.topic-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 13px 16px;
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius-sm);
  background: var(--zw-surface);
  font: inherit;
  cursor: pointer;
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.18s ease;
}

.topic-chip:hover {
  border-color: var(--zw-green-soft);
  box-shadow: var(--zw-shadow-sm);
  transform: translateY(-2px);
}

.topic-name {
  font-size: 14px;
  color: var(--zw-ink);
  font-weight: 600;
  /* 像「食物/有机废弃物」这种长主题名要截断而不是换行 —— 一换行整行格子就参差不齐 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topic-count {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--zw-teal);
  background: var(--zw-teal-soft);
  border-radius: 999px;
  padding: 1px 8px;
}

/* ---------------- 类型 ---------------- */

.type-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}

.type-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  padding: 16px 18px;
  border: 1px solid var(--zw-line);
  border-left: 4px solid var(--zw-green-soft);
  border-radius: var(--zw-radius-sm);
  background: var(--zw-surface);
  font: inherit;
  cursor: pointer;
  text-align: left;
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.18s ease;
}

.type-card:hover {
  border-color: var(--zw-line-strong);
  border-left-color: var(--zw-green);
  box-shadow: var(--zw-shadow-sm);
  transform: translateY(-2px);
}

.type-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--zw-ink);
}

.type-count {
  font-size: 12px;
  color: var(--zw-muted);
}

/* ---------------- 资料网格 ---------------- */

.doc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

/* ---------------- 关于 + 问答 ---------------- */

.about-ask {
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  gap: 20px;
  margin-top: 44px;
}

.about-list {
  margin: 14px 0 18px;
  padding-left: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.about-list li {
  position: relative;
  padding-left: 20px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--zw-text);
}

.about-list li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 9px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--zw-green-soft);
}

.about-link {
  font-size: 14px;
  color: var(--zw-green-deep);
  text-decoration: none;
  font-weight: 600;
}

.about-link:hover {
  text-decoration: underline;
}

.ask-box {
  padding: 22px 22px 24px;
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  background: linear-gradient(160deg, var(--zw-mint-2), #fff 62%);
}

.ask-samples {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 16px 0 18px;
}

.sample-chip {
  border: 1px solid var(--zw-line-strong);
  background: #fff;
  color: var(--zw-text);
  font: inherit;
  font-size: 13px;
  padding: 7px 13px;
  border-radius: 999px;
  cursor: pointer;
  transition:
    color 0.16s ease,
    border-color 0.16s ease;
}

.sample-chip:hover:not(:disabled) {
  color: var(--zw-green-deep);
  border-color: var(--zw-green);
}

.sample-chip:disabled {
  opacity: 0.55;
  cursor: default;
}

.ask-open {
  width: 100%;
}

/* ---------------- 窄屏 ---------------- */

@media (max-width: 900px) {
  .stats-strip {
    grid-template-columns: repeat(2, 1fr);
  }

  .stat:nth-child(2n) {
    border-right: 0;
  }

  .stat-more {
    grid-column: 1 / -1;
    /* 窄屏靠左：右下角是固定的 AI 问答气泡，靠右会被它压住 */
    text-align: left;
  }

  .about-ask {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .hero h1 {
    font-size: 27px;
  }

  .search-row {
    flex-direction: column;
  }

  .search-btn {
    width: 100%;
  }

  .stat-value {
    font-size: 22px;
  }
}
</style>
