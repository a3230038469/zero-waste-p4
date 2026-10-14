/**
 * 极简 Markdown 渲染 —— AI 问答气泡用（2026-10-14 新增）
 *
 * 背景：AI 的回答是按 Markdown 组织的（`**加粗**`、`- 列表`、`### 标题`、行内 `代码`），
 * 而问答窗口原先用纯文本插值 + `white-space: pre-wrap` 渲染，符号全裸露在页面上，
 * 读起来很糟。这里给一个够用的渲染器。
 *
 * ⚠️ 安全是第一位，这不是可选项：
 *   渲染结果要交给 `v-html`，而输入是**模型生成的文本**（间接来自知识库内容与用户提问）。
 *   所以流程必须是「**先整体 HTML 转义，再做白名单替换**」——
 *   先转义保证原文里任何标签都不可能变成真标签，后面的替换只会生成我们自己写的固定标签。
 *   绝不允许反过来（先替换后转义），也绝不允许直接把原文塞进 v-html。
 *   链接也只认 `http(s)://`，挡掉 `javascript:` 这类伪协议。
 *
 * 为什么不用 marked / markdown-it：
 *   它们是完整的 Markdown 实现，体积可观，而这里只需要气泡里那几种语法。
 *   本项目连图表都是手写 CSS/SVG（见 InsightsView），不为一个气泡引一个解析库。
 *
 * 为什么支持「流式半成品」：
 *   回答是逐字吐出来的，渲染时会经常遇到没闭合的 `**`。本渲染器不做配平，
 *   未闭合的标记就原样显示，等后续字符到齐再自然闭合 —— 不会报错、也不会吞文本。
 */

/** HTML 转义。必须在任何替换之前调用 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 控制字符对展示没有意义，且会干扰下面的占位符方案，先清掉。
 *
 * 用 Unicode 类别 `\p{Cc}` 而不是写一串字面量控制字符：后者会在正则里
 * 留下真实的不可见字符，eslint 会报 `no-control-regex`，代码审阅时也看不见。
 * ⚠️ `\p{Cc}` 把 `\n` `\r` `\t` 也算在内，这三个必须留下（换行是块解析的依据）。
 */
function stripControlChars(input: string): string {
  return input.replace(/\p{Cc}/gu, (ch) => (ch === '\n' || ch === '\r' || ch === '\t' ? ch : ''))
}

/** 占位符：行内代码先抽出来存着，避免代码里的 * 被当成强调 */
const CODE_SLOT = '\u0001'

/**
 * 行内语法：行内代码 / 粗体 / 斜体 / 链接。
 * 输入必须是**已转义**的文本。
 */
function renderInline(escaped: string): string {
  const codes: string[] = []

  // 1) 先抽行内代码（其中的内容不再参与后续替换）
  let out = escaped.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codes.push(`<code>${code}</code>`)
    return `${CODE_SLOT}${codes.length - 1}${CODE_SLOT}`
  })

  // 2) 粗体（**x**）。先于斜体处理，否则 ** 会被斜体规则吃掉一个 *
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')

  // 3) 斜体（*x*）。要求两侧不是 *，且不跨行；不用下划线形式 ——
  //    中文资料里 snake_case、文件名下划线太常见，误伤代价比收益大
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')

  // 4) 链接。只认 http(s)，挡掉 javascript: 之类伪协议。
  //    括号内的 URL 已被转义，注入引号只会变成 &quot;，无法逃出属性。
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  )

  // 5) 把行内代码放回
  return out.replace(new RegExp(`${CODE_SLOT}(\\d+)${CODE_SLOT}`, 'g'), (_m, i: string) => codes[Number(i)] ?? '')
}

/** 识别块级行 */
const RE_BULLET = /^\s*[-*+]\s+(.*)$/
/**
 * 有序列表。
 *
 * ⚠️ 刻意写成两种分支：
 *   - `1. ` / `1) ` 后面**必须**有空格。若允许无空格，`3.5 亿元` 这类小数会被误判成列表项。
 *   - 中文顿号 `1、` 后面**可以**没有空格 —— 中文写作习惯就是「1、分类投放」这样写，
 *     要求空格等于这个分支永远不会命中（这正是第一版漏掉的情况）。
 */
const RE_ORDERED = /^\s*\d+(?:[.)]\s+|、\s*)(.*)$/
const RE_HEADING = /^\s*#{1,6}\s+(.*)$/
/**
 * 引用。注意匹配的是 `&gt;` 而不是 `>`：
 * 正文在进块解析**之前**已经整体 HTML 转义过了（这是安全前提，不能改顺序），
 * 所以引号 `>` 到这里已经是实体了。写成 `>` 会永远匹配不到。
 */
const RE_QUOTE = /^\s*&gt;\s?(.*)$/

/**
 * 把一段（可能还在增长的）Markdown 渲染成 HTML 字符串。
 * 返回的 HTML 只含本文件里写死的那几种标签，可安全交给 v-html。
 */
export function renderMarkdown(raw: string): string {
  const text = escapeHtml(stripControlChars(raw)).replace(/\r\n?/g, '\n')
  const out: string[] = []

  /** 累积中的段落（连续的普通行，用 <br> 连接） */
  let paragraph: string[] = []
  /** 累积中的列表 */
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`)
    paragraph = []
  }
  const flushList = (): void => {
    if (!list) return
    const items = list.items.map((item) => `<li>${item}</li>`).join('')
    out.push(`<${list.type}>${items}</${list.type}>`)
    list = null
  }
  const flushAll = (): void => {
    flushParagraph()
    flushList()
  }

  for (const line of text.split('\n')) {
    const bullet = RE_BULLET.exec(line)
    const ordered = RE_ORDERED.exec(line)

    if (bullet || ordered) {
      const type: 'ul' | 'ol' = bullet ? 'ul' : 'ol'
      const content = renderInline((bullet ?? ordered)?.[1] ?? '')
      // 列表类型切换（或从段落切过来）时，先把上一块收掉
      flushParagraph()
      if (list && list.type !== type) flushList()
      if (!list) list = { type, items: [] }
      list.items.push(content)
      continue
    }

    // 空行：段落/列表的天然分隔
    if (!line.trim()) {
      flushAll()
      continue
    }

    const heading = RE_HEADING.exec(line)
    if (heading) {
      flushAll()
      // 统一落到 h4：气泡里再分六级标题没有意义，字号反而不受控
      out.push(`<h4>${renderInline(heading[1])}</h4>`)
      continue
    }

    const quote = RE_QUOTE.exec(line)
    if (quote) {
      flushAll()
      out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`)
      continue
    }

    flushList()
    paragraph.push(line)
  }

  flushAll()
  return out.join('')
}

/**
 * 清掉知识库引用标签（`<kb doc="…" chunk_id="…" />`）—— 对读者太吵。
 * 顺带压掉替换后留下的多余空行。放在 Markdown 渲染**之前**做，
 * 因为这些标签必须先消失，否则会被当成普通文本渲染出来。
 */
export function stripSourceTags(text: string): string {
  return text
    .replace(/<kb\s+doc="[^"]*"[^>]*\/?>/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
}
