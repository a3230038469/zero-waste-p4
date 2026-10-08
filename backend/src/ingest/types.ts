/**
 * 批量导入 · 类型 —— 负责人：韶茹
 *
 * 输入：静柔（B09）产出的元数据表（JSON）+ 一批 PDF 原件
 * 输出：backend/data/kb-index.json（后端本地资料包读的就是它）+ 导入报告
 *
 * 索引条目的字段名与 backend/src/weknora/types.ts 的 KbDocInternal 严格一致
 * （filePath 是**相对 backend/data** 的路径，绝不写本机绝对路径——队友直接能用）。
 */

/** 元数据表里的一行（原始形状，字段可能缺） */
export interface RawMetaRow {
  id?: unknown
  title?: unknown
  org?: unknown
  year?: unknown
  type?: unknown
  tags?: unknown
  /** 声明大小，形如 "0.91MB" */
  size?: unknown
  source_url?: unknown
  file_name?: unknown
}

/** 归一化后的一行元数据 */
export interface MetaRow {
  /** 元数据表里的原始序号，仅用于报错定位 */
  rowNumber: number
  title: string
  org: string
  year: number
  type: string
  tags: string[]
  /** 声明大小的字节数（按 1MB = 1024KB 换算）；解析不出来时 null */
  sizeDeclared: number | null
  /** 声明大小的原文，报告里给人看 */
  sizeText: string
  sourceUrl: string
  fileName: string
}

/** kb-index.json 里的一条资料 */
export interface IndexItem {
  id: string
  title: string
  org: string
  year: number
  type: string
  tags: string[]
  /** 实际字节数（number，不是 "0.9MB" 字符串） */
  size: number
  sourceUrl: string
  fileName: string
  /** 相对 backend/data 的路径，如 kb/xxx.pdf */
  filePath: string
  /** 元数据表声明的大小，仅用于人工核对 */
  sizeDeclared: number | null
}

/** kb-index.json 整体形状（与现网文件保持一致，别改字段名） */
export interface KbIndexFile {
  generatedFrom: string
  count: number
  items: IndexItem[]
}

/** 一条「元数据说要这个文件、目录里却没有」的记录 */
export interface MissingFile {
  rowNumber: number
  expected: string
  title: string
}

/** 大小对不上的记录 */
export interface SizeMismatch {
  fileName: string
  declaredBytes: number
  actualBytes: number
  /** 相对偏差（绝对值），0.05 = 差 5% */
  deltaRatio: number
}

/** 导入报告（人看 markdown/文本，机读 --json） */
export interface ImportReport {
  generatedAt: string
  metaFile: string
  pdfDir: string
  outFile: string | null
  dryRun: boolean
  counts: {
    /** 元数据行数 */
    meta: number
    /** 目录里的 PDF 文件数 */
    pdf: number
    /** 匹配上的资料份数 */
    matched: number
    /** 实际写入索引的条数（dryRun 时为 0） */
    written: number
  }
  /** 有多少个文件名是靠 cp437→GBK 还原回来的（ZIP 解压常见的坑） */
  nameRestored: number
  /** 靠「去掉扩展名后归一化」的兜底规则匹配上的（不是精确同名） */
  matchedByFallback: { expected: string; actual: string }[]
  missingFiles: MissingFile[]
  extraFiles: string[]
  sizeMismatch: SizeMismatch[]
  /** 元数据字段层面的问题（缺字段、年份非法等） */
  fieldWarnings: string[]
  /** 标题重复（会造成用户分不清，但不阻断导入） */
  duplicateTitles: string[]
  /** 致命问题：有这些就不该写索引 */
  errors: string[]
}
