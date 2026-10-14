/**
 * CSV 序列化 —— 数据导出配套（2026-10-14 新增）
 *
 * 为什么单独一个文件、而不是写在导出路由里：
 *   导出有三处（资料台账 / 注册用户 / 统计报表）。转义规则若有第二份实现，
 *   哪天只改了其中一处，就会导出出「某些行列数不对」的文件 —— 这种错在 Excel 里
 *   看着只是排版乱，非常难发现。转义规则必须只有一份实现。
 *
 * 两个必须做对的点：
 *   1. **UTF-8 BOM**。Excel 打开不带 BOM 的 UTF-8 CSV 时，会按系统本地编码
 *      （简体中文 Windows 下是 GBK）去解，中文全变乱码；加上 BOM 就正常。
 *      这是「双击能直接打开」的唯一前提。
 *   2. **转义**。字段含 `,` `"` 或换行时必须用双引号包起来、内部 `"` 写成 `""`。
 *      ⚠️ 本项目真实数据里机构名自带逗号（如「环境保护部,国家质量监督检验检疫总局」），
 *      不转义的话这一列会整体右移，而且每行的列数还不一致。
 */

/** UTF-8 BOM：让 Excel 认出这是 UTF-8，而不是本地编码 */
export const UTF8_BOM = '\uFEFF'

/** 会被表格软件当成「公式起始」的字符（CSV 注入） */
const FORMULA_LEAD = /^[=+\-@\t\r]/

/** 纯数字（含负号与小数）。这类不该被当公式，否则负数会被硬塞一个前置引号 */
const PURE_NUMBER = /^-?\d+(?:\.\d+)?$/

/**
 * 转义一个单元格。
 *
 * 顺带做 CSV 注入防护：以 `= + - @` 开头的文本在 Excel 里会被当公式执行，
 * 而本站的「反馈内容」「用户姓名 / 机构」是**访客提交的**、不可信，必须阻断。
 * 前缀一个单引号即可（Excel 显示时会把引号藏掉，肉眼看到的内容不变）。
 */
function escapeCell(raw: unknown): string {
  const value = raw === null || raw === undefined ? '' : String(raw)
  if (value === '') return ''

  const cell = !PURE_NUMBER.test(value) && FORMULA_LEAD.test(value) ? `'${value}` : value

  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
}

/**
 * 把一张表序列化成 CSV 文本（含 BOM）。
 * 返回值可直接作为响应体，也可 writeFileSync 落盘。
 */
export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [headers.map(escapeCell).join(',')]
  for (const row of rows) lines.push(row.map(escapeCell).join(','))
  // 行尾用 CRLF：RFC 4180 要求，且 Excel 最稳
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`
}
