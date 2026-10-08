/**
 * 批量导入 · 字段归一化 —— 负责人：韶茹
 *
 * 三件事最容易出错，都在这里集中处理（各有实测踩坑原因）：
 *   1. **ZIP 里的中文文件名**：Windows 打出来的 ZIP 用 GBK 存名字，
 *      解压工具按 CP437 解 → 变成 `Ç³¦Ĉü....pdf` 这样的乱码，必须还原才能和元数据对上。
 *   2. **声明大小是字符串**（"0.91MB"）：契约要求索引里给**字节数**（number），得换算。
 *   3. **多值字段**：tags 可能是数组、也可能是逗号串，统一成数组。
 */
import type { MetaRow, RawMetaRow } from './types.js'

/**
 * CP437 的 0x80–0xFF 段（按字节序排列）。
 * 用它把「被按 CP437 解码的中文名」逐字符退回原始字节，再用 GBK 重解。
 */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0'

const CP437_REVERSE = new Map<string, number>()
for (let i = 0; i < CP437_HIGH.length; i += 1) {
  CP437_REVERSE.set(CP437_HIGH[i] as string, 0x80 + i)
}

/** 名字里是否出现 CP437 高段字符（= 疑似乱码）。纯 ASCII 名字直接跳过，不做无谓转换。 */
function looksLikeCp437Mojibake(name: string): boolean {
  for (const char of name) {
    if (CP437_REVERSE.has(char)) return true
  }
  return false
}

/**
 * 还原被 CP437 误解的 GBK 文件名。
 * 还原不出合法结果（含 U+FFFD 或整串没变化）时**原样返回**，绝不把好名字改坏。
 */
export function decodeZipName(name: string): { name: string; restored: boolean } {
  if (!looksLikeCp437Mojibake(name)) return { name, restored: false }

  const bytes: number[] = []
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) {
      bytes.push(code)
      continue
    }
    const mapped = CP437_REVERSE.get(char)
    if (mapped === undefined) return { name, restored: false } // 混了别的字符，不敢动
    bytes.push(mapped)
  }

  try {
    const decoded = new TextDecoder('gbk').decode(Buffer.from(bytes))
    if (!decoded || decoded.includes('\uFFFD')) return { name, restored: false }
    return { name: decoded, restored: true }
  } catch {
    return { name, restored: false }
  }
}

/**
 * 把声明大小换算成字节数。支持 "0.91MB" / "1.2 MB" / "954204" / "1.5GB"。
 * 认不出来返回 null（不阻断导入，只在报告里提示）。
 */
export function parseSizeToBytes(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value !== 'string') return null

  const text = value.trim()
  if (!text) return null

  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)?$/i.exec(text)
  if (match === null) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null

  const unit = (match[2] ?? 'B').toUpperCase()
  const factor =
    unit === 'TB' ? 1024 ** 4 : unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1
  return Math.round(amount * factor)
}

/** tags：数组直接用，字符串按中英文逗号/分号/竖线切（用不到就返回空数组） */
export function toTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((t) => String(t).trim()).filter((t) => t !== '')
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(/[,，;；|]/)
      .map((t) => t.trim())
      .filter((t) => t !== '')
  }
  return []
}

/** 字段取值：非字符串/空串一律给兜底值，且把问题记进 warnings */
export function readField(
  raw: RawMetaRow,
  key: keyof RawMetaRow,
  rowNumber: number,
  fallback: string,
  warnings: string[]
): string {
  const value = raw[key]
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  warnings.push(`第 ${rowNumber} 行缺字段 ${String(key)}，已回落为「${fallback}」`)
  return fallback
}

/** 年份：非数字/显然不合理的年份给 0，并在报告里提示 */
export function parseYear(value: unknown, rowNumber: number, warnings: string[]): number {
  const num = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(num) || num < 1900 || num > 2100) {
    warnings.push(`第 ${rowNumber} 行年份不合法：${String(value ?? '(空)')}，已置 0`)
    return 0
  }
  return Math.trunc(num)
}

/** 归一化一条元数据行 */
export function normalizeMetaRow(raw: RawMetaRow, rowNumber: number, warnings: string[]): MetaRow {
  const fileNameRaw = readField(raw, 'file_name', rowNumber, '', warnings)
  const decoded = decodeZipName(fileNameRaw)

  const sizeText = typeof raw.size === 'string' ? raw.size.trim() : ''
  return {
    rowNumber,
    title: readField(raw, 'title', rowNumber, '未命名', warnings),
    org: readField(raw, 'org', rowNumber, '未标注', warnings),
    year: parseYear(raw.year, rowNumber, warnings),
    type: readField(raw, 'type', rowNumber, '未分类', warnings),
    tags: toTags(raw.tags),
    sizeDeclared: parseSizeToBytes(raw.size),
    sizeText,
    sourceUrl: readField(raw, 'source_url', rowNumber, '', warnings),
    fileName: decoded.name
  }
}

/**
 * 兜底匹配用的签名：去扩展名 + 去掉空白与标点。
 * 用于「元数据写的名字和实际文件名差一个空格/全半角」这类小差异。
 */
export function fileSignature(name: string): string {
  return name
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[\s\u3000_\-—–·、,，.。()（）[\]【】]/g, '')
    .toLowerCase()
}
