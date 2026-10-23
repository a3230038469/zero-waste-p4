<script setup lang="ts">
/**
 * 站内 PDF 阅读器（2026-10-18 初版 → 2026-10-21 改「连续滚动」）
 *
 * 为什么要自己写一个：
 *   原来预览是把 PDF 直接塞进 iframe，显示的是**浏览器自带的阅读器** —— 一条深灰工具栏、
 *   一片灰底、左边还默认开着缩略图栏，跟本站的绿白配色毫无关系，各家浏览器长得还不一样。
 *   主人原话：「那个预览器样式很丑，能不能换一种样式，观感更符合主题」。
 *
 *   浏览器对 iframe 里的 PDF 阅读器**不给任何样式入口**（`#toolbar=0` 这类参数 Chrome 不认），
 *   想要「长得像本站」，只能用 pdf.js 自己把页面画到 canvas 上，工具栏自己画。
 *
 * 这一版为什么从「单页 + 上一页/下一页」改成连续滚动：
 *   主人原话「翻页太累，要像正常 PDF 那样上下滚动」。于是把所有页按纵向排成一列、
 *   卷轴式往下滚。难点不是排版，是「几百页不能一次性画完」——
 *
 *   · 占位高度先量准：文档一打开就把每页 scale=1 的尺寸读出来（getPage 只读页面字典，
 *     不画），每页盒子高 = 纸高 × 铺满比例 × zoom。滚动条从一开始就是最终长度，
 *     之后「画 / 释放 / 重画」只换 canvas 里的位图、不动盒子高度 —— 所以不会跳。
 *   · 只画看得见的：滚动时按 scrollTop 算可见页（不用 IntersectionObserver，是为了
 *     能精确决定「预取几页、离多远释放」），视口前后各预取 1 页；
 *     离视口超过 2 页就把 canvas 位图放掉（保留占位白纸），内存不随页数线性涨。
 *   · 位置保持：缩放 / 改窗口宽度 / 切全屏，都先记下「当前页 + 页内比例」，
 *     重排后按新页高把同一处内容换算回去再设 scrollTop；同时关掉浏览器的自动滚动锚定
 *     （overflow-anchor: none），免得它自作主张再挪一截。
 *   · 页码：按「可见面积最大的那页」算，随滚动更新；‹ › 改成平滑滚到上/下一页顶部。
 *
 * 渲染细节：devicePixelRatio 最高按 2 处理（再高就是白烧内存，字也看不出差别），
 * 另外按「单页位图不超过 8M 像素」再压一档 —— 放大到 250% 时不压的话，一张 canvas
 * 能吃掉上百 MB；每次重画前 cancel 上一次的 RenderTask，否则快速缩放会出现两张图互相覆盖。
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance
} from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const props = defineProps<{ src: string; title?: string }>()

type PdfDoc = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>
type PageProxy = Awaited<ReturnType<PdfDoc['getPage']>>
type RenderTask = ReturnType<PageProxy['render']>

/** 页与页之间的间距（css 里 .pdfv-sheet 的 margin-bottom 必须跟它一致，滚动位置就是按它算的） */
const GAP = 14
/** 单页位图上限：8M 像素 ≈ 32MB。放大到 250% 时靠它把 dpr 压下来 */
const MAX_BITMAP_PX = 8_000_000
const MIN_ZOOM = 0.6
const MAX_ZOOM = 2.5
const ZOOM_STEP = 0.2
/** 同时最多画几页（两页并行足够，再多只是抢主线程） */
const MAX_ACTIVE = 2

/** 一页的静态尺寸 + 当前绘制状态 */
interface Sheet {
  /** 1 起的页号 */
  no: number
  /** scale=1 时的纸面宽高（css px） */
  baseW: number
  baseH: number
  /**
   * off     还没画 / 已释放：只留占位白纸，没有 canvas
   * pending 需要画：canvas 已挂上（可能还是上一档缩放留下的旧位图）
   * busy    正在画
   * ready   画好了，位图与当前缩放一致
   * error   这一页画不出来（只废这一页，其它页照常滚）
   */
  phase: 'off' | 'pending' | 'busy' | 'ready' | 'error'
  reason: string
  /** 每页的绘制代号：释放 / 重排 / 换文档时 +1，让「在飞的绘制」回来时闭嘴 */
  token: number
}

interface Box {
  /** 相对纸面列表顶部的纵向位置 */
  top: number
  /** 当前缩放下的盒子宽高（css px） */
  w: number
  h: number
}

