/**
 * 批量导入 · 命令行入口 —— 负责人：韶茹
 *
 * 用法（在仓库根目录）：
 *   npm run ingest -- --meta ../零废弃知识库-元数据_v3.json
 *   npm run ingest -- --meta <元数据.json> --pdf backend/data/kb --out backend/data/kb-index.json
 *   npm run ingest -- --meta <元数据.json> --dry-run        # 只看报告，不写文件
 *   npm run ingest -- --meta <元数据.json> --json          # 报告给机器读
 *
 * 默认值按仓库目录约定走：PDF 放 backend/data/kb，索引写 backend/data/kb-index.json。
 * 退出码：0 = 成功（含只有警告）；1 = 有致命问题或参数/IO 出错。
 */
import { fileURLToPath } from 'node:url'

import { runImport } from './run.ts'

const DEFAULT_PDF_DIR = fileURLToPath(new URL('../../data/kb/', import.meta.url))
const DEFAULT_OUT_FILE = fileURLToPath(new URL('../../data/kb-index.json', import.meta.url))

interface CliOptions {
  meta: string
  pdf: string
  out: string
  dryRun: boolean
  json: boolean
  tolerance: number | undefined
}

const USAGE = `零废弃知识库 · 批量导入工具

用法：
  npm run ingest -- --meta <元数据.json> [选项]

选项：
  --meta <path>       元数据表 JSON（必填）
  --pdf <dir>         PDF 原件目录（默认 backend/data/kb）
  --out <file>        索引输出路径（默认 backend/data/kb-index.json）
  --dry-run           只出报告，不写索引
  --json              报告以 JSON 输出（给脚本用）
  --tolerance <n>     大小核对容差，0.05 = 5%（默认 0.05）
  -h, --help          看这段说明

例子：
  npm run ingest -- --meta ../零废弃知识库-元数据_v3.json --dry-run
`

/** 极简参数解析：够用就好，不引依赖 */
function parseArgs(argv: string[]): CliOptions | 'help' {
  const options: CliOptions = {
    meta: '',
    pdf: DEFAULT_PDF_DIR,
    out: DEFAULT_OUT_FILE,
    dryRun: false,
    json: false,
    tolerance: undefined
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    switch (arg) {
      case '-h':
      case '--help':
        return 'help'
      case '--dry-run':
        options.dryRun = true
        break
      case '--json':
        options.json = true
        break
      case '--meta':
        options.meta = argv[++i] ?? ''
        break
      case '--pdf':
        options.pdf = argv[++i] ?? ''
        break
      case '--out':
        options.out = argv[++i] ?? ''
        break
      case '--tolerance': {
        const value = Number(argv[++i] ?? '')
        options.tolerance = Number.isFinite(value) ? value : undefined
        break
      }
      default:
        if (arg.startsWith('--')) throw new Error(`不认识的参数：${arg}（--help 看用法）`)
    }
  }

  if (!options.meta) throw new Error('缺少 --meta（元数据表 JSON 路径）')
  if (options.tolerance !== undefined && options.tolerance < 0) {
    throw new Error('--tolerance 不能是负数')
  }
  return options
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === 'help') {
    console.log(USAGE)
    return
  }

  const { report, text } = runImport({
    metaFile: parsed.meta,
    pdfDir: parsed.pdf,
    outFile: parsed.out,
    dryRun: parsed.dryRun,
    ...(parsed.tolerance !== undefined ? { sizeTolerance: parsed.tolerance } : {})
  })

  console.log(parsed.json ? JSON.stringify(report, null, 2) : text)
  if (report.errors.length > 0) process.exitCode = 1
}

try {
  main()
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`导入失败：${detail}`)
  console.error('（--help 看用法）')
  process.exitCode = 1
}
