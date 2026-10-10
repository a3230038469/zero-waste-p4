<script setup lang="ts">
/**
 * 关于项目 —— 新增页（2026-10-10）
 *
 * 对外展示站必须有一页把「这是谁做的、数据哪来的、能不能引用、怎么找我们」讲清楚。
 *
 * ⚠️ 写作纪律（很重要）：
 *   本页只写**能核实的事实**。数字来自 GET /api/overview（真实统计），
 *   项目定位来自仓库内的既定描述，引用规则来自公开资料的通行做法。
 *   凡属基金会对外口径的部分（机构使命、成立时间、地址、电话、邮箱等）一律留
 *   `待基金会确认` 占位块，**不编造**。理由：对外网站一旦印上假信息，是对方要承担的后果。
 */
import { computed, onMounted, ref } from 'vue'
import { getOverview } from '../api/overview'
import type { DocOverview } from '../api/types'
import { formatBytes, formatCount, formatYearSpan } from '../utils/format'

const overview = ref<DocOverview | null>(null)

onMounted(() => {
  void getOverview().then((data) => {
    overview.value = data
  })
})

const facts = computed(() => {
  const d = overview.value
  return [
    { label: '收录资料', value: d ? `${formatCount(d.total)} 份` : '—' },
    { label: '资料体积', value: d ? formatBytes(d.totalBytes) : '—' },
    { label: '覆盖年份', value: d ? formatYearSpan(d.yearRange) : '—' },
    { label: '发布机构', value: d ? `${formatCount(d.orgCount)} 家` : '—' },
    { label: '资料类型', value: d ? `${d.typeCount} 类` : '—' },
    { label: '主题领域', value: d ? `${d.topicCount} 类` : '—' }
  ]
})

/** 目录锚点 */
const SECTIONS = [
  { id: 'about', label: '项目简介' },
  { id: 'use', label: '怎么用' },
  { id: 'data', label: '数据来源与口径' },
  { id: 'cite', label: '引用与转载' },
  { id: 'contact', label: '联系与共建' }
]
</script>

