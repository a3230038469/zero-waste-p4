/**
 * 资料类型 → 专属配色（仅「资料库」页使用）
 *
 * 需求约束：
 *   1. 只用绿系衍生色，低饱和，和站点浅绿背景协调；不出现红/橙这类高对比跳色。
 *   2. **文字对比度必须达标**。
 *
 * 第 2 条不能靠手挑色值来「感觉够了」——一个色值在不同底色（白底、同色浅底、
 * 同色实底）上，需要的文字色并不一样。所以这里只定义**底色** `fill`，
 * 其余文字色全部按 WCAG 对比度**算出来**：
 *
 *   fill          标签选中底色 / 卡片左侧竖线 / 悬停渐变主色（唯一需要人工调的值）
 *   text          纯白底上的文字（≥ 4.5:1）
 *   chipText      同色 10% 浅底上的文字（≥ 4.5:1，浅底会略微吃掉对比度，所以单独算）
 *   ink           压在 fill 实底上的文字（白/深墨绿二选一，且保证 ≥ 4.5:1）
 *   line / soft   描边与浅底（同色不同透明度）
 *   glow          卡片悬停时由中心扩散的淡色（透明 0.18，不压文字）
 *   chipActiveBg  选中态里计数格的底（白字用压暗、深字用提亮，两个方向都只会让对比度更高）
 *
 * 好处：以后要改某个分类的颜色，只改 TYPE_FILL 一处，所有文字色自动重算，
 * 不会出现「换了底色忘了改文字」这类可读性事故。
 *
 * 未在表里的类型（后端将来新增）统一回落站点主绿，不会渲染成透明或黑块。
 */

/** 站点主绿：也是「全部」标签与未知类型的兜底色 */
export const PRIMARY_GREEN = '#2e7d32'

/** 八类资料的专属色（唯一需要人工维护的地方） */
export const TYPE_FILL: Record<string, string> = {
  政策法规: '#1f5c33', // 深森林绿
  研究报告: '#3e9c86', // 青薄荷绿
  研究实践报告: '#7ca86b', // 浅苔绿
  各类标准: '#5a93a8', // 蓝调浅湖绿
  案例工具: '#8ba857', // 暖豆绿
  国内政策法规: '#123a24', // 墨绿
  国际公约: '#6c8f8b', // 灰调青绿
  科学认知: '#a6c87f', // 浅嫩草绿
}

const WHITE = '#ffffff'
/** 深墨绿：浅底上的文字基色（比 --zw-green-ink 再深一档，留出对比度余量） */
const INK_DEEP = '#0a1e12'
/** WCAG AA：正常字号的最小对比度 */
const AA = 4.5

/* ---------------- 颜色计算 ---------------- */

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}

function linearize(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG 相对亮度 */
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex)
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

/** WCAG 对比度（1 ~ 21）。输入支持 #rgb / #rrggbb */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** 把某色按 alpha 叠在白底上，得到「实际看到的颜色」（算对比度必须用这个，不能用带 alpha 的值） */
function overWhite(hex: string, alpha: number): string {
  const [r, g, b] = toRgb(hex)
  return toHex([r * alpha + 255 * (1 - alpha), g * alpha + 255 * (1 - alpha), b * alpha + 255 * (1 - alpha)])
}

/** 把色按同色比例逐步压暗，直到在指定底色上达到目标对比度 */
function darkenUntil(hex: string, bg: string, target: number): string {
  const [r, g, b] = toRgb(hex)
  for (let k = 1; k >= 0.3; k -= 0.02) {
    const candidate = toHex([r * k, g * k, b * k])
    if (contrast(candidate, bg) >= target) return candidate
  }
  return INK_DEEP
}

/**
 * 压在实底上的文字色。
 *
 * 先看白字够不够；不够就压深墨绿，压到达标为止。
 * 为什么一定能达标：白字在 L ≤ 0.183 时可读，纯黑在 L ≥ 0.175 时可读，两者区间是重叠的，
 * 所以任何底色都能找到合格的字色，不存在「取不到」的情况。
 */
function inkOn(fill: string): string {
  if (contrast(fill, WHITE) >= AA) return WHITE
  const [r, g, b] = toRgb(INK_DEEP)
  for (let k = 1; k >= 0; k -= 0.1) {
    const candidate = toHex([r * k, g * k, b * k])
    if (contrast(fill, candidate) >= AA) return candidate
  }
  return '#000000'
}

export interface Tone {
  fill: string
  text: string
  chipText: string
  ink: string
  line: string
  soft: string
  chipActiveBg: string
  glow: string
}

const cache = new Map<string, Tone>()

