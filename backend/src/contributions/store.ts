/**
 * 投稿存储层 —— B09 公众上传（2026-10-13 新增）
 *
 * 落点：backend/data/contributions/
 *   - index.json  ：全部投稿的元数据（状态机 pending / approved / rejected）
 *   - files/      ：待审原件（通过后原件已进知识库，这里保留，供留痕与复查）
 *
 * 为什么用 JSON 而不是 Prisma：
 *   1) backend/prisma/schema.prisma 是 B02（月月）的文件，而分工硬约束写明
 *      「不重构别人的文件（要改先在群里说）」；
 *   2) 投稿数据是**运行时数据**，与 backend/data/track/events.jsonl 同类，
 *      本来就该在 gitignore 里，不属于要进仓库的 schema；
 *   3) 演示期投稿量在几十条量级，JSON 全量读写的代价可以忽略。
 *   字段名刻意与 `docs/B09-公众互动模块-任务书.md` 里的 Prisma 草案对齐，
 *   组长若要并入数据库，照字段搬即可，无需改接口。
 *
 * 并发：单进程 Node。读-改-写用一条 Promise 链串起来（withWriteLock），
 *   否则两个请求可能各读一份旧文件、各写一份，后写的把先写的吞掉。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 投稿的三个状态。**不要加第四个** —— 前端与管理端都按三态着色 */
export type ContributionStatus = 'pending' | 'approved' | 'rejected'

/** 一条投稿（对外的字段名以 routes 层裁剪后的为准，这里是全量存储形状） */
export interface ContributionRecord {
  /** 投稿编号，形如 c-<时间戳36进制>-<随机> */
  id: string
  /** 投稿人（登录用户）。投稿要求登录，所以这两个字段永远有值 */
  userId: string
  userName: string
  /** 投稿人所属机构（取自注册信息，管理员核对身份用） */
  userOrg: string
  /** 投稿人电话（取自注册信息，**仅管理端可见**，不随投稿人接口返回） */
  userPhone: string
  /** 资料标题（必填） */
  title: string
  /** 四维元数据（必填，下拉值来自 GET /api/docs/facets） */
  org: string
  year: string
  type: string
  tags: string
  /** 投稿说明（选填） */
  note: string
  /** 投稿时的原始文件名（带扩展名，展示用） */
  fileName: string
  /** 落盘文件名（= <id> + 原扩展名），避免中文名/重名问题 */
  storedName: string
  /** 字节数 */
  size: number
  status: ContributionStatus
  /** 退回理由（status=rejected 时必有） */
  reason: string
  /** 通过后知识库返回的条目编号（status=approved 时尽量有；引擎不回则为空串） */
  docId: string
  createdAt: string
  /** 审核时间（通过/退回时写） */
  reviewedAt: string
}

/** 单份投稿文件大小上限，与知识库解析能力对齐 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024

/** 数据目录：backend/data/contributions（源码 src/ 与产物 dist/ 下同一层，故用 ../..） */
const DATA_DIR = fileURLToPath(new URL('../../data/contributions', import.meta.url))
const FILES_DIR = path.join(DATA_DIR, 'files')
const INDEX_FILE = path.join(DATA_DIR, 'index.json')

/** 确保目录存在（首次运行时自动建，不用手工准备） */
function ensureDirs(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  if (!existsSync(FILES_DIR)) mkdirSync(FILES_DIR, { recursive: true })
}

/** 生成投稿编号（时间有序，便于人工按时间认） */
export function newContributionId(): string {
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `c-${stamp}-${rand}`
}

/** 从原始文件名取扩展名（白名单外的已在上游挡掉，这里只做归一） */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return ''
  return fileName.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '')
}

/**
 * 读全部投稿。
 *
 * T5（2026-10-21）改口径：
 *   原来「文件不存在」和「文件坏掉」都当空库处理，于是索引一旦损坏，
 *   接口会假装「一条投稿都没有」，管理员以为投稿被清空了，实际上是数据读不出来。
 *   现在区分开：
 *     - 文件不存在 → 真的是空库（第一次用），返回 []；
 *     - 文件在但内容坏掉 → 抛错（CONTRIBUTION_STORE_UNAVAILABLE），
 *       接口回 500 并写服务端日志，不伪装成空列表。
 */
