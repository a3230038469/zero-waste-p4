<script setup lang="ts">
/**
 * 资料卡片 —— 通用组件（2026-10-10 新增；2026-10-18 加卡片级「预览 / 下载」；
 * 2026-10-18 换新版式与配色 —— 「方案一 + 丁」）
 *
 * 首页「最近收录」、资料库列表、详情页「同主题推荐」都用同一张卡片，
 * 避免三个页面各写一套、字段与样式慢慢长歪。
 *
 * 2026-10-18 的结构改动（为什么根节点从 RouterLink 换成了 article）：
 *   以前整张卡就是一个 <RouterLink>，往里塞 <button> 就成了「链接里套按钮」——
 *   HTML 不合法，点按钮会连带跳页，键盘用户也分不清焦点在哪。
 *   现在卡片是外壳（article），里面「内容区」仍是 RouterLink（保留新窗口打开、
 *   键盘 Tab、右键「在新窗口打开」），「预览 / 下载」两个按钮放在内容区之外。
 *
 * 为什么按钮要做在这张卡上：全站原先只有详情页一个预览入口，而用户最想预览的
 * 位置恰恰是卡片本身 —— 多一次点击就多一层流失。取文件的门槛判断（登录 /
 * 游客开关 / 大文件）统一走 useDocActions，卡片这块只负责长相。
 *
 * 2026-10-18 晚的改版（用户当面挑选，改动都在长相上，字段与门槛判断一律没动）：
 *   1. 配色改「丁」：**只按资料的两个方向上色**（绿=零废弃 / 青=化学品与健康），
 *      资料类型不再上色 —— 8 种类型各一个颜色，一屏铺开像打翻的调色盘。
 *      类型只保留徽标里的文字（徽标本来就是中性的淡绿底）。
 *      方向取自接口的可选字段 `direction`（后端按 srcTable 映射，见《接口约定.md》）；
 *      老数据没有这一项时走中性灰，不猜。
 *   2. 版式改「方案一 · 档案卡」：色带从左侧 4px 挪到**顶部 3px 通栏**；
 *      体积行与「预览 / 下载」合并成**同一条操作行**（体积在左、按钮在右，上边一道细线），
 *      卡片因此更矮、一屏能多放一张。
 *   3. 机构名截断（`shortOrg`）：真实数据里联合发文的机构名能写满 118 个字，
 *      两行都放不下还把卡片撑得高低不齐；现在只留**第一个发布机构** + 一个省略号，
 *      文字右缘留一点余量，一排卡片才对得齐；完整原文仍挂在 `title` 上（鼠标悬停可见）。
 *   4. 卡片上原有的信息元素一个没减：类型徽标 / 年份 / 标题 / 机构 / 主题标签（含「+N」）/
 *      体积 /「另有相同副本」/「预览」/「下载」，以及整卡跳详情的信息区。
 *
 * 2026-10-18 深夜（用户拍板，预览入口收敛）：
 *   5. 卡片上的「预览」不再就地弹层 —— 改成**跳到详情页并带 `?preview=1`**，
 *      由详情页在本页展开预览区（全站只留一套预览实现，那个弹层组件已撤）。
 *      超 20 MB 的文件按钮置灰，并在详情页上提前写明规则；下载按钮行为不变。
 */
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'

import { isPdfTitle, LARGE_FILE_LIMIT } from '../api/docs'
import type { DocItem } from '../api/types'
import { useDocActions } from '../composables/useDocActions'
import { formatBytes, formatYear } from '../utils/format'

const props = withDefaults(defineProps<{ doc: DocItem; maxTags?: number; actions?: boolean }>(), {
  maxTags: 3,
  actions: true
})

const router = useRouter()

const { downloadingId, locked, initGuestPermissions, download } = useDocActions()

/** 卡片上最多展示几个主题标签，多出来的收成「+N」 */
const shownTags = computed(() => props.doc.tags.slice(0, props.maxTags))
const restTags = computed(() => Math.max(0, props.doc.tags.length - props.maxTags))

/** 下载原件对游客是关着的（需登录）——按钮上把这件事说在明处，不让人白点一下 */
const downloadLocked = computed(() => locked('download'))
const downloading = computed(() => downloadingId.value === props.doc.id)

/** 超过在线预览上限（20 MB）的文件：按钮置灰，别让人白点一下 */
const tooLarge = computed(() => props.doc.size > LARGE_FILE_LIMIT)

/**
 * 这份资料是不是 PDF（公-4）。
 * 非 PDF（.docx/.txt/.xlsx）浏览器里渲染不了，卡片上**不给预览按钮** ——
 * 之前只按体积判断，给了 .docx 预览按钮，点进去是一片空白或英文报错。
 */
const isPdfDoc = computed(() => isPdfTitle(props.doc.title))