/** 缩放 / 重排时用来记住阅读位置的锚点 */
interface Anchor {
  /** 页下标（0 起） */
  index: number
  /** 该页内的相对位置（0=页顶，1=页底） */
  ratio: number
}

const scrollRef = ref<HTMLElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const sheets = ref<Sheet[]>([])
const loading = ref(true)
const failed = ref('')
const currentPage = ref(1)
const zoom = ref(1)
/** 铺满容器时「scale=1 的宽度」能占多少 css px（= 容器宽 - 内边距），容器大小变了要重新量 */
const avail = ref(880)

let doc: PdfDoc | null = null
/** 取文档的 loadingTask：v6 里销毁文档要走它（PDFDocumentProxy 自己已经没有 destroy） */
let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null
/** 文档代号：换 src 时 +1，用来丢弃旧文档在飞的所有异步回调 */
let gen = 0
/** 每页在飞的渲染任务 */
const tasks = new Map<number, RenderTask>()
/** 每页挂着的 canvas（v-if 动态挂，靠 ref 回调维护） */
const canvasEls = new Map<number, HTMLCanvasElement>()
/** 待画队列（页下标）+ 已在队列里的去重表 */
const queue: number[] = []
const queued = new Set<number>()
let active = 0

const total = computed(() => sheets.value.length)
const canPrev = computed(() => currentPage.value > 1)
const canNext = computed(() => total.value > 0 && currentPage.value < total.value)
const canZoomOut = computed(() => zoom.value > MIN_ZOOM + 0.001)
const canZoomIn = computed(() => zoom.value < MAX_ZOOM - 0.001)
const zoomLabel = computed(() => `${Math.round(zoom.value * 100)}%`)

/** 某一页当前的绘制比例：先按各自纸宽铺满容器，再乘缩放 */
function scaleOf(sheet: Sheet): number {
  return Math.max(0.05, avail.value / Math.max(1, sheet.baseW)) * zoom.value
}

/** 全部页的盒子位置（宽高 + 顶部偏移）—— 滚动位置、页码、占位高度都读它 */
const boxes = computed<Box[]>(() => {
  const out: Box[] = []
  let top = 0
  for (const sheet of sheets.value) {
    const scale = scaleOf(sheet)
    const w = Math.max(1, Math.floor(sheet.baseW * scale))
    const h = Math.max(1, Math.floor(sheet.baseH * scale))
    out.push({ top, w, h })
    top += h + GAP
  }
  return out
})

/** 纸面列表在滚动内容里的起点（.pdfv-scroll 有 14px 内边距，位置都相对列表算） */
function listTop(): number {
  return listRef.value?.offsetTop ?? 0
}

function maxScroll(): number {
  const el = scrollRef.value
  return el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0
}

/** 内容坐标 y 落在第几页（二分，越界取首/末页） */
function indexAt(contentY: number): number {
  const list = boxes.value
  if (!list.length) return 0
  let lo = 0
  let hi = list.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].top <= contentY) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

function captureAnchor(): Anchor | null {
  const el = scrollRef.value
  const list = boxes.value
  if (!el || !list.length) return null
  const y = el.scrollTop - listTop()
  const index = indexAt(y)
  const ratio = Math.min(1, Math.max(0, (y - list[index].top) / Math.max(1, list[index].h)))
  return { index, ratio }
}

function restoreAnchor(anchor: Anchor | null): void {
  const el = scrollRef.value
  const list = boxes.value
  if (!el || !list.length) return
  if (!anchor) {
    el.scrollTop = 0
    return
  }
  const index = Math.min(anchor.index, list.length - 1)
  const y = list[index].top + list[index].h * anchor.ratio
  el.scrollTop = Math.min(maxScroll(), Math.max(0, listTop() + y))
}

/** 容器里能放多宽的纸（量不出变化就返回 false，避免无谓重排） */
function measureAvail(): boolean {
  const el = scrollRef.value
  if (!el) return false
  // 减掉左右各 14px 内边距与 2px 取整，避免 1px 的横向滚动条反复出现
  const next = Math.max(160, el.clientWidth - 28 - 2)
  if (Math.abs(next - avail.value) < 0.5) return false
  avail.value = next
  return true
}