/** 取某个类型的完整配色（重复取命中缓存，列表里几十张卡片不会重复算） */
export function toneOf(type: string): Tone {
  const hit = cache.get(type)
  if (hit) return hit

  const fill = TYPE_FILL[type] ?? PRIMARY_GREEN
  const [r, g, b] = toRgb(fill)
  const alpha = (a: number) => `rgba(${r}, ${g}, ${b}, ${a})`
  const softAlpha = 0.1
  const ink = inkOn(fill)

  const tone: Tone = {
    fill,
    text: darkenUntil(fill, WHITE, AA),
    chipText: darkenUntil(fill, overWhite(fill, softAlpha), AA),
    ink,
    line: alpha(0.35),
    soft: alpha(softAlpha),
    // 白字→把底压暗，深字→把底提亮；两个方向都只会让对比度更高
    chipActiveBg: ink === WHITE ? 'rgba(0, 0, 0, 0.16)' : 'rgba(255, 255, 255, 0.45)',
    glow: alpha(0.18),
  }
  cache.set(type, tone)
  return tone
}

/** 打包成 CSS 变量，供分类标签绑到 :style 上 */
export function toneVars(type: string): Record<string, string> {
  const t = toneOf(type)
  return {
    '--tone': t.fill,
    '--tone-text': t.text,
    '--tone-chip-text': t.chipText,
    '--tone-ink': t.ink,
    '--tone-line': t.line,
    '--tone-soft': t.soft,
    '--tone-chip-active-bg': t.chipActiveBg,
    // 分类图标：形状 + 颜色，卡片标签读的是同一对变量
    '--tone-icon': iconMaskOf(type),
    '--tone-icon-color': iconColorOf(type),
  }
}

/** 打包成 CSS 变量，供资料卡片（左侧竖线 + 悬停渐变 + 分类标签图标）使用 */
export function cardToneVars(type: string): Record<string, string> {
  const t = toneOf(type)
  return {
    '--tone': t.fill,
    '--tone-glow': t.glow,
    '--tone-icon': iconMaskOf(type),
    '--tone-icon-color': iconColorOf(type),
  }
}

/* ------------------------------------------------------------------ *
 * 分类图标（2026-10-13 新增，仅「资料库」页用）
 * ------------------------------------------------------------------ */

/**
 * 分类图标色 —— 刻意与上面的 `TYPE_FILL` 分开，是**另起的一套多色盘**。
 *
 * 为什么不复用标签底色：标签那套按上一轮的要求统一走绿系，而这一轮的诉求恰恰是
 * 「用不同颜色帮用户区分分类」。两套各管一摊，改其中一个不会牵动另一个。
 *
 * 色相从靛蓝（~230）到玫红（~325）绕一圈，刻意避开高饱和：每个色在白底上都在
 * 4.2:1 以上，既能看清，放一排也不会花。
 */
export const TYPE_ICON_COLOR: Record<string, string> = {
  政策法规: '#3a4c9e', // 靛蓝
  研究报告: '#0b7d7a', // 青绿
  研究实践报告: '#6355b0', // 蓝紫
  各类标准: '#48688c', // 灰蓝
  案例工具: '#a3621a', // 暖橙
  国内政策法规: '#9c5030', // 红棕
  国际公约: '#1a7ba6', // 青蓝
  科学认知: '#a9468c', // 玫红紫
}

/** 未登记类型的兜底色（后端将来新增类型时不会渲染成空图标或黑块） */
const FALLBACK_ICON_COLOR = '#5b7189'

/**
 * 图标形状：24×24 网格上的细线图形，只写 <path>/<circle>/<rect>。
 *
 * 设计取舍：八个图形选**轮廓互不相同**的形体（天平 / 柱状图 / 剪贴板 / 盾牌 /
 * 工具箱 / 政府大楼 / 地球 / 灯泡）。16px 这个尺寸下，靠内部细节区分的图标会糊成
 * 一团，靠外形区分、再由旁边的分类文字确认，才是小尺寸里真正读得出来的做法。
 */
