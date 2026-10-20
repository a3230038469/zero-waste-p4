<script setup lang="ts">
/**
 * 资料卡片 —— 通用组件（2026-10-10 新增）
 *
 * 首页「最新收录」、资料库列表、概览页都用同一张卡片，
 * 避免三个页面各写一套、字段与样式慢慢长歪。
 *
 * 用 <RouterLink> 而不是 div + click：这样能被新标签页打开、能被键盘 Tab 到、
 * 右键「在新窗口打开」也正常 —— 对以「公开分享」为目标的站点，这几条是基本的。
 */
import { computed } from 'vue'
import type { DocItem } from '../api/types'
import { formatBytes, formatYear } from '../utils/format'

const props = defineProps<{ doc: DocItem; maxTags?: number }>()

/** 卡片上最多展示几个主题标签，多出来的收成「+N」 */
const tagLimit = computed(() => props.maxTags ?? 3)
const shownTags = computed(() => props.doc.tags.slice(0, tagLimit.value))
const restTags = computed(() => Math.max(0, props.doc.tags.length - tagLimit.value))

/** 内容类型 → 色带（纯展示用，不改变数据的 type 值） */
const TYPE_TONE: Record<string, string> = {
  政策法规: 'policy',
  国内政策法规: 'policy',
  国际公约: 'treaty',
  各类标准: 'standard',
  研究报告: 'research',
  研究实践报告: 'research',
  案例工具: 'tool',
  科学认知: 'science'
}

const tone = computed(() => TYPE_TONE[props.doc.type] ?? 'default')
</script>

<template>
  <RouterLink :to="`/doc/${doc.id}`" class="doc-card" :class="`tone-${tone}`">
    <div class="card-top">
      <span class="type-badge">{{ doc.type }}</span>
      <span class="year">{{ formatYear(doc.year) }}</span>
    </div>

    <h3 class="doc-title">{{ doc.title }}</h3>

    <p class="doc-org" :title="doc.org">{{ doc.org }}</p>

    <div class="doc-tags">
      <span v-for="t in shownTags" :key="t" class="tag">{{ t }}</span>
      <span v-if="restTags > 0" class="tag tag--rest">+{{ restTags }}</span>
    </div>

    <div class="card-foot">
      <span class="size zw-num">{{ formatBytes(doc.size) }}</span>
      <span v-if="doc.duplicateOf" class="dup-flag" title="这份资料与库中另一份内容完全相同"
        >另有相同副本</span
      >
    </div>
  </RouterLink>
</template>

<style scoped>
.doc-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 20px 16px;
  background: var(--zw-surface);
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  box-shadow: var(--zw-shadow-sm);
  text-decoration: none;
  color: inherit;
  overflow: hidden;
  transition:
    transform 0.22s ease,
    box-shadow 0.22s ease,
    border-color 0.22s ease;
}

/* 左侧色带：靠 type 区分，扫一眼就能分出政策/报告/工具 */
.doc-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--tone, var(--zw-green-soft));
}

.doc-card:hover {
  transform: translateY(-3px);
  box-shadow: var(--zw-shadow);
  border-color: var(--zw-line-strong);
}

.doc-card:focus-visible {
  outline: 2px solid var(--zw-green);
  outline-offset: 2px;
}

.tone-policy {
  --tone: var(--zw-green);
}
.tone-research {
  --tone: var(--zw-teal);
}
.tone-tool {
  --tone: var(--zw-amber);
}
.tone-standard {
  --tone: #5a6ea8;
}
.tone-treaty {
  --tone: #7a5aa8;
}
.tone-science {
  --tone: #a85a7a;
}
.tone-default {
  --tone: var(--zw-faint);
}

.card-top {
  display: flex;
  align-items: center;
  gap: 10px;
}

.type-badge {
  font-size: var(--zw-fs-xs);
  font-weight: 600;
  color: var(--zw-green-deep);
  background: var(--zw-mint);
  border-radius: 999px;
  padding: 3px 10px;
}

.year {
  font-size: var(--zw-fs-xs);
  color: var(--zw-faint);
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.doc-title {
  margin: 0;
  font-size: var(--zw-fs-body);
  line-height: 1.5;
  color: var(--zw-ink);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.doc-org {
  margin: 0;
  font-size: var(--zw-fs-sm);
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
  font-size: var(--zw-fs-xs);
  color: var(--zw-teal);
  background: var(--zw-teal-soft);
  border-radius: 6px;
  padding: 2px 8px;
}

.tag--rest {
  color: var(--zw-muted);
  background: #f1f4f1;
}

.card-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: auto;
  padding-top: 4px;
  font-size: var(--zw-fs-xs);
  color: var(--zw-faint);
}

.size {
  font-variant-numeric: tabular-nums;
}

.dup-flag {
  margin-left: auto;
  color: var(--zw-amber);
  background: var(--zw-amber-soft);
  border-radius: 6px;
  padding: 2px 8px;
}
</style>
