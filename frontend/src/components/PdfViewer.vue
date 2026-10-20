<script setup lang="ts">
/**
 * 站内 PDF 阅读器（2026-10-18 新增）
 *
 * 为什么要自己写一个：
 *   原来预览是把 PDF 直接塞进 iframe，显示的是**浏览器自带的阅读器** —— 一条深灰工具栏、
 *   一片灰底、左边还默认开着缩略图栏，跟本站的绿白配色毫无关系，各家浏览器长得还不一样。
 *   主人原话：「那个预览器样式很丑，能不能换一种样式，观感更符合主题」。
 *
 *   浏览器对 iframe 里的 PDF 阅读器**不给任何样式入口**（`#toolbar=0` 这类参数 Chrome 不认），
 *   想要「长得像本站」，只能用 pdf.js 自己把页面画到 canvas 上，工具栏自己画。
 *
 * 这一版只管三件事：一页一页翻、缩放、把页面铺满宽度。不做文本层/搜索/目录 ——
 * 先让观感对，功能按需要再加（以后想「引用片段跳到 PDF 某页」也得靠这里的文字层）。
 *
 * 渲染细节：devicePixelRatio 最高按 2 处理（再高就是白烧内存，字也看不出差别）；
 * 每次翻页/缩放都会 cancel 上一次的渲染，否则快速翻页会出现两张页面互相覆盖。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const props = defineProps<{ src: string; title?: string }>()

type PdfDoc = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>
type PageProxy = Awaited<ReturnType<PdfDoc['getPage']>>
type RenderTask = ReturnType<PageProxy['render']>

const boxRef = ref<HTMLElement | null>(null)
const stageRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const loading = ref(true)
const failed = ref('')
const total = ref(0)
const pageNo = ref(1)
const zoom = ref(1)

let doc: PdfDoc | null = null
/** 取文档的 loadingTask：v6 里销毁文档要走它（PDFDocumentProxy 自己已经没有 destroy） */
let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null
let task: RenderTask | null = null
/** 渲染序号：翻页太快时只认最后一次，旧的结果直接丢 */
let seq = 0

const canPrev = computed(() => pageNo.value > 1)
const canNext = computed(() => total.value > 0 && pageNo.value < total.value)
const zoomLabel = computed(() => `${Math.round(zoom.value * 100)}%`)

async function closeDoc(): Promise<void> {
  seq++
  try {
    task?.cancel()
  } catch {
    /* 已结束的渲染取消会抛，忽略 */
  }
  task = null
  if (loadingTask) {
    try {
      await loadingTask.destroy()
    } catch {
      /* 销毁失败无所谓，下一次会重新开 */
    }
    loadingTask = null
  }
  doc = null
}

/** 把当前页画到 canvas 上（按容器宽度铺满，再乘缩放） */
async function render(): Promise<void> {
  if (!doc || !canvasRef.value) return
  const mine = ++seq
  try {
    const page = await doc.getPage(pageNo.value)
    if (mine !== seq) return
    const base = page.getViewport({ scale: 1 })
    // 量「纸面舞台」的内容宽（.pdfv-scroll 有 14px 内边距，直接拿它自己的 clientWidth
    // 会算宽 26px，结果每页右边都多出一条横向滚动条 —— 踩过）
    const avail = Math.max(160, (stageRef.value?.clientWidth ?? 880) - 2)
    const fit = Math.max(0.2, avail / base.width)
    const viewport = page.getViewport({ scale: fit * zoom.value })
    const canvas = canvasRef.value
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width = `${Math.floor(viewport.width)}px`
    canvas.style.height = `${Math.floor(viewport.height)}px`
    try {
      task?.cancel()
    } catch {
      /* 同上 */
    }
    const params = {
      canvas,
      canvasContext: ctx,
      viewport,
      ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] as [number, number, number, number, number, number] } : {})
    }
    task = page.render(params)
    await task.promise
    if (mine === seq) loading.value = false
  } catch (err) {
    // cancel 不是错误
    const msg = err instanceof Error ? err.message : String(err)
    if (/cancel/i.test(msg)) return
    if (mine === seq) {
      failed.value = msg || '预览加载失败'
      loading.value = false
    }
  }
}

async function open(): Promise<void> {
  failed.value = ''
  loading.value = true
  total.value = 0
  pageNo.value = 1
  zoom.value = 1
  await closeDoc()
  if (!props.src) {
    loading.value = false
    return
  }
  try {
    loadingTask = pdfjsLib.getDocument({ url: props.src })
    doc = await loadingTask.promise
    total.value = doc.numPages
    await render()
  } catch (err) {
    failed.value = err instanceof Error ? err.message : '预览加载失败'
    loading.value = false
  }
}

function go(delta: number): void {
  const next = pageNo.value + delta
  if (next < 1 || (total.value && next > total.value)) return
  pageNo.value = next
  loading.value = true
  void render()
}

function zoomBy(step: number): void {
  const next = Math.round((zoom.value + step) * 10) / 10
  if (next < 0.6 || next > 2.5) return
  zoom.value = next
  loading.value = true
  void render()
}

/** 缩放回到「适合宽度」 */
function resetZoom(): void {
  zoom.value = 1
  loading.value = true
  void render()
}

watch(() => props.src, () => void open(), { immediate: true })

/** 窗口变宽变窄（含手机横竖屏）要重新铺满，否则会留着旧的宽度 */
let resizeTimer: ReturnType<typeof setTimeout> | null = null
function onResize(): void {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (doc && !loading.value) void render()
  }, 160)
}