const ICON_BODY: Record<string, string> = {
  // 天平 —— 法条、规则
  政策法规:
    "<path d='M12 3.4v15.2'/><path d='M7.6 18.6h8.8'/><path d='M4.4 7.4h15.2'/>" +
    "<path d='M7 7.4 5.2 12.7a1.9 1.9 0 0 0 3.6 0Z'/>" +
    "<path d='M17 7.4 15.2 12.7a1.9 1.9 0 0 0 3.6 0Z'/>",
  // 柱状图 —— 数据、研究报告
  研究报告:
    "<path d='M3.9 19.6h16.2'/><path d='M7.2 19.6v-7.4'/><path d='M12 19.6V7.8'/><path d='M16.8 19.6v-4.2'/>",
  // 剪贴板 + 勾 —— 实践记录、项目报告
  研究实践报告:
    "<path d='M9.4 4.6H7.8A2 2 0 0 0 5.8 6.6v11.6a2 2 0 0 0 2 2h8.4a2 2 0 0 0 2-2V6.6a2 2 0 0 0-2-2h-1.6'/>" +
    "<rect x='9.4' y='3' width='5.2' height='3.2' rx='1.1'/>" +
    "<path d='M9.6 13.4l1.8 1.8 3.2-3.4'/>",
  // 盾牌 + 勾 —— 合规、标准
  各类标准:
    "<path d='M12 3.2 18.8 5.8v5.9c0 4.2-2.7 7.3-6.8 8.6-4.1-1.3-6.8-4.4-6.8-8.6V5.8z'/>" +
    "<path d='M9.2 12.2l2 2 3.6-3.8'/>",
  // 工具箱 —— 工具、方法
  案例工具:
    "<rect x='3.2' y='8.2' width='17.6' height='11.4' rx='2.2'/>" +
    "<path d='M9 8.2V6.8a1.6 1.6 0 0 1 1.6-1.6h2.8A1.6 1.6 0 0 1 15 6.8v1.4'/>" +
    "<path d='M3.2 12.7h17.6'/><path d='M12 11.6v2.2'/>",
  // 政府大楼 —— 国内官方文件
  国内政策法规:
    "<path d='M3.4 9.8 12 4.4l8.6 5.4z'/>" +
    "<path d='M7.2 9.8v7'/><path d='M12 9.8v7'/><path d='M16.8 9.8v7'/>" +
    "<path d='M4.8 19.6h14.4'/>",
  // 地球 —— 国际、公约
  国际公约:
    "<circle cx='12' cy='12' r='8.6'/><path d='M3.4 12h17.2'/>" +
    "<path d='M12 3.4c2.4 2.5 3.6 5.4 3.6 8.6s-1.2 6.1-3.6 8.6c-2.4-2.5-3.6-5.4-3.6-8.6S9.6 5.9 12 3.4Z'/>",
  // 摊开的书 —— 科普、知识（灯泡试过两版，16px 下都糊成定位图钉；
  //     摊开的书轮廓是独一份的，小尺寸也认得出「知识」）
  科学认知:
    "<path d='M12 6.8C10.2 5.3 7.9 4.8 5.4 5.2v12c2.5-.4 4.8.1 6.6 1.6 1.8-1.5 4.1-2 6.6-1.6v-12c-2.5-.4-4.8.1-6.6 1.6z'/>" +
    "<path d='M12 6.8v12'/>",
}

/** 兜底形状：一张普通文件 */
const FALLBACK_ICON_BODY =
  "<path d='M6.4 3.2h7.2l4.4 4.4v13.2H6.4z'/><path d='M13.4 3.2v4.6h4.6'/><path d='M9 13h6'/><path d='M9 16.6h6'/>"

/**
 * 把图标包成 CSS `mask` 能用的 url()。
 *
 * 为什么走遮罩而不是直接当背景图：遮罩只取**形状**，颜色留给 CSS 的
 * background-color 决定。于是同一份形状能落在四种状态上（标签默认 / 标签悬停 /
 * 标签选中 / 卡片标签）各取各的颜色，既不必为每种状态各存一份图标，也保证了
 * 「顶部分类导航」与「卡片分类标签」用的天然是同一枚图形。
 */
function iconMask(body: string): string {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' " +
    `stroke='#000' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`
  // 编码后把合法又可读的几个字符还原（data URI 能短掉近一半）。
  // `#` 必须保持 %23 —— 原样写会被浏览器当成锚点，后面的内容全被截掉。
  const encoded = encodeURIComponent(svg)
    .replace(/%2F/g, '/')
    .replace(/%3D/g, '=')
    .replace(/%3A/g, ':')
    .replace(/%2C/g, ',')
  return `url("data:image/svg+xml,${encoded}")`
}

const iconCache = new Map<string, string>()

/** 取某类型的图标遮罩。列表里同一类型会出现几十次，必须缓存，否则每次都重算整串 URI */
export function iconMaskOf(type: string): string {
  const hit = iconCache.get(type)
  if (hit) return hit
  const uri = iconMask(ICON_BODY[type] ?? FALLBACK_ICON_BODY)
  iconCache.set(type, uri)
  return uri
}

/** 取某类型的图标颜色 */
export function iconColorOf(type: string): string {
  return TYPE_ICON_COLOR[type] ?? FALLBACK_ICON_COLOR
}
