<script setup lang="ts">
/**
 * 一条对话气泡（T5-3：从 HomeAskWidget 抽出的可复用渲染层）
 *
 * 抽它的原因：T4 把「Markdown 渲染 + 来源卡片 + 等待文案」都写在首页气泡组件里，
 * `/chat` 独立页要同样的观感。**复制一份必然漂移**（改个表格圆角要动两个文件），
 * 所以抽成组件 —— 首页气泡与独立页现在共用同一份渲染与样式。
 *
 * 三种形态：
 *   - user      → 纯文本（用户输入 `*x*` 就该原样显示，不当 Markdown 解）
 *   - assistant → marked 渲染 + DOMPurify 净化 + 来源卡片
 *   - 等待中    → 轮换文案（文案与节奏来自 useWaitingLines，本组件只管显示与切换动画）
 *
 * 特效（T5-4，都尊重 prefers-reduced-motion）：
 *   - 等待文案：淡出→淡入 300ms（mode="out-in"，两段不叠在一起闪）
 *   - 来源卡片：流结束时逐个弹入，stagger 60ms（transition-group 的 appear）
 *   - 回答正文：新段落轻微 fade-up
 *   - 表格：圆角 + 淡入
 *
 * ⚠️ 正文不做「逐字 fade-in」：流式期间每来一个片段整个 innerHTML 就重刷一次，
 *    动画会跟着反复重放，视觉上是抽搐而不是渐显。
 *    所以段落动画**只在流结束后**（streaming=false）加类名触发。
 */
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

import type { AskSource } from '../api/ask'
import { NO_ANSWER_LABEL, NO_SOURCE_NOTE } from '../utils/askCopy'

export interface BubbleMessage {
  role: 'user' | 'assistant'
  text: string
  /** 出错的气泡（额度/网络/引擎不可用），文案用警示色 */
  failed?: boolean
  /**
   * 库内没有可用资料（后端 noAnswer 口径：正常收尾但正文为空）。
   * 与 failed 分开：**它不是故障**，是「知识库里确实没有」，不该用警示色吓用户。
   */
  noAnswer?: boolean
  /** 回答引用的资料卡片。同一份资料后端已去重 */
  sources?: AskSource[]
}

const props = defineProps<{
  message: BubbleMessage
  /** 正在流式接收（控制段落浮现只在结束后触发） */
  streaming?: boolean
  /** 等待文案：由 useWaitingLines 提供，本组件不自己管轮播 */
  waitingText?: string
  /** 正在等第一个字（assistant 且还没有正文） */
  waiting?: boolean
}>()

const emit = defineEmits<{
  /** 点来源卡片：交回给宿主决定怎么跳（首页与独立页都可能不是同一个路由上下文） */
  (e: 'open-source', url: string): void
}>()

/** 引擎的 <kb/> 引用标记（<kb doc="…" chunk_id="…" />）：对读者太吵，渲染前剥掉 */
const SOURCE_TAG = /<kb\s+doc="[^"]*"[^>]*?\/?>/g

/**
 * 模型在正文里自己写的出处标记 `【资料名：xxx.pdf】`。
 *
 * 来源卡片已经把它提在气泡底部了，正文里这条是**原文的一部分**，不删（对外展示站
 * 引用要如实留着），只转成一个弱化的小字，避免一条 60 字的文件名糊在正文中间。
 */
const INLINE_CITE = /【\s*资料名[：:]\s*([^】]+?)\s*】/g

/** 塞进 innerHTML 前先转义这三个字符（DOMPurify 是最后一道兜底，不是唯一一道） */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 回答正文 -> 可 v-html 的 HTML。
 *
 * ⚠️ 渲染的是**模型输出**，必须过 DOMPurify —— v-html 直接吃未净化的字符串
 *    等于给站点开一个 XSS 口子。
 */
function renderAnswer(text: string): string {
  const cleaned = text
    .replace(SOURCE_TAG, '')
    .replace(INLINE_CITE, (_all, name: string) => `<span class="cite">${escapeHtml(name)}</span>`)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
  const html = marked.parse(cleaned, { async: false }) as string
  // 表格外面套一层：border-radius 必须配 overflow 才会裁圆角，
  // 而 overflow 得在一个独立容器上（table 本身加了 display:block 已经是滚动容器，
  // 但它的圆角+边框会和单元格边框打架）。单独一层顺便承接 T5 的「表格淡入」。
  const wrapped = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>')
  return DOMPurify.sanitize(wrapped)
}

/** 只给 assistant 的正文算（user 走纯文本分支） */
const answerHtml = computed(() =>
  props.message.role === 'assistant' ? renderAnswer(props.message.text) : ''
)

/** 等待文案（非空才渲染，避免空 transition） */
const waitingText = computed(() => (props.waitingText ?? '').trim())