/**
 * 卡片上的「预览」（2026-10-18 晚按用户拍板改）：
 * 不再就地弹层，而是**跳到详情页并带 `?preview=1`**，由详情页在本页展开预览区。
 * 这样全站只有一套预览实现（详情页那块），卡片只负责把读者送过去。
 */
function onPreview(): void {
  if (tooLarge.value) return
  if (!isPdfDoc.value) return
  if (locked('preview')) return
  void router.push({ path: `/doc/${props.doc.id}`, query: { preview: '1' } })
}

function onDownload(): void {
  void download(props.doc)
}

onMounted(() => {
  // 只读一次游客开关（模块级单例，整页几十张卡也只发一个请求）
  void initGuestPermissions()
})

/**
 * 方向 → 顶部色带（纯展示，数据的 `direction` 值不动）。
 * 只有两个方向上色，别的一律中性灰；拿不到方向时不猜、不按类型凑色。
 */
const DIR_CLASS: Record<string, string> = {
  零废弃: 'dir-zw',
  化学品与健康: 'dir-chem'
}

const dirClass = computed(() => DIR_CLASS[props.doc.direction ?? ''] ?? 'dir-none')

/**
 * 机构名截断（2026-10-18 晚第二版，用户原话「留一个就好了，留三个点」）：
 * 真数据里「A 委 B 部 C 局 …」联合发文能到 118 个字。第一版留前两个 + 「等」，
 * 结果两个长机构名照样把整行铺满、末尾再被 CSS 切一刀，看着脏。
 * 现在**只留第一个发布机构**，后面接一个省略号；文字右缘再留一点余量
 * （`.doc-org` 的 `padding-right`），让省略号不贴着卡片边，一排卡片才对得齐。
 * 完整名单没丢：`title` 上是全的（悬停可见），详情页照旧显示全文。
 */
