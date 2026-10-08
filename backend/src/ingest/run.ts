/**
 * 批量导入 · 主流程 —— 负责人：韶茹
 *
 * 元数据表（JSON）×  PDF 原件目录  →  校验  →  kb-index.json + 导入报告
 *
 * 为什么要有这个工具：
 *   上一轮索引是靠临时脚本拼出来的，换台机器 / 换一批资料就得重来一遍，
 *   而且「元数据说有、目录里没有」这种问题只在跑起来之后才暴露。
 *   现在把它固化成一条命令，任何人（静柔补资料、瑞泽换演示机）都能自己跑。
 *
 * 安全性：默认**只写索引文件**，不动 PDF、不删东西、不碰引擎。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

import { decodeZipName, fileSignature, normalizeMetaRow } from './normalize.js'
import type {
  ImportReport,
  IndexItem,
  KbIndexFile,
  MetaRow,
  MissingFile,
  RawMetaRow,
  SizeMismatch
} from './types.js'

/** 默认的大小核对容差：声明值与实际值相差超过 5% 就记一条 */
const DEFAULT_SIZE_TOLERANCE = 0.05

/** 只认 PDF（后续要收别的格式，在这里放行） */
const ALLOWED_EXTENSIONS = new Set(['.pdf'])

export interface ImportOptions {
  metaFile: string
  pdfDir: string
  outFile: string
  /** 只看报告，不写文件 */
  dryRun: boolean
  sizeTolerance?: number
}

/** 目录里的一个候选文件 */
interface PdfFile {
  /** 磁盘上的真实名字（可能已做过 CP437 还原） */
  name: string
  abs: string
  size: number
  /** 是否靠 CP437→GBK 还原回来的 */
  restored: boolean
  used: boolean
}

/* ------------------------------------------------------------------ *
 * 读入
 * ------------------------------------------------------------------ */

