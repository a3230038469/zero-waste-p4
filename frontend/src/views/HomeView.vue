<script setup lang="ts">
/**
 * 首页 —— 对外展示站版（2026-10-18 task-6 第二轮改版：首屏 + 分隔线以下的「关于」四栏）
 *
 * 用户原话（2026-10-18，口述）：「这行字往下的所有东西都可以去掉了」，
 * 指的是首屏那条规则小字（点开任意资料可在线预览…）往下的四块内容。
 *
 * 本次结构（自上而下）：
 *   ① 首屏：一个大标题 + 一个检索框 + 常见检索 + 「没找到？直接问 AI →」（跳到 /chat 页）
 *   ── 分隔线（.hero::after，用户明确要求保留）──
 *   ② 项目简介（原「关于项目」页第一、二段；第三段「本站是公众唯一的入口…」用户说太绝对，未取）
 *      末尾带「合作与共建」小块：一句合作说明 + 联系方式 / 邮箱 / 地址三行
 *   ③ 关于基金会（原「关于项目」页的 #foundation 板块，文案一字未改）
 *   ④ 资料分布（原 /insights 页的统计，收成一张「按主题领域」的横条图）
 *   ⑤ 引用与转载（原「关于项目」页的 #cite 板块，4 条规则一字未改）
 *
 * 随之删掉：数据条、最近收录 3 张卡、找资料整块、AI 问答整宽带、右下角 AI 悬浮挂件
 * （HomeAskWidget 不再在本页挂载；组件文件保留，未删）。
 *
 * ⚠️ 三处写作纪律（沿用 AboutView 的页头约定）：
 *   1. 只写能核实的事实；基金会对外口径（成立时间、电话等）未经确认一律不写、不编造。
 *   2. 所有数字动态取（`getOverview()`），取不到显示「—」或留空，绝不把某个数字写死在页面上。
 *   3. 联系方式三行由**管理台「机构信息」页**填写（2026-10-19 已接通）：
 *      数据来自公开只读接口 `GET /api/site-info`，空值继续显示「待补充」，
 *      这里不做任何默认值兜底 —— 那是基金会的对外口径，宁可空着也不能编。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import { getOverview } from '../api/overview'
import { fetchSiteInfo } from '../api/site'
import { DEFAULT_COOPERATION } from '../constants/site-defaults'
import type { DocOverview } from '../api/types'
import { formatCount } from '../utils/format'

const router = useRouter()
const keyword = ref('')

function onSearch(): void {
  const q = keyword.value.trim()
  void router.push(q ? { path: '/shelf', query: { q } } : { path: '/shelf' })
}

/** 常见检索走资料库，并把筛选条件写进地址栏（可分享、可收藏） */
function goShelf(query: Record<string, string>): void {
  void router.push({ path: '/shelf', query })
}

const HOT_TERMS = ['零废弃', '垃圾分类', '塑料', '无废城市', '化学品']

/* ---------------- 机构信息（「合作与共建」区块用） ----------------
   2026-10-19：三行联系方式从管理台「机构信息」页读（`GET /api/site-info`，公开只读）。
   取不到或没填时**保持「待补充」**：这一块是对外口径，宁可空着也不编。 */

const siteInfo = ref<Record<string, string>>({})

/** 合作说明：机构填了就用填的，没填沿用默认那句（默认值来自 constants/site-defaults） */
const coopText = computed(() => {
  const v = (siteInfo.value.cooperation ?? '').trim()
  return v || DEFAULT_COOPERATION
})

/** 三行联系信息：label 固定，value 空则前端显示「待补充」 */
const contactRows = computed(() => [
  { key: 'contact', label: '联系方式', value: (siteInfo.value.contact ?? '').trim() },
  { key: 'email', label: '邮箱', value: (siteInfo.value.email ?? '').trim() },
  { key: 'address', label: '地址', value: (siteInfo.value.address ?? '').trim() }
])

async function loadSiteInfo(): Promise<void> {
  try {
    const res = await fetchSiteInfo()
    siteInfo.value = res.info ?? {}
  } catch {
    // 拿不到就当作全空（页面显示「待补充」），不弹错、不挡首页其它内容
  }
}

/* ---------------- 整库概览（只有分布图在用） ---------------- */