function shortOrg(org: string): string {
  const raw = (org ?? '').trim()
  if (!raw) return ''
  // 2026-10-21（T3 · P2-1 / P3-8 / 公众-10）：
  //   之前**不管中英文**都按分隔符切，于是「World Bank」被切成「World…」
  //   （切在词中间），纯英文机构名看起来像被截断了。
  //   现在：只有含中日韩字符的机构名（中文联合发文「A 委 B 部 C 局…」）才切，
  //   纯拉丁机构名整体返回，末尾由 CSS 的 ellipsis 正常省略。
  if (!hasCjk(raw)) return raw
  const parts = raw.split(/[\s、,，;；/／]+/).filter(Boolean)
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts[0]}…`
}

/** 字符串里有没有中日韩字符（用来区分「中文联合发文」与「英文机构名」） */
function hasCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)
}
</script>

<template>
  <article class="doc-card" :class="dirClass">
    <RouterLink :to="`/doc/${doc.id}`" class="card-link">
      <div class="card-top">
        <span class="type-badge">{{ doc.type }}</span>
        <span class="year zw-num">{{ formatYear(doc.year) }}</span>
      </div>

      <h3 class="doc-title">{{ doc.title }}</h3>

      <p class="doc-org" :title="doc.org">{{ shortOrg(doc.org) }}</p>

      <div class="doc-tags">
        <span v-for="t in shownTags" :key="t" class="tag" :title="t">{{ t }}</span>
        <span v-if="restTags > 0" class="tag tag--rest">+{{ restTags }}</span>
      </div>
    </RouterLink>

    <!-- 体积与两个按钮合用一行：体积在左，按钮靠右，上边一道细线 -->
    <div class="card-foot">
      <span class="size zw-num">{{ formatBytes(doc.size) }}</span>
      <span v-if="doc.duplicateOf" class="dup-flag" title="这份资料与库中另一份内容完全相同">
        另有相同副本
      </span>

      <div v-if="actions" class="card-actions">
        <button
          v-if="isPdfDoc"
          type="button"
          class="act act--preview"
          :disabled="tooLarge || locked('preview')"
          :title="
            tooLarge
              ? `文件约 ${formatBytes(doc.size)}，超过在线预览上限，请下载原件查看`
              : locked('preview')
                ? '预览功能需要登录'
                : '在详情页里打开预览'
          "
          @click="onPreview"
        >
          预览
        </button>
        <button
          type="button"
          class="act act--download"
          :class="{ 'act--locked': downloadLocked }"
          :disabled="downloading"
          :title="downloadLocked ? '下载原件需登录（注册免费）' : `下载 ${formatBytes(doc.size)} 原件`"
          @click="onDownload"
        >
          {{ downloading ? '下载中…' : '下载' }}
        </button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.doc-card {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--zw-surface);
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  box-shadow: var(--zw-shadow-sm);
  overflow: hidden;
  transition:
    transform 0.22s ease,
    box-shadow 0.22s ease,
    border-color 0.22s ease;
}

/* 顶部通栏色带：只按方向（零废弃 / 化学品与健康）分色，扫一眼就能分出两条线的东西。
   2026-10-18 之前这条带子在左边、按 8 种资料类型分色 —— 用户原话「这样看起来很乱呀」。 */
.doc-card::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 3px;
  background: var(--dir, var(--zw-line-strong));
}

.doc-card:hover {
  transform: translateY(-3px);
  box-shadow: var(--zw-shadow);
  border-color: var(--zw-line-strong);
}

/* 悬停不再染类型色：颜色只留给方向那一条带子，卡片本身保持中性 */
.dir-zw {
  --dir: var(--zw-green);
}
.dir-chem {
  --dir: var(--zw-teal);
}
.dir-none {
  --dir: var(--zw-faint);
}

/* 内容区仍然是链接：新窗口打开 / 键盘 Tab / 右键菜单都照旧。
   flex:1 让它撑满卡片（卡片高度由网格拉伸对齐），底部的操作行才能贴着排齐。 */
.card-link {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 9px;
  padding: 17px 18px 12px;
  text-decoration: none;
  color: inherit;
}

.card-link:focus-visible {
  outline: 2px solid var(--zw-green);
  outline-offset: -2px;
}

.card-top {
  display: flex;
  align-items: center;
  gap: 10px;
}

.type-badge {
  font-size: 12px;
  font-weight: 600;
  color: var(--zw-green-deep);
  background: var(--zw-mint);
  border-radius: 999px;
  padding: 3px 10px;
}

.year {
  font-size: 12px;
  color: var(--zw-faint);
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.doc-title {
  margin: 0;
  font-size: 15.5px;
  line-height: 1.5;
  color: var(--zw-ink);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 机构行：单行、超长由 CSS 兜底切；右缘留 18px 余量，省略号不贴卡片边 */
.doc-org {
  margin: 0;
  padding-right: 18px;
  font-size: 13px;
  color: var(--zw-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.doc-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 22px;
}

.tag {
  font-size: 12px;
  color: var(--zw-teal);
  background: var(--zw-teal-soft);
  border-radius: 6px;
  padding: 2px 8px;
}

/* VI-02：标签 >6 字才会折行（实测第一屏 18 张卡全单行）——
   给标签加最大宽度 + ellipsis（全名在 title 上），保证同排卡片底缘永远整齐。 */
.tag {
  max-width: 132px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag--rest {
  color: var(--zw-muted);
  background: #f1f4f1;
}

/* ---------------- 体积 + 操作，同一行 ---------------- */

.card-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px 12px;
  border-top: 1px solid var(--zw-line);
  font-size: 12px;
  color: var(--zw-faint);
}

.size {
  font-variant-numeric: tabular-nums;
}

/* 重复副本徽标（QA-SHF-06）：amber #c8871f on soft #fdf3e0 ≈2.8:1 不达标，
   换深琥珀 --zw-amber-ink #8a5a12 ≈7:1（令牌本来就是为此建的）。 */
.dup-flag {
  color: var(--zw-amber-ink);
  background: var(--zw-amber-soft);
  border-radius: 6px;
  padding: 2px 8px;
}

.card-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.act {
  font: inherit;
  font-size: 12.5px;
  line-height: 1.2;
  padding: 6px 12px;
  border: 1px solid var(--zw-line-strong);
  border-radius: var(--zw-radius-sm);
  background: #fff;
  color: var(--zw-text);
  cursor: pointer;
  white-space: nowrap;
  transition:
    color 0.16s ease,
    border-color 0.16s ease,
    background 0.16s ease;
}

.act:hover:not(:disabled) {
  color: var(--zw-green-deep);
  border-color: var(--zw-green);
}

.act:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 下载按钮：与「预览」视觉平权（白底实线描边，虚线只留给「需登录」锁定态）。
   VI-07：虚线语义回收 —— 普通下载曾经长得像被禁用的样子（与预览差 3 档权重），
   现在与预览同色族不同档：同 mint 底，但实线边框、无填充差异。 */
.act--download {
  font-weight: 600;
  color: var(--zw-green-deep);
  border-color: var(--zw-line-strong);
}

.act--preview {
  font-weight: 600;
  color: var(--zw-green-deep);
  border-color: var(--zw-green-soft);
  background: var(--zw-mint-2);
}

/* 下载对游客关着时不装死：置灰 + 标题里写明「需登录」，点了会带去登录页。
   QA-ALL-04：锁定态语义统一 = 虚线描边（全站只有锁定按钮才用虚线）。 */
.act--locked {
  font-weight: 400;
  color: var(--zw-muted);
  background: #fff;
  border-style: dashed;
  border-color: var(--zw-line-strong);
}

/* 键盘焦点与 hover 同样有去处（卡片脚部的按钮原来没有 focus 态） */
.act:focus-visible {
  outline: 2px solid var(--zw-green);
  outline-offset: 2px;
}
</style>