/** 读元数据表：必须是 JSON 数组（顶层对象里带 items 也认） */
export function loadMeta(metaFile: string, warnings: string[]): RawMetaRow[] {
  if (!existsSync(metaFile)) {
    throw new Error(`元数据文件不存在：${metaFile}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(metaFile, 'utf8'))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`元数据不是合法 JSON：${metaFile}（${detail}）`)
  }

  let rows: unknown
  if (Array.isArray(parsed)) rows = parsed
  else if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).items)) {
    const envelope = parsed as Record<string, unknown>
    rows = envelope.items
    warnings.push(`元数据顶层不是数组，已改用其 items 字段（${(rows as unknown[]).length} 行）`)
  }

  if (!Array.isArray(rows)) {
    throw new Error(`元数据结构不认识：需要 JSON 数组，或含 items 数组的对象（${metaFile}）`)
  }
  return rows as RawMetaRow[]
}

/** 扫 PDF 目录，顺带把乱码文件名还原回去 */
export function scanPdfDir(pdfDir: string): PdfFile[] {
  if (!existsSync(pdfDir)) {
    throw new Error(`PDF 目录不存在：${pdfDir}`)
  }
  const files: PdfFile[] = []
  for (const entry of readdirSync(pdfDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (!ALLOWED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
    const abs = join(pdfDir, entry.name)
    const decoded = decodeZipName(entry.name)
    files.push({
      name: decoded.name,
      abs,
      size: statSync(abs).size,
      restored: decoded.restored,
      used: false
    })
  }
  return files
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

export interface ImportResult {
  report: ImportReport
  index: KbIndexFile | null
  /** 人看的报告文本 */
  text: string
}

export function runImport(options: ImportOptions): ImportResult {
  const tolerance = options.sizeTolerance ?? DEFAULT_SIZE_TOLERANCE
  const warnings: string[] = []
  const errors: string[] = []

  const metaFile = resolve(options.metaFile)
  const pdfDir = resolve(options.pdfDir)
  const outFile = resolve(options.outFile)

  const rawRows = loadMeta(metaFile, warnings)
  const pdfFiles = scanPdfDir(pdfDir)

  const missingFiles: MissingFile[] = []
  const matchedByFallback: { expected: string; actual: string }[] = []
  const sizeMismatch: SizeMismatch[] = []
  const items: IndexItem[] = []

  const byName = new Map<string, PdfFile>()
  for (const file of pdfFiles) byName.set(file.name, file)
  const bySignature = new Map<string, PdfFile>()
  for (const file of pdfFiles) {
    const sig = fileSignature(file.name)
    if (!bySignature.has(sig)) bySignature.set(sig, file)
  }

  const dataRoot = dirname(outFile)
  const seenRows = new Set<string>()

  rawRows.forEach((raw, index) => {
    const rowNumber = index + 1
    const row: MetaRow = normalizeMetaRow(raw, rowNumber, warnings)

    if (row.fileName === '') {
      missingFiles.push({ rowNumber, expected: '(元数据没写 file_name)', title: row.title })
      return
    }
    if (seenRows.has(row.fileName)) {
      warnings.push(`第 ${rowNumber} 行与前面某行的 file_name 重复：${row.fileName}`)
    }
    seenRows.add(row.fileName)

    let file = byName.get(row.fileName)
    if (file === undefined) {
      // 兜底：差空格 / 全半角标点这类小差异
      const fallback = bySignature.get(fileSignature(row.fileName))
      if (fallback !== undefined && !fallback.used) {
        file = fallback
        matchedByFallback.push({ expected: row.fileName, actual: fallback.name })
      }
    }
    if (file === undefined) {
      missingFiles.push({ rowNumber, expected: row.fileName, title: row.title })
      return
    }

    file.used = true

    if (row.sizeDeclared !== null && file.size > 0) {
      const delta = Math.abs(file.size - row.sizeDeclared) / Math.max(row.sizeDeclared, 1)
      if (delta > tolerance) {
        sizeMismatch.push({
          fileName: file.name,
          declaredBytes: row.sizeDeclared,
          actualBytes: file.size,
          deltaRatio: Math.round(delta * 10_000) / 10_000
        })
      }
    }

    items.push({
      id: `k-${rowNumber}`,
      title: row.title,
      org: row.org,
      year: row.year,
      type: row.type,
      tags: row.tags,
      // 契约要求字节数：以**磁盘实际大小**为准（声明值只留作核对）
      size: file.size,
      sourceUrl: row.sourceUrl,
      fileName: file.name,
      filePath: toPosix(relative(dataRoot, file.abs)),
      sizeDeclared: row.sizeDeclared
    })
  })

  const extraFiles = pdfFiles.filter((f) => !f.used).map((f) => f.name)

  if (items.length === 0) {
    errors.push('一份都没匹配上——检查 pdfDir 是否指到了正确的目录（元数据里的 file_name 要与文件名一致）')
  }

  const duplicateTitles = findDuplicates(items.map((item) => item.title))
  const index: KbIndexFile = {
    generatedFrom: relative(dirname(metaFile), metaFile) || metaFile,
    count: items.length,
    items
  }

  const report: ImportReport = {
    generatedAt: new Date().toISOString(),
    metaFile,
    pdfDir,
    outFile: options.dryRun ? null : outFile,
    dryRun: options.dryRun,
    counts: {
      meta: rawRows.length,
      pdf: pdfFiles.length,
      matched: items.length,
      written: options.dryRun || errors.length > 0 ? 0 : items.length
    },
    nameRestored: pdfFiles.filter((f) => f.restored).length,
    matchedByFallback,
    missingFiles,
    extraFiles,
    sizeMismatch,
    fieldWarnings: warnings,
    duplicateTitles,
    errors
  }

  if (!options.dryRun && errors.length === 0) {
    mkdirSync(dirname(outFile), { recursive: true })
    writeFileSync(outFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  }

  return { report, index: errors.length === 0 ? index : null, text: renderReport(report) }
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`

/** 人看的文本报告 */
export function renderReport(report: ImportReport): string {
  const lines: string[] = []
  const c = report.counts

  lines.push(`零废弃知识库 · 批量导入报告${report.dryRun ? '（DRY RUN，未写文件）' : ''}`)
  lines.push(`生成时间：${report.generatedAt}`)
  lines.push(`元数据   ：${report.metaFile}`)
  lines.push(`PDF 目录 ：${report.pdfDir}`)
  lines.push(`索引输出 ：${report.outFile ?? '(未写)'}`)
  lines.push('')
  lines.push('— 数量 —')
  lines.push(`元数据行数 ${c.meta} ｜ 目录里 PDF ${c.pdf} ｜ 匹配上 ${c.matched} ｜ 已写入 ${c.written}`)
  if (report.nameRestored > 0) {
    lines.push(`文件名还原：${report.nameRestored} 个（ZIP 解压出来的 GBK 乱码，已自动还原）`)
  }

  if (report.errors.length > 0) {
    lines.push('')
    lines.push('— 致命问题（未写索引）—')
    for (const item of report.errors) lines.push(`  ✗ ${item}`)
  }

  if (report.missingFiles.length > 0) {
    lines.push('')
    lines.push(`— 元数据有、目录里没有（${report.missingFiles.length} 条）—`)
    for (const item of report.missingFiles) {
      lines.push(`  ✗ 第 ${item.rowNumber} 行：${item.expected}`)
    }
  }

  if (report.extraFiles.length > 0) {
    lines.push('')
    lines.push(`— 目录里有、元数据没提（${report.extraFiles.length} 个）—`)
    for (const name of report.extraFiles) lines.push(`  ? ${name}`)
  }

  if (report.matchedByFallback.length > 0) {
    lines.push('')
    lines.push(`— 靠兜底规则匹配（${report.matchedByFallback.length} 条，建议统一文件名）—`)
    for (const item of report.matchedByFallback) {
      lines.push(`  ~ 元数据写「${item.expected}」，实际用「${item.actual}」`)
    }
  }

  if (report.sizeMismatch.length > 0) {
    lines.push('')
    lines.push(`— 大小对不上（${report.sizeMismatch.length} 条，超过容差才算）—`)
    for (const item of report.sizeMismatch) {
      lines.push(
        `  ! ${item.fileName}：声明 ${item.declaredBytes} B ／ 实际 ${item.actualBytes} B（差 ${pct(item.deltaRatio)}）`
      )
    }
  }

  if (report.duplicateTitles.length > 0) {
    lines.push('')
    lines.push(`— 标题重复（${report.duplicateTitles.length} 个，用户会分不清）—`)
    for (const title of report.duplicateTitles) lines.push(`  ! ${title}`)
  }

  if (report.fieldWarnings.length > 0) {
    lines.push('')
    lines.push(`— 字段提示（${report.fieldWarnings.length} 条）—`)
    for (const item of report.fieldWarnings) lines.push(`  · ${item}`)
  }

  lines.push('')
  if (report.errors.length > 0) {
    lines.push('结论：有致命问题，索引未写入。修完再跑一次。')
  } else if (report.dryRun) {
    lines.push('结论：预演通过（未写文件）。去掉 --dry-run 即可生成索引。')
  } else {
    lines.push(`结论：已写入 ${report.counts.written} 条到 ${report.outFile}`)
  }
  return lines.join('\n')
}

function findDuplicates(values: string[]): string[] {
  const counter = new Map<string, number>()
  for (const value of values) counter.set(value, (counter.get(value) ?? 0) + 1)
  return [...counter.entries()].filter(([, n]) => n > 1).map(([value]) => value)
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}
