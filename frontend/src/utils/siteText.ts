/**
 * 站点文案的排版小工具（2026-10-22）
 *
 * 首页与「机构信息」管理台的实时预览都用这几条规则，收在一处，避免两边排版跑偏：
 *   - 正文：空一行 = 分一段
 *   - 条目正文：每行一条（首页渲染成圆点列表）
 *   - 行内加粗：用 **两个星号** 包住（老师可写，也用于保留原页面里的 <strong> 强调）
 */

/** 正文 → 段落数组（空行分段；没有内容返回空数组） */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/** 条目正文 → 行数组（用于「核心方向」这种每行一条的列表） */
export function splitLines(text: string): string[] {
  return text
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 行内加粗：`**文字**` → `<strong>文字</strong>`。
 *
 * 🔴 先整体转义，再只把 `**` 换成标签 —— 输出的 HTML 里除了 <strong>
 *    不可能出现别的标签（老师从别处粘过来的 <script> 只会变成可见文本）。
 *    所以这里可以安全地交给 v-html，不需要再跑一遍 DOMPurify。
 */
export function inlineBold(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(/\*\*([^*\n]{1,80}?)\*\*/g, '<strong>$1</strong>')
}