onMounted(() => window.addEventListener('resize', onResize))

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  if (resizeTimer) clearTimeout(resizeTimer)
  void closeDoc()
})
</script>

<template>
  <div class="pdfv">
    <div class="pdfv-bar">
      <span class="pdfv-title" :title="title">{{ title || '原件预览' }}</span>

      <div class="pdfv-nav">
        <button type="button" class="pdfv-btn" :disabled="!canPrev" title="上一页" @click="go(-1)">
          ‹
        </button>
        <span class="pdfv-page zw-num">
          {{ total ? pageNo : '–' }}
          <span class="pdfv-sep">/</span>
          {{ total || '–' }}
        </span>
        <button type="button" class="pdfv-btn" :disabled="!canNext" title="下一页" @click="go(1)">
          ›
        </button>
      </div>

      <div class="pdfv-zoom">
        <button type="button" class="pdfv-btn" title="缩小" @click="zoomBy(-0.2)">−</button>
        <button type="button" class="pdfv-pct zw-num" title="回到适合宽度" @click="resetZoom">
          {{ zoomLabel }}
        </button>
        <button type="button" class="pdfv-btn" title="放大" @click="zoomBy(0.2)">＋</button>
      </div>

      <!-- 页面自己的「全屏 / 收起」放在这条工具栏里，避免上下两条横栏叠着 -->
      <div class="pdfv-actions">
        <slot name="actions" />
      </div>
    </div>

    <div ref="boxRef" class="pdfv-scroll">
      <p v-if="failed" class="pdfv-fail">
        这个文件没法在页面里打开（{{ failed }}）。可以用上方「下载原件」保存后用本地阅读器查看。
      </p>
      <div v-else ref="stageRef" class="pdfv-stage">
        <canvas ref="canvasRef" class="pdfv-canvas" />
        <div v-if="loading" class="pdfv-mask">
          <span class="pdfv-spinner" aria-hidden="true" />
          <p>正在打开文件…</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pdfv {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 工具栏自己画：绿白配色、发丝线、圆角按钮，跟站里其它控件同一套语言 */
.pdfv-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px 8px 14px;
  background: #fff;
  border-bottom: 1px solid var(--zw-line);
}

/* 左端：文件名（长标题单行省略，完整名在 title 悬浮里） */
.pdfv-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--zw-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pdfv-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.pdfv-nav,
.pdfv-zoom {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pdfv-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  font-size: 16px;
  line-height: 1;
  color: var(--zw-green-deep);
  background: var(--zw-mint-2);
  border: 1px solid var(--zw-line-strong);
  border-radius: 8px;
  cursor: pointer;
  transition:
    background 0.16s ease,
    border-color 0.16s ease,
    color 0.16s ease;
}

.pdfv-btn:hover:not(:disabled) {
  background: var(--zw-mint);
  border-color: var(--zw-green-soft);
}

.pdfv-btn:disabled {
  color: var(--zw-faint);
  background: #f6f8f6;
  border-color: var(--zw-line);
  cursor: not-allowed;
}

.pdfv-page {
  font-size: 13px;
  color: var(--zw-text);
  min-width: 54px;
  text-align: center;
}

.pdfv-sep {
  margin: 0 2px;
  color: var(--zw-faint);
}

.pdfv-pct {
  font: inherit;
  font-size: 12px;
  min-width: 46px;
  padding: 4px 6px;
  color: var(--zw-text);
  background: #fff;
  border: 1px solid var(--zw-line);
  border-radius: 8px;
  cursor: pointer;
}

.pdfv-pct:hover {
  border-color: var(--zw-green-soft);
  color: var(--zw-green-deep);
}

/* 卷轴区：浅绿底衬白纸，滚动条留给自己 */
.pdfv-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #eef3ee;
  padding: 14px;
}

.pdfv-stage {
  position: relative;
  display: flex;
  justify-content: center;
  min-height: 240px;
}

.pdfv-canvas {
  display: block;
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(22, 36, 26, 0.12);
}

.pdfv-mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  font-size: 13px;
  color: var(--zw-muted);
  background: rgba(238, 243, 238, 0.86);
}

.pdfv-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--zw-line-strong);
  border-top-color: var(--zw-green);
  border-radius: 50%;
  animation: pdfv-spin 0.8s linear infinite;
}

@keyframes pdfv-spin {
  to {
    transform: rotate(360deg);
  }
}

.pdfv-fail {
  margin: 40px auto;
  max-width: 420px;
  padding: 16px 18px;
  font-size: 14px;
  line-height: 1.9;
  color: var(--zw-amber-ink);
  background: var(--zw-amber-soft);
  border-left: 3px solid var(--zw-amber);
  border-radius: 0 var(--zw-radius-sm) var(--zw-radius-sm) 0;
}

@media (max-width: 720px) {
  /* 窄屏：文件名让位（页标题里已经有名字了）；
     一行塞不下「翻页 + 缩放 + 全屏/收起」四组，改成两行——
     上行翻页与缩放、下行两个按钮靠右，避免收起按钮被挤出可视区。 */
  .pdfv-title {
    display: none;
  }

  .pdfv-bar {
    flex-wrap: wrap;
    row-gap: 6px;
    gap: 6px;
    padding: 6px 8px;
  }

  .pdfv-nav {
    order: 1;
  }

  .pdfv-zoom {
    order: 2;
    margin-left: auto;
  }

  .pdfv-actions {
    order: 3;
    width: 100%;
    justify-content: flex-end;
  }

  .pdfv-btn {
    width: 28px;
    height: 28px;
  }
}
</style>
