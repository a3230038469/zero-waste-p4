<script setup lang="ts">
/**
 * 鼠标动态光追 + 晕染小圈 —— 站点氛围层（2026-10-10）
 *
 * 是什么：
 *   1. **光追**：鼠标处一束柔光跟着走，并带一个滞后一点的「光圈」拖尾，
 *      移动时像光在纸面上扫过；点击时泛出一圈水波。
 *   2. **晕染小圈**：几团大而模糊的色斑在页面背后极缓慢地漂移，
 *      并随鼠标产生视差（靠得近的走得快），营造「墨在纸上洇开」的感觉。
 *
 * 三条硬约束（都踩过才写进来）：
 *   - **绝不能挡操作**：整层 `pointer-events: none`，且 z-index 压在所有内容之下。
 *   - **必须能关**：识别 `prefers-reduced-motion`（系统「减弱动态效果」）与触摸设备，
 *     命中就不跑动画，只留一层静态底纹 —— 动态特效不该让任何人看不清内容。
 *   - **不能掉帧**：只改 `transform`（合成层，不触发布局），
 *     页面切到后台（`visibilitychange`）立刻停掉 rAF，回来自动续上。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

interface BlobConfig {
  /** 直径（px） */
  size: number
  /** 基准位置（视口百分比） */
  top: number
  left: number
  /** 颜色（含透明度） */
  color: string
  /** 模糊半径（px） */
  blur: number
  /** 漂移速度与幅度 */
  speed: number
  amp: number
  /** 鼠标视差系数（正负决定方向相反） */
  depth: number
  phase: number
}

/** 色斑配置：绿系为主，掺一点琥珀与青，避免整页只剩一种绿 */
const BLOBS: BlobConfig[] = [
  {
    size: 460,
    top: 4,
    left: 6,
    color: 'rgba(46, 125, 50, 0.16)',
    blur: 90,
    speed: 0.085,
    amp: 28,
    depth: 0.022,
    phase: 0
  },
  {
    size: 380,
    top: 62,
    left: 72,
    color: 'rgba(43, 122, 120, 0.14)',
    blur: 96,
    speed: 0.062,
    amp: 36,
    depth: -0.017,
    phase: 1.5
  },
  {
    size: 300,
    top: 26,
    left: 82,
    color: 'rgba(200, 135, 31, 0.11)',
    blur: 80,
    speed: 0.108,
    amp: 22,
    depth: 0.028,
    phase: 3.1
  },
  {
    size: 520,
    top: 78,
    left: 16,
    color: 'rgba(102, 187, 106, 0.13)',
    blur: 110,
    speed: 0.055,
    amp: 30,
    depth: -0.024,
    phase: 4.4
  },
  {
    size: 260,
    top: 10,
    left: 44,
    color: 'rgba(46, 125, 50, 0.09)',
    blur: 70,
    speed: 0.126,
    amp: 18,
    depth: 0.032,
    phase: 2.2
  }
]

/** 光层顺序：0 大光晕 / 1 中层 / 2 光圈 / 3 拖尾光圈 */
const FOLLOW_FACTOR = [0.085, 0.16, 0.34, 0.1]

const root = ref<HTMLElement | null>(null)

let rafId = 0
let running = false
/** 鼠标目标位置（视口坐标） */
const target = { x: 0, y: 0 }
/** 各跟随层的当前位置 */
const layers: { x: number; y: number }[] = FOLLOW_FACTOR.map(() => ({ x: 0, y: 0 }))
let blobs: HTMLElement[] = []
let mouseMoved = false

let reduceMotion = false
let coarsePointer = false

function readMedia(): void {
  reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  coarsePointer = !window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

/** 把视口坐标换算成「相对视口中心」的偏移，用于视差 */
function parallax(depth: number): { x: number; y: number } {
  return {
    x: (target.x - window.innerWidth / 2) * depth,
    y: (target.y - window.innerHeight / 2) * depth
  }
}

function frame(): void {
  if (!running) return
  const time = performance.now() / 1000

  // ① 光追：逐层朝鼠标缓动，越靠后的层越慢，形成拖尾
  const followNodes = root.value?.querySelectorAll<HTMLElement>('.glow-follow') ?? []
  for (let i = 0; i < followNodes.length; i += 1) {
    const current = layers[i]
    const node = followNodes[i]
    if (!current || !node) continue
    const factor = FOLLOW_FACTOR[i] ?? 0.1
    current.x += (target.x - current.x) * factor
    current.y += (target.y - current.y) * factor
    node.style.transform = `translate3d(${current.x}px, ${current.y}px, 0)`
  }

  // ② 晕染小圈：正弦漂移 + 鼠标视差
  for (let i = 0; i < blobs.length; i += 1) {
    const config = BLOBS[i]
    const node = blobs[i]
    if (!config || !node) continue
    const dx = Math.sin(time * config.speed + config.phase) * config.amp
    const dy = Math.cos(time * config.speed * 0.78 + config.phase) * config.amp
    const shift = parallax(config.depth)
    // 圆心对齐基准点：直接减去半径，避免用 margin 百分比做居中
    // （CSS 的 margin-top 百分比是按**宽度**算的，用它做垂直居中一定会偏）
    node.style.transform = `translate3d(${dx + shift.x - config.size / 2}px, ${dy + shift.y - config.size / 2}px, 0)`
  }

  rafId = window.requestAnimationFrame(frame)
}

function start(): void {
  if (running) return
  running = true
  rafId = window.requestAnimationFrame(frame)
}

function stop(): void {
  running = false
  if (rafId) window.cancelAnimationFrame(rafId)
  rafId = 0
}

function onPointerMove(event: PointerEvent): void {
  target.x = event.clientX
  target.y = event.clientY
  // 第一次移动前光层停在 (0,0)，会有一道光从左上角滑过来 —— 当作入场动画，挺好；
  // 但从第二次起就必须是真跟随，不能出现「光在别处」的错位。
  if (!mouseMoved) {
    mouseMoved = true
    for (const layer of layers) {
      layer.x = target.x
      layer.y = target.y
    }
  }
}

/** 点击处泛一圈水波（晕染感），纯装饰，动画结束即移除节点 */
function onPointerDown(event: PointerEvent): void {
  const host = root.value
  if (!host) return
  const ripple = document.createElement('span')
  ripple.className = 'glow-ripple'
  ripple.style.left = `${event.clientX}px`
  ripple.style.top = `${event.clientY}px`
  host.appendChild(ripple)
  const animation = ripple.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0.25)', opacity: 0.55 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 0 }
    ],
    { duration: 760, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' }
  )
  void animation.finished.catch(() => undefined).then(() => ripple.remove())
}