function readIndex(): ContributionRecord[] {
  if (!existsSync(INDEX_FILE)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(INDEX_FILE, 'utf-8'))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[contributions] 投稿索引文件损坏（读不出来）：${detail}`)
    throw storeUnavailableError(`投稿索引文件损坏：${detail}`)
  }
  const items = (parsed as { items?: unknown })?.items
  if (!Array.isArray(items)) {
    console.error('[contributions] 投稿索引文件格式不对（items 不是数组）')
    throw storeUnavailableError('投稿索引文件格式不对（items 不是数组）')
  }
  return items.filter((x): x is ContributionRecord => typeof x === 'object' && x !== null)
}

/** 存储层不可用：带 code/status，交给统一错误信封回 500 */
function storeUnavailableError(detail: string): Error & { code: string; status: number } {
  const err = new Error(detail) as Error & { code: string; status: number }
  err.code = 'CONTRIBUTION_STORE_UNAVAILABLE'
  err.status = 500
  return err
}

/** 原子写：先写临时文件再 rename，避免写到一半断电留下半个 JSON */
function writeIndex(items: ContributionRecord[]): void {
  ensureDirs()
  const tmp = `${INDEX_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), 'utf-8')
  renameSync(tmp, INDEX_FILE)
}

/** 写入串行化：所有读-改-写都排在同一条 Promise 链上 */
let writeChain: Promise<unknown> = Promise.resolve()
function withWriteLock<T>(task: () => T): Promise<T> {
  const next = writeChain.then(task, task)
  // 吞掉链上的异常，避免一次失败把后续所有写操作卡死
  writeChain = next.catch(() => undefined)
  return next
}

/** 全部投稿（新→旧）。管理端自己再排序/分页 */
export async function listContributions(): Promise<ContributionRecord[]> {
  return withWriteLock(() => readIndex())
}

/** 按投稿人过滤（投稿人侧的「我的投稿」） */
export async function listByUser(userId: string): Promise<ContributionRecord[]> {
  const all = await listContributions()
  return all
    .filter((x) => x.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/** 取单条，没有返回 null */
export async function getContribution(id: string): Promise<ContributionRecord | null> {
  const all = await listContributions()
  return all.find((x) => x.id === id) ?? null
}

/** 新增一条（插到最前，新→旧） */
export async function addContribution(record: ContributionRecord): Promise<ContributionRecord> {
  return withWriteLock(() => {
    const all = readIndex()
    all.unshift(record)
    writeIndex(all)
    return record
  })
}

/** 局部更新（返回更新后的记录；id 不存在返回 null） */
export async function updateContribution(
  id: string,
  patch: Partial<ContributionRecord>
): Promise<ContributionRecord | null> {
  return withWriteLock(() => {
    const all = readIndex()
    const index = all.findIndex((x) => x.id === id)
    if (index < 0) return null
    const merged = { ...all[index], ...patch, id: all[index].id }
    all[index] = merged
    writeIndex(all)
    return merged
  })
}

/** 删一条（仅用于落盘失败时的回滚，正常流程不删） */
export async function removeContribution(id: string): Promise<void> {
  await withWriteLock(() => {
    const all = readIndex()
    writeIndex(all.filter((x) => x.id !== id))
  })
}

/** 待审原件的绝对路径 */
export function contributionFilePath(storedName: string): string {
  return path.join(FILES_DIR, storedName)
}

/** 待审原件是否还在盘上（管理员点「查看原件」时用来判 404） */
export function contributionFileExists(storedName: string): boolean {
  return Boolean(storedName) && existsSync(contributionFilePath(storedName))
}

/** 落盘一份待审原件。文件名用 <id><ext>，绕开中文名与重名 */
export function writeContributionFile(id: string, ext: string, data: Buffer): string {
  ensureDirs()
  const storedName = `${id}${ext}`
  writeFileSync(contributionFilePath(storedName), data)
  return storedName
}

/** 删除落盘文件（投稿写库失败时回滚用） */
export function deleteContributionFile(storedName: string): void {
  try {
    const abs = contributionFilePath(storedName)
    if (existsSync(abs)) unlinkSync(abs)
  } catch {
    // 回滚失败不抛：留给人工清理，别把错误盖到真正的失败原因上
  }
}

/** 数据目录绝对路径（改动说明/排障时打印出来用） */
export function contributionsDataDir(): string {
  return DATA_DIR
}