<template>
  <div class="about">
    <header class="page-head">
      <p class="zw-eyebrow">关于项目</p>
      <h1>零废弃知识库</h1>
      <p class="zw-sub">
        由六尺巷基金会建设并面向公众开放的知识库，收录零废弃与废弃物管理领域的公开资料。
      </p>
    </header>

    <nav class="anchor-nav" aria-label="本页目录">
      <a v-for="s in SECTIONS" :key="s.id" :href="`#${s.id}`">{{ s.label }}</a>
    </nav>

    <!-- 项目简介 -->
    <section id="about" class="block">
      <h2 class="zw-h2">项目简介</h2>
      <div class="prose">
        <p>
          零废弃知识库把散落在各部门、各机构、各语种里的零废弃资料汇集到一处：
          政策法规、研究报告、标准规范、实践工具与科学认知，统一标注发布机构、发布年份、
          资料类型与主题领域，供检索与查阅。
        </p>
        <p>
          建设这个库的出发点很直接——关心零废弃议题的人（社区工作者、社会组织从业者、
          研究者、学生、企业环境管理人员）常常知道「有这份文件」，却不知道怎么找到它。
          我们把「找资料」这一步做掉，把资料本身留给使用者判断。
        </p>
        <p>
          本站是公众唯一的入口：可以按主题与类型浏览、用关键词检索、在线预览或下载原件，
          也可以直接向 AI 助手提问，由它从库中检索内容作答。
        </p>
      </div>

      <div class="fact-grid">
        <div v-for="f in facts" :key="f.label" class="fact zw-card">
          <span class="fact-label">{{ f.label }}</span>
          <span class="fact-value zw-num">{{ f.value }}</span>
        </div>
      </div>
      <p class="hint">以上为知识库实时统计，口径见<a href="#data">数据来源与口径</a>。</p>
    </section>

    <!-- 怎么用 -->
    <section id="use" class="block">
      <h2 class="zw-h2">怎么用</h2>
      <div class="use-grid">
        <div class="use-card zw-card zw-card--pad">
          <h3>① 按主题浏览</h3>
          <p>从首页的主题入口进入，例如「塑料」「垃圾分类」「无废城市」，直接看这个议题下的全部资料。</p>
        </div>
        <div class="use-card zw-card zw-card--pad">
          <h3>② 四维筛选</h3>
          <p>在资料库里按<strong>机构 / 年份 / 主题 / 类型</strong>组合筛选，下拉项会实时显示命中数量。</p>
        </div>
        <div class="use-card zw-card zw-card--pad">
          <h3>③ 关键词检索</h3>
          <p>按资料名称或文件名检索；没有命中时会提示，并可一键转去问 AI。</p>
        </div>
        <div class="use-card zw-card zw-card--pad">
          <h3>④ 直接提问</h3>
          <p>右下角 AI 助手从知识库检索内容作答。<strong>访客无需注册即可提问</strong>。</p>
        </div>
      </div>
      <p class="hint">
        在线预览与下载原件需要登录（用于了解资料被谁使用、也便于回访需求）；
        如需批量获取或用于教学，请见<a href="#contact">联系与共建</a>。
      </p>
    </section>

    <!-- 数据来源与口径 -->
    <section id="data" class="block">
      <h2 class="zw-h2">数据来源与口径</h2>
      <div class="prose">
        <p>
          知识库的条目来自基金会自身的资料台账与对应的资料原件，逐条核对后入库。
          每条记录含：<strong>资料名称、发布机构、发布年份、资料类型、主题领域、文件体积</strong>。
        </p>
      </div>

      <div class="table-wrap zw-card">
        <table>
          <caption class="sr-only">数据字段与口径说明</caption>
          <thead>
            <tr>
              <th scope="col">字段</th>
              <th scope="col">口径</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>资料份数</td>
              <td>
                按<strong>文件份数</strong>计，不按台账行数。台账中一行可能挂着 2–3 个附件，
                统计时按文件算。
              </td>
            </tr>
            <tr>
              <td>发布年份</td>
              <td>
                取资料标注的发布年份。台账未填年份的资料会标注为「年份不详」，
                不参与年份分布统计（当前 {{ overview ? overview.yearUnknown : '—' }} 份）。
              </td>
            </tr>
            <tr>
              <td>主题领域</td>
              <td>
                按议题归类。一份资料可同时归属多个主题；化学品子库因原始台账未标注领域，
                已按子库归属统一标注。
              </td>
            </tr>
            <tr>
              <td>重复副本</td>
              <td>
                库中存在内容完全相同的资料（按文件逐字节比对判定，当前
                {{ overview ? overview.duplicateGroups : '—' }} 组
                {{ overview ? overview.duplicateCopies : '—' }} 份），
                资料卡片上会标注「另有相同副本」。是否撤下重复件待确认，暂以原文保留。
              </td>
            </tr>
            <tr>
              <td>资料来源链接</td>
              <td>
                部分资料可在详情页看到原始出处链接；原始台账未登记链接的，详情页不显示该字段，
                而不做推测填写。
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="hint">
        本页统计与资料库同源，均为知识库实时数据。若发现某条记录与原件不符，欢迎按
        <a href="#contact">联系与共建</a>中的方式反馈。
      </p>
    </section>

    <!-- 引用与转载 -->
    <section id="cite" class="block">
      <h2 class="zw-h2">引用与转载</h2>
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
    </section>

    <!-- 联系与共建 -->
    <section id="contact" class="block">
      <h2 class="zw-h2">联系与共建</h2>
      <div class="prose">
        <p>
          我们欢迎三类反馈：<strong>资料推荐</strong>（有值得收录的公开资料）、
          <strong>纠错</strong>（条目信息与原件不符）、<strong>合作</strong>（教学、研究或公益项目协作）。
        </p>
      </div>

      <!-- ⚠️ 占位：以下属于基金会对外口径，未确认前不填内容 -->
      <div class="todo zw-card zw-card--pad">
        <h3>待基金会确认后补充（占位）</h3>
        <ul>
          <li>机构简介与使命表述（官方口径）</li>
          <li>公开联系邮箱 / 电话 / 办公地址</li>
          <li>资料推荐与纠错的具体受理方式（表单或邮箱）</li>
          <li>合作与数据使用申请流程</li>
        </ul>
        <p class="todo-note">
          这些内容属于基金会的对外表述，需由基金会确认后方可上线，因此本页暂不填写，
          以免对外发布未经确认的信息。
        </p>
      </div>
    </section>

    <p class="updated">本页口径说明最后更新于 2026-10-10。</p>
  </div>