function onVisibilityChange(): void {
  if (document.hidden) stop()
  else if (!reduceMotion && !coarsePointer) start()
}

function onResize(): void {
  // 视差按视口中心算，尺寸变了要重取一次，否则偏移会持续偏在一边
  target.x = Math.min(target.x, window.innerWidth)
  target.y = Math.min(target.y, window.innerHeight)
}

onMounted(() => {
  readMedia()
  const host = root.value
  if (host) {
    host.classList.toggle('is-static', reduceMotion || coarsePointer)
    blobs = [...host.querySelectorAll<HTMLElement>('.glow-blob')]
    // 先摆到基准位置：静态模式下 rAF 不跑，不显式给一次 transform 色斑会整体偏到右下
    blobs.forEach((node, i) => {
      const config = BLOBS[i]
      if (!config) return
      node.style.transform = `translate3d(${-config.size / 2}px, ${-config.size / 2}px, 0)`
    })
  }

  target.x = window.innerWidth / 2
  target.y = window.innerHeight * 0.34
  for (const layer of layers) {
    layer.x = target.x
    layer.y = target.y
  }

  // 触摸设备 / 减弱动态：不跑跟随，只保留静态底纹
  if (reduceMotion || coarsePointer) return

  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, { passive: true })
  window.addEventListener('resize', onResize, { passive: true })
  document.addEventListener('visibilitychange', onVisibilityChange)
  start()
})

onBeforeUnmount(() => {
  stop()
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('resize', onResize)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <!-- 装饰层：不接收任何指针事件，也不参与无障碍树 -->
  <div ref="root" class="mouse-glow" aria-hidden="true">
    <div class="glow-blobs">
      <span
        v-for="(b, i) in BLOBS"
        :key="`blob-${i}`"
        class="glow-blob"
        :style="{
          width: `${b.size}px`,
          height: `${b.size}px`,
          top: `${b.top}%`,
          left: `${b.left}%`,
          background: b.color,
          filter: `blur(${b.blur}px)`
        }"
      />
    </div>

    <div class="glow-follow glow-follow--halo" />
    <div class="glow-follow glow-follow--mid" />
    <div class="glow-follow glow-follow--ring" />
    <div class="glow-follow glow-follow--ring-trail" />
  </div>
</template>

<style scoped>
.mouse-glow {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  /* 不裁内容、不触发布局；但不用 contain:size —— 本层靠 inset:0 撑满视口，
     加上尺寸包含会把它的固有尺寸算成 0，视口一变就可能整层塌掉。 */
  contain: layout paint;
}

.glow-blobs {
  position: absolute;
  inset: 0;
}

.glow-blob {
  position: absolute;
  display: block;
  border-radius: 50%;
  transform: translate3d(0, 0, 0);
  will-change: transform;
}

.glow-follow {
  position: absolute;
  top: 0;
  left: 0;
  border-radius: 50%;
  will-change: transform;
}

/* 光晕：最外层的大柔光，跟随最慢 */
.glow-follow--halo {
  width: 520px;
  height: 520px;
  margin: -260px 0 0 -260px;
  background: radial-gradient(circle, rgba(46, 125, 50, 0.13), rgba(46, 125, 50, 0) 68%);
}

/* 中层：更亮更小，让光有一个「芯」 */
.glow-follow--mid {
  width: 260px;
  height: 260px;
  margin: -130px 0 0 -130px;
  background: radial-gradient(circle, rgba(102, 187, 106, 0.16), rgba(102, 187, 106, 0) 70%);
}

/* 光圈：贴着鼠标的一圈细线，是「光追」最容易被看见的部分 */
.glow-follow--ring {
  width: 46px;
  height: 46px;
  margin: -23px 0 0 -23px;
  border: 1px solid rgba(46, 125, 50, 0.42);
  box-shadow: 0 0 18px rgba(46, 125, 50, 0.16) inset;
}

/* 拖尾光圈：滞后更明显的一圈，移动时形成速度感 */
.glow-follow--ring-trail {
  width: 96px;
  height: 96px;
  margin: -48px 0 0 -48px;
  border: 1px solid rgba(46, 125, 50, 0.16);
}

.glow-ripple {
  position: absolute;
  width: 220px;
  height: 220px;
  border-radius: 50%;
  border: 1px solid rgba(46, 125, 50, 0.35);
  background: radial-gradient(circle, rgba(46, 125, 50, 0.1), rgba(46, 125, 50, 0) 70%);
  pointer-events: none;
}

/* 静态模式（触摸设备 / 减弱动态）：不跟随、不漂移，只留一层很淡的底纹 */
.mouse-glow.is-static .glow-follow {
  display: none;
}

.mouse-glow.is-static .glow-blob {
  opacity: 0.55;
}
</style>