/**
 * 要不要显示「本条没有关联到库内资料」的提示。
 *
 * 只在**流真正结束**（streaming=false）且满足全部条件时显示，否则会在等待期间闪出来：
 *   - assistant、有正文、不是错误、不是拒答
 *   - 没有来源卡片（sources 为空 = 后端 resolveCitationSources 没解析出引用）
 *
 * ⚠️ 只提示、**不改写正文**：T4 的解析兼容四种引用形态，但仍可能遇到模型没写引用标记的
 *    情况。这种情况下把模型的话篡改成「没资料」比不提示更糟，所以只补一句实话。
 */
const showNoSourceNote = computed(
  () =>
    props.message.role === 'assistant' &&
    !props.streaming &&
    !props.message.failed &&
    !props.message.noAnswer &&
    props.message.text.trim() !== '' &&
    (!props.message.sources || props.message.sources.length === 0)
)
</script>

<template>
  <div class="bubble" :class="[message.role, { failed: message.failed, 'no-answer': message.noAnswer }]">
    <!-- 等待期：轮换文案；出第一个字就换成正文，不闪。fade + out-in = 淡出后淡入，不叠影 -->
    <transition v-if="waiting && waitingText" name="fade" mode="out-in">
      <span :key="waitingText" class="typing">{{ waitingText }}</span>
    </transition>
    <!-- 用户的提问：纯文本，不渲染 Markdown（输入 *x* 就该原样显示） -->
    <span v-else-if="message.role === 'user'" class="plain">{{ message.text }}</span>
    <!-- 回答：marked 渲染 + DOMPurify 净化（renderAnswer 已 sanitize，XSS 已收口）。
         streaming 为 false（流结束）时给 settled，触发段落/表格的浮现动画。

         ⚠️ v-html 的来源已收口：文本先过 escapeHtml + marked，再过 DOMPurify.sanitize，
            DOMPurify 默认不在放行列表里保留 script 与事件属性，XSS 口子在这里堵上了。
            与 --max-warnings 0 冲突，所以带理由就地收口，不全局关规则。 -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-else class="md" :class="{ settled: !streaming }" v-html="answerHtml"></div>

    <!-- 拒答标签：明确告诉用户这是「库里没有」，而不是 AI 坏了 -->
    <p v-if="message.noAnswer" class="no-answer-label">{{ NO_ANSWER_LABEL }}</p>

    <!-- 有正文但没解析到引用：如实补一句，不篡改模型输出 -->
    <p v-if="showNoSourceNote" class="no-source">{{ NO_SOURCE_NOTE }}</p>

    <!-- 来源卡片：点一下跳资料详情页（预览 / 下载在那页）。
         appear + stagger 索引 = 流结束时逐个弹入 -->
    <transition-group
      v-if="message.role === 'assistant' && message.sources && message.sources.length > 0"
      tag="div"
      class="sources"
      name="chip"
      appear
    >
      <button
        v-for="(s, si) in message.sources"
        :key="s.url"
        type="button"
        class="chip"
        :style="{ transitionDelay: `${si * 60}ms` }"
        :title="s.name"
        @click="emit('open-source', s.url)"
      >
        {{ s.name }}
      </button>
    </transition-group>
  </div>
</template>