/** 视口覆盖到的页区间（含 0 页兜底） */
function visibleRange(): { first: number; last: number } {
  const el = scrollRef.value
  const list = boxes.value
  if (!el || !list.length) return { first: 0, last: 0 }
  const top = el.scrollTop - listTop()
  const bottom = top + el.clientHeight
  let first = -1
  let last = -1
  for (let i = 0; i < list.length; i++) {
    const box = list[i]
    if (box.top >= bottom) break
    if (box.top + box.h > top) {
      if (first < 0) first = i
      last = i
    }
  }
  if (first < 0) {
    // 视口正好卡在两页之间的缝里（14px）：按离视口顶最近的那页兜底
    const i = indexAt(Math.max(0, top))
    return { first: i, last: i }
  }
  return { first, last }
}

/** 页码口径：可见面积最大的那一页（读者眼里「正在看的那页」） */
function pageWithLargestArea(): number {
  const el = scrollRef.value
  const list = boxes.value
  if (!el || !list.length) return 1
  const top = el.scrollTop - listTop()
  const bottom = top + el.clientHeight
  let best = 0
  let bestArea = -1
  for (let i = 0; i < list.length; i++) {
    const box = list[i]
    if (box.top >= bottom) break
    const overlap = Math.min(bottom, box.top + box.h) - Math.max(top, box.top)
    if (overlap > bestArea) {
      bestArea = overlap
      best = i
    }
  }
  return best + 1
}

function setCanvasRef(index: number, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLCanvasElement) canvasEls.set(index, el)
  else canvasEls.delete(index)
}

function sheetStyle(index: number): Record<string, string> {
  const box = boxes.value[index]
  if (!box) return {}
  return { width: `${box.w}px`, height: `${box.h}px` }
}

/**
 * pdf.js 的报错是英文，公众看到「Invalid PDF structure.」根本不知道该干嘛。
 * 这里把常见的几句翻成中文；不认识的也先套一句中文说明，再附上原文（截一段）供定位。
 * 【T3 · 公-4】2026-10-21
 */
const PDF_ERROR_ZH: { re: RegExp; zh: string }[] = [
  { re: /invalid\s+pdf\s+structure/i, zh: '文件结构损坏，不是有效的 PDF（可能上传时损坏了）' },
  { re: /invalid\s+pdf\s+header/i, zh: '文件开头不是 PDF 格式，可能上传时损坏了' },
  { re: /password/i, zh: '这份文件有密码，浏览器打不开' },
  { re: /missing\s+pdf|not\s+a\s+pdf/i, zh: '这不是一个 PDF 文件' },
  { re: /unknown\s+format|unsupported/i, zh: '文件格式浏览器不支持' }
]

/** 英文报错 → 中文说明（认不出来就给中文概括 + 原文片段） */
function zhReason(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim()
  if (!text) return '原因不明'
  const hit = PDF_ERROR_ZH.find((x) => x.re.test(text))
  if (hit) return hit.zh
  const brief = text.length > 60 ? `${text.slice(0, 60)}…` : text
  return `没能打开这份文件（${brief}）`
}