</template>

<style scoped>
.about {
  max-width: 860px;
  margin: 0 auto;
}

.page-head {
  padding: 12px 0 4px;
}

.page-head h1 {
  font-size: 34px;
  margin: 0 0 12px;
}

.anchor-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 22px 0 6px;
  padding: 12px 0;
  border-top: 1px solid var(--zw-line);
  border-bottom: 1px solid var(--zw-line);
  position: sticky;
  top: 64px;
  background: rgba(244, 248, 244, 0.9);
  backdrop-filter: blur(8px);
  z-index: 5;
}

.anchor-nav a {
  font-size: 13px;
  color: var(--zw-muted);
  text-decoration: none;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid transparent;
}

.anchor-nav a:hover {
  color: var(--zw-green-deep);
  background: #fff;
  border-color: var(--zw-line);
}

.block {
  padding: 34px 0 6px;
  scroll-margin-top: 110px;
}

.prose p {
  font-size: 15px;
  line-height: 1.95;
  color: var(--zw-text);
  margin: 0 0 14px;
}

.prose strong {
  color: var(--zw-ink);
}

/* 事实格 */
.fact-grid {
  display: grid;
  /* 120px 是为了在 860 版心下正好排成一行 6 格 */
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
  margin: 20px 0 10px;
}

.fact {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
}

.fact-label {
  font-size: 12px;
  color: var(--zw-muted);
}

.fact-value {
  font-size: 19px;
  font-weight: 700;
  color: var(--zw-green-deep);
}

/* 用法卡 */
.use-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin: 16px 0 12px;
}

.use-card h3 {
  margin: 0 0 8px;
  font-size: 15px;
  color: var(--zw-green-deep);
}

.use-card p {
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--zw-text);
}

/* 表格 */
.table-wrap {
  overflow-x: auto;
  margin: 16px 0 12px;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

th,
td {
  text-align: left;
  padding: 13px 18px;
  vertical-align: top;
  line-height: 1.8;
  border-bottom: 1px solid var(--zw-line);
}

th {
  font-size: 13px;
  color: var(--zw-green-deep);
  background: var(--zw-mint-2);
  white-space: nowrap;
}

tbody tr:last-child td {
  border-bottom: 0;
}

td:first-child {
  white-space: nowrap;
  color: var(--zw-ink);
  font-weight: 600;
}

/* 规则 */
.rules {
  margin: 8px 0 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rules li {
  font-size: 14px;
  line-height: 1.85;
  color: var(--zw-text);
}

/* 提示与占位 */
.hint {
  font-size: 13px;
  line-height: 1.8;
  color: var(--zw-muted);
  background: var(--zw-mint-2);
  border-left: 3px solid var(--zw-green-soft);
  border-radius: 0 var(--zw-radius-sm) var(--zw-radius-sm) 0;
  padding: 10px 14px;
  margin: 12px 0 0;
}

.todo {
  margin-top: 16px;
  border-style: dashed;
  background: #fffdf7;
}

.todo h3 {
  margin: 0 0 10px;
  font-size: 15px;
  color: var(--zw-amber);
}

.todo ul {
  margin: 0 0 10px;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.todo li {
  font-size: 13px;
  color: var(--zw-text);
}

.todo-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--zw-faint);
}

.updated {
  margin: 34px 0 12px;
  font-size: 12px;
  color: var(--zw-faint);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (max-width: 640px) {
  .page-head h1 {
    font-size: 26px;
  }

  .use-grid {
    grid-template-columns: 1fr;
  }

  .anchor-nav {
    top: 96px;
  }
}
</style>