<style scoped>
.bubble {
  max-width: 86%;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  background: #f3f8f3;
  color: #24352a;
}
.bubble.user {
  margin-left: auto;
  background: var(--zw-green, #2e7d32);
  color: #fff;
}
.bubble.failed {
  background: #fff7e6;
  color: #b26a00;
}
/* 拒答气泡：不是故障，用中性色 + 虚线边（与 failed 的警示橙区分开） */
.bubble.no-answer {
  background: #f7faf7;
  border: 1px dashed #cfdccf;
  color: #3f5245;
}
.no-answer-label {
  margin: 8px 0 0;
  padding-top: 6px;
  border-top: 1px dashed #dfe9df;
  font-size: 11px;
  color: #8aa08c;
  white-space: normal;
}
/* 无来源提示：一行小字，位置与来源卡片一致（虚线分隔），但不可点 */
.no-source {
  margin: 8px 0 0;
  padding-top: 6px;
  border-top: 1px dashed #dfe9df;
  font-size: 11px;
  line-height: 1.7;
  color: #8aa08c;
  white-space: normal;
}
.plain {
  white-space: pre-wrap;
}
.typing {
  color: #6b7d6b;
}

/* ---- 等待文案切换：淡出 300ms → 淡入 300ms ---- */
.fade-enter-active,
.fade-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}
.fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ---- 来源卡片：流结束时逐个弹入（stagger 由行内 transition-delay 控制）---- */
.sources {
  position: relative; /* 让离场的卡片能 absolute 定位，淡出时不会把后面的挤一下 */
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed #dfe9df;
  white-space: normal;
}
.chip {
  max-width: 100%;
  padding: 2px 8px;
  border: 1px solid #cfe0cf;
  border-radius: 10px;
  background: #fff;
  color: var(--zw-green, #2e7d32);
  font-size: 11px;
  line-height: 1.7;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition:
    transform 0.22s ease,
    opacity 0.22s ease,
    background 0.18s ease,
    border-color 0.18s ease;
}
.chip:hover {
  background: #f0f7f0;
  border-color: var(--zw-green, #2e7d32);
}
.chip-enter-active {
  transition:
    transform 0.26s ease,
    opacity 0.26s ease;
}
.chip-enter-from {
  opacity: 0;
  transform: translateY(6px) scale(0.96);
}
/* 已挂载的卡片再来一张时也要有 stagger 过渡（同一批 appear 只在首次触发） */
.chip-leave-active {
  position: absolute;
  transition:
    transform 0.18s ease,
    opacity 0.18s ease;
}
.chip-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
/* 「来源」二字（独立页要显示标签，这里补一个） */
.sources-label {
  font-size: 11px;
  color: #8aa08c;
}

/* ---- 回答正文（Markdown） ---- */
/* 气泡是 pre-wrap（用户提问要保留换行），Markdown 块级元素必须切回 normal */
.md {
  white-space: normal;
  overflow-wrap: anywhere;
}
.md :deep(p) {
  margin: 0 0 6px;
}
.md :deep(p:last-child) {
  margin-bottom: 0;
}
/* 标题在聊天气泡里要收着点，别抢正文 */
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  margin: 10px 0 4px;
  font-weight: 600;
  line-height: 1.45;
}
.md :deep(h1) {
  font-size: 16px;
}
.md :deep(h2) {
  font-size: 15px;
}
.md :deep(h3) {
  font-size: 14px;
}
.md :deep(h4) {
  font-size: 13px;
  color: #3c5243;
}
.md :deep(ul),
.md :deep(ol) {
  margin: 0 0 6px;
  padding-left: 20px;
}
.md :deep(li) {
  margin: 0 0 2px;
}
.md :deep(a) {
  color: var(--zw-green, #2e7d32);
  text-decoration: underline;
}
/* 表格：加边框 + 斑马纹；窄气泡里允许横向滚，别把面板撑破。
   外层 .table-wrap 是 T5 特效：圆角 + 淡入（border-radius 在 overflow 容器上才生效） */
.md :deep(.table-wrap) {
  margin: 6px 0;
  border-radius: 8px;
  overflow-x: auto;
  border: 1px solid #dfe9df;
}
.md :deep(table) {
  display: block;
  width: 100%;
  overflow-x: auto;
  margin: 0;
  border-collapse: collapse;
  font-size: 12px;
}
.md :deep(th),
.md :deep(td) {
  padding: 4px 7px;
  border: 1px solid #dfe9df;
  text-align: left;
  white-space: nowrap;
}
.md :deep(th) {
  background: #eef5ee;
  font-weight: 600;
}
.md :deep(tbody tr:nth-child(even) td) {
  background: #f7faf7;
}
/* 代码：浅灰底 */
.md :deep(code) {
  padding: 1px 4px;
  border-radius: 3px;
  background: #eef1ee;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
}
.md :deep(pre) {
  margin: 6px 0;
  padding: 8px;
  border-radius: 6px;
  background: #eef1ee;
  overflow-x: auto;
}
.md :deep(pre code) {
  padding: 0;
  background: transparent;
}
.md :deep(blockquote) {
  margin: 6px 0;
  padding: 2px 8px;
  border-left: 3px solid #cfe0cf;
  color: #55685a;
}
.md :deep(hr) {
  margin: 8px 0;
  border: none;
  border-top: 1px solid #e3ece3;
}
/* 模型自己写的出处标记：弱化成小字，不抢正文 */
.md :deep(.cite) {
  color: #8aa08c;
  font-size: 12px;
}

/* ---- T5-4 特效：只在流结束后（settled）触发，避免流式重刷反复重放 ---- */
.md.settled :deep(p) {
  animation: bubble-fade-up 0.32s ease both;
}
.md.settled :deep(.table-wrap) {
  animation: bubble-fade-in 0.36s ease both;
}
@keyframes bubble-fade-up {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes bubble-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* ---- 无障碍：系统开启「减弱动态效果」时，上面所有动画全关 ---- */
@media (prefers-reduced-motion: reduce) {
  .fade-enter-active,
  .fade-leave-active,
  .chip-enter-active,
  .chip-leave-active {
    transition: none;
  }
  .chip {
    transition: none;
  }
  .md.settled :deep(p),
  .md.settled :deep(.table-wrap) {
    animation: none;
  }
}
</style>