const overview = ref<DocOverview | null>(null)
const overviewFailed = ref(false)

async function loadHome(): Promise<void> {
  try {
    overview.value = await getOverview()
  } catch {
    // 统计挂了不该把整页拖垮：图那一块自己显示一句话，其余内容照常
    overviewFailed.value = true
  }
}

/**
 * 分布图取前 6 个大类，其余全部并成「其他」。
 *
 * 用户要求：「只为美观，取几个大类，剩下的归为其他一类，然后在下面小字标明其他有什么什么类。」
 * 所以「其他」那一行必须配一行小字把成员列出来 —— 否则「其他」是个黑箱，
 * 想按主题找资料的人会以为库里没有这些类。
 */
const CHART_TOP_N = 6

const topicBars = computed<{ value: string; count: number; width: string; rest: boolean }[]>(() => {
  const all = [...(overview.value?.topics ?? [])].sort((a, b) => b.count - a.count)
  if (all.length === 0) return []

  const rows = all.slice(0, CHART_TOP_N).map((t) => ({ value: t.value, count: t.count, rest: false }))
  const rest = all.slice(CHART_TOP_N)
  if (rest.length > 0) {
    rows.push({ value: '其他', count: rest.reduce((sum, t) => sum + t.count, 0), rest: true })
  }

  const max = Math.max(...rows.map((r) => r.count), 1)
  return rows.map((r) => ({ ...r, width: `${Math.max(2, Math.round((r.count / max) * 100))}%` }))
})

/** 并入「其他」的主题名（按份数降序），写在图下小字里 */
const restTopics = computed(() =>
  [...(overview.value?.topics ?? [])]
    .sort((a, b) => b.count - a.count)
    .slice(CHART_TOP_N)
    .map((t) => t.value)
)

/** 「其他」那一行的份数合计（小字里要报数） */
const restCount = computed(() => topicBars.value.find((b) => b.rest)?.count ?? 0)

/* ---------------- 关于基金会（文案与交互沿用原 AboutView 的 #foundation） ---------------- */

/** 基金会官网地址（2026-10-13 由用户确认填入） */
const FOUNDATION_SITE = 'https://www.lcx-foundation.org.cn/'

/**
 * 弹窗左侧的装饰图案：站点绿三色（深绿/浅绿/墨绿）组成的双色叶片。
 * 用内联 SVG 而不是图标库——`@element-plus/icons-vue` 不在依赖里，为一个图案装一整个库不值当。
 */
const LEAF_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M12 20.5c0-6.2 3.4-10.4 8.5-11.2-.6 7-4.4 10.6-8.5 11.2Z" fill="#2e7d32" />
  <path d="M12 20.5C7.9 19.9 4.1 16.3 3.5 9.3c5.1.8 8.5 5 8.5 11.2Z" fill="#66bb6a" />
  <path d="M12 20.5V10.2" stroke="#1b5e20" stroke-width="1.5" stroke-linecap="round" />
</svg>`

/**
 * 详情查看 —— 先弹确认框，用户点「确认前往」才离开本页。
 * 弹窗内容用内联样式：ElMessageBox 挂到 body 上，页面里的 scoped 样式管不到它。
 */
async function openFoundationSite(): Promise<void> {
  const hasLink = FOUNDATION_SITE.length > 0
  const sub = hasLink ? '将在新标签页打开，本站页面不会关闭。' : '官网链接待基金会确认，确认后暂不跳转。'
  const html = `<div style="display:flex;align-items:center;gap:14px;text-align:left;">
  <span style="flex:none;width:46px;height:46px;border-radius:15px;background:#e9f3e9;display:flex;align-items:center;justify-content:center;">${LEAF_SVG}</span>
  <div style="min-width:0;">
    <p style="margin:0;font-size:15px;font-weight:600;color:#16241a;line-height:1.6;">即将跳转至安徽省六尺巷慈善基金会官网</p>
    <p style="margin:4px 0 0;font-size:13px;color:#66786a;line-height:1.6;">${sub}</p>
  </div>