/** 单页失败只影响这一页：翻译成中文，认不出的原文截一段够定位就行 */
function shortReason(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim()
  if (!text) return '原因不明'
  const hit = PDF_ERROR_ZH.find((x) => x.re.test(text))
  if (hit) return hit.zh
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/** 第一张纸画出来（或失败）就把「正在打开文件…」收掉 */
function revealLoaded(): void {
  if (loading.value) loading.value = false
}

/**
 * 按预算算这一页该用多少 dpr：
 * 高分屏按 2 封顶，但位图总面积不能超过 MAX_BITMAP_PX（放大后一张纸上百 MB 会卡死）。
 */
function bitmapRatio(cssW: number, cssH: number): number {
  const cap = Math.sqrt(MAX_BITMAP_PX / Math.max(1, cssW * cssH))
  return Math.max(0.5, Math.min(window.devicePixelRatio || 1, 2, cap))
}

/** 把一页画到它的 canvas 上（调用前 canvas 必须已在 DOM 里） */
async function draw(index: number): Promise<void> {
  const sheet = sheets.value[index]
  const current = doc
  if (!sheet || !current) return
  const token = sheet.token
  sheet.phase = 'pending'
  // canvas 是 v-if 挂上去的：先等这一帧把元素挂好，再拿 ref 画
  await nextTick()
  if (token !== sheet.token) return
  const canvas = canvasEls.get(index)
  if (!canvas) {
    sheet.phase = 'off'
    return
  }
  sheet.phase = 'busy'
  try {
    const page = await current.getPage(sheet.no)
    if (token !== sheet.token) return
    const viewport = page.getViewport({ scale: scaleOf(sheet) })
    const cssW = Math.max(1, Math.floor(viewport.width))
    const cssH = Math.max(1, Math.floor(viewport.height))
    const dpr = bitmapRatio(cssW, cssH)
    canvas.width = Math.max(1, Math.floor(cssW * dpr))
    canvas.height = Math.max(1, Math.floor(cssH * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('浏览器不给画布上下文')
    const task = page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      ...(dpr !== 1
        ? { transform: [dpr, 0, 0, dpr, 0, 0] as [number, number, number, number, number, number] }
        : {})
    })
    tasks.set(index, task)
    await task.promise
    tasks.delete(index)
    if (token !== sheet.token) return
    sheet.phase = 'ready'
    sheet.reason = ''
    revealLoaded()
  } catch (err) {
    tasks.delete(index)
    if (token !== sheet.token) return
    const message = err instanceof Error ? err.message : String(err)
    // cancel 是我们自己取消的（切页 / 缩放 / 释放），不是失败
    if (/cancel/i.test(message)) {
      sheet.phase = 'off'
      return
    }
    sheet.phase = 'error'
    sheet.reason = shortReason(message)
    revealLoaded()
  }
}

function enqueue(index: number): void {
  const sheet = sheets.value[index]
  if (!sheet || queued.has(index)) return
  if (sheet.phase !== 'off' && sheet.phase !== 'pending') return
  queued.add(index)
  queue.push(index)
}

function pump(): void {
  while (active < MAX_ACTIVE && queue.length) {
    const index = queue.shift()
    if (index === undefined) break
    queued.delete(index)
    const sheet = sheets.value[index]
    if (!sheet || (sheet.phase !== 'off' && sheet.phase !== 'pending')) continue
    active += 1
    const finish = (): void => {
      active -= 1
      pump()
    }
    void draw(index).then(finish, finish)
  }
}

/** 放掉一页的位图与任务（保留占位盒子，滚动位置不动） */
function release(index: number): void {
  const sheet = sheets.value[index]
  if (!sheet || sheet.phase === 'off' || sheet.phase === 'error') return
  sheet.token += 1
  sheet.phase = 'off'
  sheet.reason = ''
  const task = tasks.get(index)
  if (task) {
    try {
      task.cancel()
    } catch {
      /* 已经结束的任务取消会抛，忽略 */
    }
    tasks.delete(index)
  }
  queued.delete(index)
  const canvas = canvasEls.get(index)
  if (canvas) {
    // 先把位图放掉再等 DOM 卸载：不然要等 GC 才发现内存
    canvas.width = 0
    canvas.height = 0
    canvasEls.delete(index)
  }
}

/** 缩放 / 改宽之后：旧位图全部作废，但 canvas 先留着（旧图拉伸着顶一下，不闪白） */
function invalidateSheets(): void {
  for (const sheet of sheets.value) {
    sheet.token += 1
    if (sheet.phase === 'ready' || sheet.phase === 'busy' || sheet.phase === 'pending') {
      sheet.phase = 'pending'
    }
  }
  for (const [index, task] of tasks) {
    try {
      task.cancel()
    } catch {
      /* 同上 */
    }
    tasks.delete(index)
  }
  queued.clear()
  queue.length = 0
}

function relayout(anchor: Anchor | null): void {
  invalidateSheets()
  void nextTick().then(() => {
    restoreAnchor(anchor)
    syncWindow()
  })
}

/** 滚动 / 重排之后：更新页码，决定哪些页该画、哪些页该放掉 */
function syncWindow(): void {
  const list = boxes.value
  if (!scrollRef.value || !list.length) return
  const { first, last } = visibleRange()
  currentPage.value = pageWithLargestArea()

  // 保留窗口：视口前后各多留 2 页，来回小幅度滚动不至于刚放掉又要重画
  const keepFrom = Math.max(0, first - 2)
  const keepTo = Math.min(list.length - 1, last + 2)
  for (let i = 0; i < list.length; i++) {
    if (i < keepFrom || i > keepTo) release(i)
  }

  // 渲染窗口：可见页 + 前后各预取 1 页（滚起来才不会有空白）
  const from = Math.max(0, first - 1)
  const to = Math.min(list.length - 1, last + 1)
  for (let i = from; i <= to; i++) enqueue(i)
  pump()
}

let scrollRaf = 0
function onScroll(): void {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    syncWindow()
  })
}

