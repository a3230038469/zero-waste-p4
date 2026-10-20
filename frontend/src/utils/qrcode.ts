/**
 * 二维码生成（B09 分享功能，2026-10-13）
 *
 * 用途：资料详情页的「分享二维码」——把本页地址编成二维码，方便线下活动扫码看向、
 * 也方便把二维码贴进 PPT / 打印物料。
 *
 * 三条设计取舍，写清楚免得后人改坏：
 *   1. **本地生成，不调外部接口**。把资料链接发给第三方二维码服务，等于把「谁在看什么资料」
 *      泄漏出去；而且现场断网就画不出来。所以用内置的 MIT 实现（见 ./vendor/）。
 *   2. **只产出「模块矩阵」，不产出图片格式**。调用方自己决定画成 SVG（屏幕，清晰）
 *      还是 canvas（导出 PNG，打印）。这里不碰 DOM，便于单测。
 *   3. **容错等级固定 M（约 15%）**。二维码会被印在宣传物料上、被手机隔着角度扫，
 *      L(7%) 太脆；H(30%) 会让码点变多变密，小尺寸反而不易扫。M 是折中。
 *   ⚠️ URL 长度会影响版本（码点密度）：一般资料页链接约 40–60 字符，M 级下是 4–6 版，
 *      30mm 见方印出来也能扫。若站点域名特别长（>120 字符），要提醒设计方放大二维码。
 */
import qrcode from './vendor/qrcode-generator.mjs'

/** 容错等级：L 7% / M 15% / Q 25% / H 30% */
export type QrLevel = 'L' | 'M' | 'Q' | 'H'

/** 二维码矩阵：只暴露「有几行」和「某格是不是黑的」 */
export interface QrMatrix {
  /** 边长（模块数），例如 25 表示 25×25 */
  count: number
  isDark: (row: number, col: number) => boolean
}

/**
 * 把文本编成二维码矩阵。
 *
 * 实现上做了两件事：
 *   - 把库的默认编解码函数换成 UTF-8：上游默认按 Latin-1 逐字节取，中文会编错。
 *     我们的链接目前是纯 ASCII，但站点域名/路径将来可能有中文，这里一次性处理掉。
 *   - typeNumber 传 0 = 自动选版本（按内容长度和容错等级算），调用方不用关心版本号。
 */
export function createQrMatrix(text: string, level: QrLevel = 'M'): QrMatrix {
  qrcode.stringToBytes = utf8Bytes

  const qr = qrcode(0, level)
  qr.addData(text, 'Byte')
  qr.make()

  const count = qr.getModuleCount()
  return { count, isDark: (row: number, col: number) => qr.isDark(row, col) }
}

/** UTF-8 编码（不依赖 TextEncoder，保证在极老环境也能跑） */
function utf8Bytes(input: string): number[] {
  if (typeof TextEncoder !== 'undefined') {
    return Array.from(new TextEncoder().encode(input))
  }
  const out: number[] = []
  for (let i = 0; i < input.length; i += 1) {
    let code = input.charCodeAt(i)
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      // 代理对（emoji 等）
      const next = input.charCodeAt(i + 1)
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
      i += 1
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return out
}

/**
 * 把矩阵画成 SVG 路径数据（供 <path d="..."> 使用）。
 *
 * 用 path 而不是一堆 <rect>：617 份资料的二维码在页面上只出现一个，但 path 的
 * 节点数少一个数量级，且缩放不失真、直接打印清晰。
 */
export function qrSvgPath(matrix: QrMatrix): string {
  const parts: string[] = []
  for (let row = 0; row < matrix.count; row += 1) {
    for (let col = 0; col < matrix.count; col += 1) {
      if (!matrix.isDark(row, col)) continue
      parts.push(`M${col} ${row}h1v1h-1z`)
    }
  }
  return parts.join('')
}

/**
 * 把矩阵画到 canvas 上（用于「保存二维码图片」）。
 *
 * @param quietZone 四周留白模块数。二维码规范要求 ≥4，留白不够扫码率会明显下降。
 * @param scale     每个模块的像素数（会乘上 devicePixelRatio 保证高清）
 */
export function drawQrToCanvas(
  canvas: HTMLCanvasElement,
  matrix: QrMatrix,
  options: { scale?: number; quietZone?: number } = {}
): void {
  const scale = options.scale ?? 12
  const quietZone = options.quietZone ?? 4
  const side = (matrix.count + quietZone * 2) * scale
  const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1

  canvas.width = side * ratio
  canvas.height = side * ratio
  canvas.style.width = `${side}px`
  canvas.style.height = `${side}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // 白底（二维码必须在白底上，透明底遇到深色背景会扫不出来）
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#000000'
  for (let row = 0; row < matrix.count; row += 1) {
    for (let col = 0; col < matrix.count; col += 1) {
      if (!matrix.isDark(row, col)) continue
      ctx.fillRect(
        (col + quietZone) * scale * ratio,
        (row + quietZone) * scale * ratio,
        scale * ratio,
        scale * ratio
      )
    }
  }
}