</div>`

  try {
    await ElMessageBox({
      title: '跳转确认',
      message: html,
      dangerouslyUseHTMLString: true,
      showCancelButton: true,
      confirmButtonText: '确认前往',
      cancelButtonText: '取消'
    })
  } catch {
    return // 取消：关闭弹窗，停留在本页
  }

  if (!hasLink) {
    ElMessage.info('基金会官网链接待确认，暂不能跳转')
    return
  }
  window.open(FOUNDATION_SITE, '_blank', 'noopener,noreferrer')
}

onMounted(() => {
  void loadHome()
  // 机构信息独立于统计：统计挂了不影响这三行，反之亦然
  void loadSiteInfo()
})
</script>

<template>
  <div class="home">
    <!-- ① 首屏：一个输入框，两个动作 -->
    <section class="hero">
      <p class="zw-eyebrow">六尺巷基金会 · 零废弃知识库</p>
      <h1>把零废弃的知识<br />整理成每个人都能用的<span class="hl">资料库</span></h1>
      <p class="hero-lead">收录政策法规、研究报告、标准规范与实践工具，条目可溯源。</p>

      <div class="search-row">
        <el-input
          v-model="keyword"
          class="search-input"
          size="large"
          placeholder="输入关键词，如「塑料污染」「垃圾分类」"
          clearable
          @keyup.enter="onSearch"
        >
          <template #prefix>
            <span class="search-icon">🔍</span>
          </template>
        </el-input>
        <el-button type="primary" size="large" class="search-btn" @click="onSearch">检索</el-button>
      </div>

      <!-- AI 入口紧跟搜索框：悬浮挂件已撤（2026-10-18），这里改成直接进 AI 问答页 -->
      <RouterLink to="/chat" class="ask-inline">没找到？直接问 AI →</RouterLink>

      <div class="hot-terms">
        <span class="hot-label">常见检索：</span>
        <button
          v-for="t in HOT_TERMS"
          :key="t"
          type="button"
          class="hot-chip"
          @click="goShelf({ tag: t })"
        >
          {{ t }}
        </button>
      </div>
    </section>

    <!-- 分隔线以下：原「关于项目」页的四栏，2026-10-18 整页搬来首页 -->
    <div class="about-blocks">
      <!-- ② 项目简介（前两段）+ 合作与共建 -->
      <section id="intro" class="block">
        <div class="panel">
          <h2 class="zw-h2 panel-title">项目简介</h2>

          <p class="intro-lead">
            零废弃知识库把散落在各部门、各机构、各语种里的零废弃资料汇集到一处：
            政策法规、研究报告、标准规范、实践工具与科学认知，统一标注发布机构、发布年份、
            资料类型与主题领域，供检索与查阅。
          </p>
          <p class="intro-body">
            建设这个库的出发点很直接——关心零废弃议题的人（社区工作者、社会组织从业者、
            研究者、学生、企业环境管理人员）常常知道「有这份文件」，却不知道怎么找到它。
            我们把「找资料」这一步做掉，把资料本身留给使用者判断。
          </p>

          <ul class="intro-points">
            <li>统一标注发布机构、年份、类型与主题</li>
            <li>把「找资料」这一步做掉</li>
            <li>资料本身留给使用者判断</li>
          </ul>

          <!-- 合作与共建：原「关于基金会」里的「合作说明」，按用户要求改名并搬到本栏 -->
          <div id="coop" class="coop">
            <h3>合作与共建</h3>
            <p>{{ coopText }}</p>

            <!-- 联系方式三行：2026-10-19 起由管理台「机构信息」页填写。
                 没填的行显示「待补充」—— 这里不做任何默认值兜底，避免把假口径当成机构口径。 -->
            <ul class="contact">
              <li v-for="row in contactRows" :key="row.key">
                <span class="ct-label">{{ row.label }}</span>
                <span class="ct-value" :class="{ 'is-todo': !row.value }">
                  {{ row.value || '待补充' }}
                </span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <!-- ③ 关于基金会 -->
      <section id="foundation" class="block">
        <div class="panel">
          <h2 class="zw-h2 panel-title">关于基金会</h2>

          <div class="fund-body">
            <p class="fund-org">安徽省六尺巷慈善基金会</p>

            <div class="fund-item">
              <h3>基金会简介</h3>
              <p>
                以「六尺巷」包容礼让的文化精神为内核，立足公益慈善领域，围绕生态环保、社区发展、
                公益人才培育等方向开展公益项目，推动知识共享、行业协作与可持续公益生态建设。
              </p>
            </div>

            <div class="fund-item">
              <h3>与知识库的关系</h3>
              <p>
                零废弃知识库是安徽省六尺巷慈善基金会建设的公开知识平台，面向环保、公益及相关领域
                工作人员，提供资料查询、案例参考、知识学习与行业交流支持。
              </p>
            </div>

            <div class="fund-item">
              <h3>机构宗旨</h3>
              <p class="fund-motto">
                传承礼让精神，践行公益使命；凝聚多方力量，共建可持续的公益生态。
              </p>
            </div>

            <div class="fund-item">
              <h3>核心方向</h3>
              <ul class="fund-list">
                <li>生态环保与零废弃项目推广</li>
                <li>社区公益建设</li>
                <li>公众环境教育</li>
                <li>公益行业人才赋能</li>
                <li>知识共享与行业协作</li>
              </ul>
            </div>

            <div class="fund-actions">
              <el-button link type="primary" @click="openFoundationSite">详情查看</el-button>
            </div>
          </div>
        </div>
      </section>

      <!-- ④ 资料分布（原 /insights 的统计，收成一张图） -->
      <section id="distribution" class="block">
        <div class="panel">
          <h2 class="zw-h2 panel-title">资料分布</h2>

          <p class="chart-sub">
            按主题领域 <template v-if="overview">· 共 {{ formatCount(overview.total) }} 份资料</template>
          </p>

          <el-skeleton v-if="!overview && !overviewFailed" :rows="4" animated />

          <p v-else-if="overviewFailed" class="chart-empty">
            暂时取不到统计数据，稍后再看；资料本身仍可在<RouterLink to="/shelf">资料库</RouterLink>检索。
          </p>

          <template v-else>
            <ul class="bar-list">
              <li v-for="b in topicBars" :key="b.value">
                <span class="bar-name" :title="b.value">{{ b.value }}</span>
                <span class="bar-track">
                  <span
                    class="bar-fill"
                    :class="{ 'is-rest': b.rest }"
                    :style="{ width: b.width }"
                  />
                </span>
                <span class="bar-value zw-num">{{ formatCount(b.count) }}</span>
              </li>
            </ul>

            <!-- 「其他」是个合并项，必须把成员列出来，否则等于把 11 个主题藏了 -->
            <p v-if="restTopics.length > 0" class="chart-note">
              「其他」= {{ restTopics.join('、') }}（共 {{ formatCount(restCount) }} 份）
            </p>
          </template>

          <p class="chart-foot">
            一份资料可同时归属多个主题，故各主题合计大于总份数。
            完整筛选与全部主题见<RouterLink to="/shelf">资料库</RouterLink>。
          </p>
        </div>
      </section>

      <!-- ⑤ 引用与转载 -->
      <section id="cite" class="block">
        <div class="panel">
          <h2 class="zw-h2 panel-title">引用与转载</h2>
          <div class="prose">
            <p>
              本站收录的资料均为公开出版物、政府公开文件或公开发布的研究报告，
              <strong>著作权归原作者与发布机构所有</strong>。本站做的是汇集、标注与索引，不做再授权。
            </p>
            <ul class="rules">
              <li>引用本站收录的资料时，请注明<strong>原始发布机构与资料名称</strong>，而不是「引自零废弃知识库」。</li>
              <li>下载原件后用于研究、教学或公益传播，请遵循该资料自身的授权条款。</li>
              <li>如权利人认为某份资料不宜在本站收录，请联系我们，我们核实后会下架。</li>
              <li>本站的检索结果与 AI 回答由系统依据库内资料生成，仅供检索参考，<strong>不构成任何形式的专业意见</strong>。</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
}

/* ---------------- ① 首屏 ---------------- */

.hero {
  position: relative;
  padding: 32px 0 26px;
  max-width: 780px;
  margin: 0 auto;
  text-align: center;
}

/* 首屏与下方内容之间的分隔线（2026-10-13 加强；本次改版按用户要求保留，未动）。
   比全局默认的 --zw-line 明显得多：2px、中段落到深绿、两端渐隐。 */
.hero::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--zw-green-soft) 22%,
    var(--zw-green-deep) 50%,
    var(--zw-green-soft) 78%,
    transparent
  );
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
  font-family: 'Songti SC', 'Source Han Serif SC', 'Noto Serif SC', 'SimSun', 'STSong', Georgia,
    'Times New Roman', serif;
  font-size: 17px;
  line-height: 2.1;
  letter-spacing: 0.01em;
  color: var(--zw-green-deep);
  margin: 0 auto 26px;
  max-width: 100%;
}

.search-row {
  display: flex;
  gap: 10px;
  max-width: 640px;
  margin: 0 auto;
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

/* 搜索框正下方的 AI 入口：不大，但要一眼看见（2026-10-18 起是站内链接，不再是按钮） */
.ask-inline {
  display: inline-flex;
  align-items: center;
  margin-top: 14px;
  padding: 8px 20px;
  font-size: 14px;
  font-weight: 600;
  color: var(--zw-green-deep);
  background: var(--zw-mint);
  border: 1px solid var(--zw-green-soft);
  border-radius: 999px;
  text-decoration: none;
  transition:
    color 0.16s ease,
    border-color 0.16s ease,
    background 0.16s ease;
}

.ask-inline:hover {
  border-color: var(--zw-green);
  background: #fff;
}

.hot-terms {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
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

/* ---------------- 分隔线以下的「关于」四栏（样式沿用原 AboutView 的卡片语言） ---------------- */

.about-blocks {
  max-width: 860px;
  width: 100%;
  margin: 0 auto;
  padding-top: 44px;
  --about-glow: rgba(46, 125, 50, 0.09);
}

.block {
  margin-top: 24px;
  scroll-margin-top: 110px;
}

/* 首栏不用再压一条顶线（上面就是首屏的分隔线） */
.block:first-child {
  margin-top: 0;
}

/* 板块之间一条极淡、两端渐隐的绿色细分隔线 */
.block + .block::before {
  content: '';
  display: block;
  height: 1px;
  width: 100%;
  margin: -13px 0 13px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--zw-line-strong) 22%,
    var(--zw-line-strong) 78%,
    transparent
  );
  opacity: 0.75;
}

.panel {
  position: relative;
  background-color: var(--zw-surface);
  background-image: radial-gradient(circle at 50% 50%, var(--about-glow), transparent 72%);
  background-repeat: no-repeat;
  background-position: center;
  background-size: 0% 0%;
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius-lg);
  box-shadow: var(--zw-shadow-sm);
  padding: 26px 28px;
  transition:
    background-size 0.45s cubic-bezier(0.22, 0.61, 0.36, 1),
    box-shadow 0.22s ease,
    border-color 0.22s ease;
}

.panel:hover {
  background-size: 150% 150%;
  box-shadow: var(--zw-shadow);
  border-color: var(--zw-line-strong);
}

.panel-title {
  color: var(--zw-green-deep);
  margin: 0 0 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--zw-line);
}

/* ---------------- ② 项目简介 ---------------- */

/* 第一段比正文大一档：它是整页的「这是什么」，值得被先读到 */
.intro-lead {
  margin: 0 0 14px;
  font-size: 16px;
  line-height: 1.95;
  color: var(--zw-ink);
}

.intro-body {
  margin: 0 0 16px;
  font-size: 15px;
  line-height: 1.95;
  color: var(--zw-text);
}

/* 三个要点：从上面两段里抽出来的短句，排成一行标签，扫一眼就够 */
.intro-points {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.intro-points li {
  font-size: 13px;
  color: var(--zw-ink);
  background: var(--zw-mint);
  border-radius: 999px;
  padding: 5px 14px;
}

/* 合作与共建：本栏的收尾小块 */
.coop {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--zw-line);
  scroll-margin-top: 110px;
}

.coop h3 {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--zw-green-deep);
}

.coop p {
  margin: 0 0 14px;
  font-size: 14px;
  line-height: 1.9;
  color: var(--zw-text);
}

/* 联系方式三行：标签固定宽，三条值左对齐成一条竖线 */
.contact {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.contact li {
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-size: 14px;
}

.ct-label {
  flex: none;
  width: 72px;
  color: var(--zw-muted);
}

.ct-value {
  color: var(--zw-text);
}

/* 占位值：虚线下划线 + 浅字，一眼能看出「这里还没填」，不像正式对外信息 */
.ct-value.is-todo {
  color: var(--zw-faint);
  border-bottom: 1px dashed var(--zw-line-strong);
  padding-bottom: 1px;
}

/* ---------------- ③ 关于基金会 ---------------- */

.fund-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.fund-org {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: var(--zw-green-ink);
  letter-spacing: 0.01em;
}

.fund-item h3 {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 700;
  color: var(--zw-green-deep);
}

.fund-item p {
  margin: 0;
  font-size: 14px;
  line-height: 1.9;
  color: var(--zw-text);
}

.fund-motto {
  background: var(--zw-mint-2);
  border-left: 3px solid var(--zw-green-soft);
  border-radius: 0 var(--zw-radius-sm) var(--zw-radius-sm) 0;
  padding: 12px 16px;
  color: var(--zw-ink);
}

.fund-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.fund-list li {
  font-size: 13px;
  color: var(--zw-ink);
  background: var(--zw-mint);
  border-radius: 999px;
  padding: 5px 14px;
}

.fund-actions {
  padding-top: 14px;
  border-top: 1px solid var(--zw-line);
}

.fund-actions :deep(.el-button) {
  font-size: 14px;
  padding: 4px 12px;
  border-radius: 999px;
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}

.fund-actions :deep(.el-button:hover) {
  color: var(--zw-green-deep);
  background: var(--zw-mint);
}

/* ---------------- ④ 资料分布图 ---------------- */

.chart-sub {
  margin: 0 0 18px;
  font-size: 14px;
  color: var(--zw-muted);
}

.chart-empty {
  margin: 0;
  font-size: 14px;
  color: var(--zw-muted);
}

/* 横条榜：名称 | 条 | 数字。名称列定宽，条长按最大值的百分比算（见 topicBars） */
.bar-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.bar-list li {
  display: grid;
  grid-template-columns: 140px 1fr 52px;
  align-items: center;
  gap: 12px;
}

.bar-name {
  font-size: 14px;
  color: var(--zw-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-track {
  height: 12px;
  border-radius: 999px;
  background: var(--zw-mint-2);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--zw-green-soft), var(--zw-green-deep));
}

/* 「其他」用中性浅灰：一眼能看出它不是某一个真实主题 */
.bar-fill.is-rest {
  background: var(--zw-faint);
}

.bar-value {
  font-size: 14px;
  color: var(--zw-green-deep);
  text-align: right;
}

.chart-note {
  margin: 16px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--zw-muted);
}

.chart-foot {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--zw-faint);
}

.chart-foot a,
.chart-empty a {
  color: var(--zw-green-deep);
  text-decoration: none;
}

.chart-foot a:hover,
.chart-empty a:hover {
  text-decoration: underline;
}

/* ---------------- ⑤ 引用与转载 ---------------- */

.prose p {
  font-size: 15px;
  line-height: 1.95;
  color: var(--zw-text);
  margin: 0 0 14px;
}

.prose p:last-child {
  margin-bottom: 0;
}

.prose strong {
  color: var(--zw-ink);
}

.rules {
  margin: 10px 0 0;
  padding-left: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.rules li {
  position: relative;
  padding-left: 22px;
  font-size: 14px;
  line-height: 1.85;
  color: var(--zw-text);
}

.rules li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 9px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--zw-green-soft);
  box-shadow: 0 0 0 3px rgba(102, 187, 106, 0.16);
}

/* ---------------- 窄屏 ---------------- */

@media (max-width: 640px) {
  .hero h1 {
    font-size: 27px;
  }

  .hero-lead {
    font-size: 15px;
    line-height: 2;
  }

  .search-row {
    flex-direction: column;
  }

  .search-btn {
    width: 100%;
  }

  .about-blocks {
    padding-top: 30px;
  }

  .panel {
    padding: 20px 18px;
  }

  .bar-list li {
    grid-template-columns: 88px 1fr 44px;
    gap: 8px;
  }

  .bar-name {
    font-size: 13px;
  }

  .ct-label {
    width: 64px;
  }
}
</style>