/** 把文档、任务、位图全部清干净（换 src / 卸载都走这里） */
async function closeDoc(): Promise<void> {
  gen += 1
  for (const sheet of sheets.value) sheet.token += 1
  for (const [index, task] of tasks) {
    try {
      task.cancel()
    } catch {
      /* 同上 */
    }
    tasks.delete(index)
  }
  queued.clear()
  queue.length = 0
  active = 0
  canvasEls.clear()
  if (loadingTask) {
    try {
      await loadingTask.destroy()
    } catch {
      /* 销毁失败无所谓，下一次会重新开 */
    }
    loadingTask = null
  }
  doc = null
  sheets.value = []
  if (scrollRef.value) scrollRef.value.scrollTop = 0
}

/**
 * 先把每页的原尺寸量出来（只读页面字典，不画）。
 * 占位高度以此为准，滚动条一上来就是最终长度，后面画/释放都不会让内容跳。
 */
async function readSizes(target: PdfDoc, myGen: number): Promise<Sheet[] | null> {
  const count = target.numPages
  const out: Sheet[] = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= count || myGen !== gen) return
      try {
        const page = await target.getPage(index + 1)
        if (myGen !== gen) return
        const viewport = page.getViewport({ scale: 1 })
        out[index] = {
          no: index + 1,
          baseW: viewport.width,
          baseH: viewport.height,
          phase: 'off',
          reason: '',
          token: 0
        }
      } catch (err) {
        // 单独一页读不出来不算整份失败：给个 A4 占位，页面上写一句原因
        out[index] = {
          no: index + 1,
          baseW: 595,
          baseH: 842,
          phase: 'error',
          reason: shortReason(err instanceof Error ? err.message : String(err)),
          token: 0
        }
      }
    }
  }
  const workers = Math.min(6, Math.max(1, count))
  await Promise.all(Array.from({ length: workers }, () => worker()))
  if (myGen !== gen) return null
  return out
}

async function open(): Promise<void> {
  failed.value = ''
  loading.value = true
  currentPage.value = 1
  zoom.value = 1
  await closeDoc()
  if (!props.src) {
    loading.value = false
    return
  }
  const myGen = gen
  try {
    const task = pdfjsLib.getDocument({ url: props.src })
    loadingTask = task
    const target = await task.promise
    if (myGen !== gen) return
    doc = target
    const list = await readSizes(target, myGen)
    if (myGen !== gen || !list) return
    sheets.value = list
    await nextTick()
    if (myGen !== gen) return
    measureAvail()
    syncWindow()
  } catch (err) {
    if (myGen !== gen) return
    // 【T3 · 公-4】别把 pdf.js 的英文原话直接甩给读者
    failed.value = zhReason(err instanceof Error ? err.message : '预览加载失败')
    loading.value = false
  }
}

/** ‹ › ：平滑滚到上一页 / 下一页的顶部（不是把整份换成那一页） */
function goTo(index: number): void {
  const el = scrollRef.value
  const list = boxes.value
  if (!el || !list.length) return
  const target = Math.min(list.length - 1, Math.max(0, index))
  const top = Math.min(maxScroll(), Math.max(0, listTop() + list[target].top))
  el.scrollTo({ top, behavior: 'smooth' })
}

function go(delta: number): void {
  goTo(currentPage.value - 1 + delta)
}

function setZoom(next: number): void {
  const value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(next * 10) / 10))
  if (Math.abs(value - zoom.value) < 0.001) return
  const anchor = captureAnchor()
  zoom.value = value
  relayout(anchor)
}

function zoomBy(step: number): void {
  setZoom(zoom.value + step)
}

/** 缩放回到「适合宽度」 */
function resetZoom(): void {
  setZoom(1)
}

watch(() => props.src, () => void open(), { immediate: true })

let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null

/** 容器变大变小（窗口 resize、切全屏都是它）：重新铺满，并按锚点把阅读位置换回去 */
function onContainerResize(): void {
  if (!doc) return
  const anchor = captureAnchor()
  if (measureAvail()) relayout(anchor)
  else syncWindow()
}

onMounted(() => {
  measureAvail()
  syncWindow()
  if (typeof ResizeObserver === 'undefined' || !scrollRef.value) return
  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    // 拖窗口 / 切全屏会连续触发，攒一下再重排，不然每一帧都在 cancel + 重画
    resizeTimer = setTimeout(onContainerResize, 140)
  })
  resizeObserver.observe(scrollRef.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (resizeTimer) clearTimeout(resizeTimer)
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
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
          {{ total ? currentPage : '–' }}
          <span class="pdfv-sep">/</span>
          {{ total || '–' }}
        </span>
        <button type="button" class="pdfv-btn" :disabled="!canNext" title="下一页" @click="go(1)">
          ›
        </button>
      </div>

      <div class="pdfv-zoom">
        <button type="button" class="pdfv-btn" :disabled="!canZoomOut" title="缩小" @click="zoomBy(-ZOOM_STEP)">
          −
        </button>
        <button type="button" class="pdfv-pct zw-num" title="回到适合宽度" @click="resetZoom">
          {{ zoomLabel }}
        </button>
        <button type="button" class="pdfv-btn" :disabled="!canZoomIn" title="放大" @click="zoomBy(ZOOM_STEP)">
          ＋
        </button>
      </div>

      <!-- 页面自己的「全屏 / 收起」放在这条工具栏里，避免上下两条横栏叠着 -->
      <div class="pdfv-actions">
        <slot name="actions" />
      </div>
    </div>

    <div class="pdfv-body">
      <div ref="scrollRef" class="pdfv-scroll" @scroll.passive="onScroll">
        <p v-if="failed" class="pdfv-fail">
          这个文件没法在页面里打开（{{ failed }}）。可以用上方「下载原件」保存后用本地阅读器查看。
          <button type="button" class="pdfv-retry" @click="open">重新加载</button>
        </p>
        <div v-else ref="listRef" class="pdfv-pages">
          <div
            v-for="(sheet, i) in sheets"
            :key="sheet.no"
            class="pdfv-sheet"
            :style="sheetStyle(i)"
          >
            <canvas
              v-if="sheet.phase === 'pending' || sheet.phase === 'busy' || sheet.phase === 'ready'"
              :ref="(el) => setCanvasRef(i, el)"
              class="pdfv-canvas"
            />
            <p v-else-if="sheet.phase === 'error'" class="pdfv-page-fail">
              第 {{ sheet.no }} 页没能显示（{{ sheet.reason }}）
            </p>
            <span v-else class="pdfv-page-ghost zw-num" aria-hidden="true">{{ sheet.no }}</span>
          </div>
        </div>
      </div>

      <div v-if="loading && !failed" class="pdfv-mask">
        <span class="pdfv-spinner" aria-hidden="true" />
        <p>正在打开文件…</p>
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

/* 卷轴区：浅绿底衬白纸，滚动条留给自己。
   .pdfv-body 定位是为了让「正在打开」那层遮罩盖住可视区、不跟着内容滚。 */
.pdfv-body {
  position: relative;
  flex: 1;
  min-height: 0;
}

.pdfv-scroll {
  position: absolute;
  inset: 0;
  overflow: auto;
  padding: 14px;
  background: #eef3ee;
  /* 滚动位置由脚本自己保（缩放前记页号+页内比例），别让浏览器的滚动锚定再插一手；
     scrollbar-gutter 固定槽位，免得出现/消失滚动条时宽度来回抖。 */
  overflow-anchor: none;
  scrollbar-gutter: stable;
}

/* 连续滚动：每页一张「纸」，从上往下排；纸间距 14px 与脚本里的 GAP 必须一致。
   这里不能用 flex 居中：纸比容器宽时（放大超过铺满宽度）flex 会把左边裁掉、滚不到，
   所以用块级 + 自动外边距 —— 宽了就自然靠左，横向滚动条才正常。 */
.pdfv-pages {
  display: block;
}

.pdfv-sheet {
  position: relative;
  margin: 0 auto 14px;
  overflow: hidden;
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(22, 36, 26, 0.12);
}

.pdfv-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* 还没画到的页：只留一个很淡的页号，说明这里有一页在排队，不是掉了 */
.pdfv-page-ghost {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--zw-faint);
  user-select: none;
}

/* 单页失败：只废这一页，其它页照常滚 */
.pdfv-page-fail {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0 24px;
  font-size: 13px;
  line-height: 1.8;
  text-align: center;
  color: var(--zw-amber-ink);
  background: var(--zw-amber-soft);
}

.pdfv-mask {
  position: absolute;
  inset: 0;
  z-index: 2;
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

/* 整份打不开时的重试入口（只在这一条里出现） */
.pdfv-retry {
  margin-left: 8px;
  font: inherit;
  font-size: 13px;
  padding: 3px 10px;
  color: var(--zw-amber-ink);
  background: #fff;
  border: 1px solid var(--zw-amber);
  border-radius: 8px;
  cursor: pointer;
}

.pdfv-retry:hover {
  background: var(--zw-amber-soft);
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
