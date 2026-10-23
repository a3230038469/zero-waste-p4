/**
 * WeKnora 引擎对接层 —— 负责人：韶茹
 *
 * 全组唯一跟引擎打交道的地方。封装好后，其他板块不用管细节。
 *
 * 两种数据来源（同一套接口，上层无感）：
 *   engine —— 配好 WEKNORA_API_KEY / WEKNORA_KB_ID 时，走真实引擎 HTTP 接口
 *   local  —— 密钥未到位时，读 backend/data 下的本地资料包（demo 通道）
 *
 * 认证：请求头 X-API-Key，地址读 .env 的 WEKNORA_BASE_URL
 * 要求：出错给清晰错误信息（带 code），绝不让它崩掉整个服务
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import {
  EngineError,
  type AskEvent,
  type DocStream,
  type EmbedToken,
  type EngineSource,
  type KbDocInternal
} from './types.js'
import { parseSseStream } from './sse.js'
import { baseNameOf, unzipFirstEntry } from './zip.js'
import { buildEngineOverrides, buildStyledQuery, loadQaSettings } from './qa-settings.js'
import { getAgentId } from './agent-config.js'
import {
  createAgentCounters,
  translateAgentStream,
  type AgentSourceDoc,
  type ResolveAgentDoc
} from './agent-sse.js'

export * from './types.js'
/** 流终止判断也要给路由层用（判 complete/stop/error，别用 done） */
export { isTerminalEvent } from './sse.js'

/** 引擎请求超时（毫秒） */
const ENGINE_TIMEOUT_MS = 15_000

/** 本地资料包根目录：backend/data（源码与 dist 两种布局都能落到同一处） */
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url))

/** 占位符识别：.env.example 抄来的值不算配置好 */
const PLACEHOLDER = /^(your_|please_|change_?me|xxx|todo)/i

function readEnv(name: string): string {
  const value = (process.env[name] ?? '').trim()
  if (!value || PLACEHOLDER.test(value)) return ''
  return value
}

/** 当前生效的数据来源 */
export function getDataSource(): EngineSource {
  // 显式开关优先：DOCS_SOURCE=local 时书架固定读本地索引（元数据齐），
  // snapshot 时读云端演示快照（无原件、无 AI），问答仍可走引擎。
  // 留空则按密钥是否齐全自动判断。
  const override = readEnv('DOCS_SOURCE').toLowerCase()
  if (override === 'local' || override === 'engine' || override === 'snapshot') return override
  return readEnv('WEKNORA_API_KEY') && readEnv('WEKNORA_KB_ID') ? 'engine' : 'local'
}

function dataDir(): string {
  const override = readEnv('KB_DATA_DIR')
  return override ? resolve(override) : DEFAULT_DATA_DIR
}

/* ------------------------------------------------------------------ *
 * 本地资料包通道
 * ------------------------------------------------------------------ */

interface KbIndexFile {
  generatedFrom?: string
  count?: number
  items?: unknown
}

let localCache: KbDocInternal[] | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 校验一条本地记录，字段缺失就明确报出来，别让脏数据静默流到前端 */
function toLocalDoc(raw: unknown, line: number): KbDocInternal {
  if (!isRecord(raw)) {
    throw new EngineError('LOCAL_DATA_BROKEN', `本地索引第 ${line} 条不是对象`, 500)
  }
  const { id, title, org, year, type, tags, size, sourceUrl, fileName, filePath, sizeDeclared } = raw
  if (
    typeof id !== 'string' ||
    typeof title !== 'string' ||
    typeof org !== 'string' ||
    typeof year !== 'number' ||
    typeof type !== 'string' ||
    !Array.isArray(tags) ||
    typeof size !== 'number' ||
    typeof fileName !== 'string' ||
    typeof filePath !== 'string'
  ) {
    throw new EngineError(
      'LOCAL_DATA_BROKEN',
      `本地索引第 ${line} 条字段不合法（需要 id/title/org/year/type/tags/size/fileName/filePath）`,
      500
    )
  }
  return {
    id,
    title,
    org,
    year,
    type,
    tags: tags.filter((t): t is string => typeof t === 'string'),
    size,
    sourceUrl: typeof sourceUrl === 'string' ? sourceUrl : '',
    fileName,
    filePath,
    sizeDeclared: typeof sizeDeclared === 'number' ? sizeDeclared : null,
    // T8：所属方向。本地索引目前没有这一项（为空串表示「没有方向数据」），
    // 将来导入时带上 `srcTable` 字段，这一套筛选器立刻就能用，不用再改代码。
    srcTable: typeof raw.srcTable === 'string' ? raw.srcTable.trim() : ''
  }
}

/** 读本地资料索引（带缓存）。文件缺失/损坏都给清楚提示。 */
export function loadLocalDocs(): KbDocInternal[] {
  if (localCache) return localCache

  const indexFile = join(dataDir(), 'kb-index.json')
  if (!existsSync(indexFile)) {
    throw new EngineError(
      'LOCAL_DATA_MISSING',
      `本地资料索引不存在：${indexFile}。请先导入知识库内容，或在 backend/.env 配好 WEKNORA_API_KEY 走真实引擎。`,
      503
    )
  }

  let parsed: KbIndexFile
  try {
    parsed = JSON.parse(readFileSync(indexFile, 'utf8')) as KbIndexFile
  } catch {
    throw new EngineError('LOCAL_DATA_BROKEN', `本地资料索引不是合法 JSON：${indexFile}`, 500)
  }

  const items = parsed.items
  if (!Array.isArray(items)) {
    throw new EngineError('LOCAL_DATA_BROKEN', `本地资料索引缺 items 数组：${indexFile}`, 500)
  }

  localCache = items.map((raw, i) => toLocalDoc(raw, i + 1))
  console.log(
    `[weknora] 本地数据源已启用：${localCache.length} 份资料（${indexFile}）\n` +
      '[weknora] 原因：DOCS_SOURCE=local 强制走本地，或 WEKNORA_API_KEY / WEKNORA_KB_ID 未配。' +
      '要让书架也读引擎：.env 里把 DOCS_SOURCE 改成 engine（或删掉这行）并配好密钥。'
  )
  return localCache
}

/** 把 filePath 解析成绝对路径，并挡住越出 data 目录的路径 */
function localAbsPath(doc: KbDocInternal): string {
  const root = dataDir()
  const abs = resolve(root, doc.filePath)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || rel.startsWith(sep)) {
    throw new EngineError('LOCAL_PATH_ESCAPE', `资料路径越界：${doc.filePath}`, 500)
  }
  if (!existsSync(abs)) {
    throw new EngineError(
      'LOCAL_FILE_MISSING',
      `资料文件不存在：${doc.filePath}（索引与 PDF 是否一起拷过来？）`,
      404
    )
  }
  return abs
}

/* ------------------------------------------------------------------ *
 * 云端演示快照通道（DOCS_SOURCE=snapshot）
 * ------------------------------------------------------------------ */

let snapshotCache: KbDocInternal[] | null = null

/** 读云端演示用的元数据快照（kb-snapshot.json，由引擎导出，无原件） */
export function loadSnapshotDocs(): KbDocInternal[] {
  if (snapshotCache) return snapshotCache

  const snapshotFile = join(dataDir(), 'kb-snapshot.json')
  if (!existsSync(snapshotFile)) {
    throw new EngineError('SNAPSHOT_MISSING', `演示快照不存在：${snapshotFile}`, 503)
  }

  let parsed: KbIndexFile
  try {
    parsed = JSON.parse(readFileSync(snapshotFile, 'utf8')) as KbIndexFile
  } catch {
    throw new EngineError('SNAPSHOT_BROKEN', `演示快照不是合法 JSON：${snapshotFile}`, 500)
  }

  if (!Array.isArray(parsed.items)) {
    throw new EngineError('SNAPSHOT_BROKEN', `演示快照缺 items 数组：${snapshotFile}`, 500)
  }

  snapshotCache = parsed.items.map((raw, i) => {
    const doc = toLocalDoc(raw, i + 1)
    // toLocalDoc 不认 createdAt（那是引擎来源的字段），快照里有，这里补上
    const created = isRecord(raw) && typeof raw.createdAt === 'number' ? raw.createdAt : undefined
    return created ? { ...doc, createdAt: created } : doc
  })
  console.log(`[weknora] 演示快照数据源已启用：${snapshotCache.length} 份资料（${snapshotFile}）`)
  return snapshotCache
}

/* ------------------------------------------------------------------ *
 * 真实引擎通道
 * ------------------------------------------------------------------ */

function engineBaseUrl(): string {
  return readEnv('WEKNORA_BASE_URL') || 'http://localhost:8080'
}

function engineKbId(): string {
  const kbId = readEnv('WEKNORA_KB_ID')
  if (!kbId) {
    throw new EngineError('ENGINE_NOT_CONFIGURED', '未配置 WEKNORA_KB_ID，无法访问知识库', 503)
  }
  return kbId
}

/** 统一的引擎请求：带超时、带 X-API-Key，错误转成 EngineError */
async function engineFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const apiKey = readEnv('WEKNORA_API_KEY')
  if (!apiKey) {
    throw new EngineError('ENGINE_NOT_CONFIGURED', '未配置 WEKNORA_API_KEY，无法访问引擎', 503)
  }

  const url = `${engineBaseUrl().replace(/\/+$/, '')}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'X-API-Key': apiKey, Accept: 'application/json', ...(init.headers ?? {}) }
    })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    // ⚠️ 契约 C6：对外的消息不许带内部地址（引擎 URL、路径、堆栈）。
    //    内部细节只留在服务端日志里，这里只给一句中文。
    throw new EngineError(
      aborted ? 'ENGINE_TIMEOUT' : 'ENGINE_UNREACHABLE',
      aborted
        ? `引擎响应超时（${ENGINE_TIMEOUT_MS / 1000}s），请稍后重试`
        : '连不上资料库引擎，请确认引擎已启动',
      504
    )
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401 || res.status === 403) {
    throw new EngineError('ENGINE_UNAUTHORIZED', '引擎拒绝：API Key 无效或无权限', 502)
  }
  if (res.status === 404) {
    // 引擎明确说「没有这条」→ 归到 404 类错误，调用方（getDoc）再翻成 DOC_NOT_FOUND
    throw new EngineError('ENGINE_NOT_FOUND', '引擎里没有这条记录', 404)
  }
  if (!res.ok) {
    throw new EngineError('ENGINE_BAD_STATUS', `引擎返回异常状态（${res.status}）`, 502)
  }
  return res
}

/**
 * 引擎请求（管理台用）：与 engineFetch 的区别是**不把非 2xx 直接抛掉**，
 * 而是把状态码、解析后的 JSON 和原始文本一起回给调用方 ——
 * 「模型管理」要把「为什么建不了」如实告诉老师（比如引擎的校验报错）。
 *
 * 密钥仍然只在服务端使用：X-API-Key 由这里统一加，调用方拿不到。
 */
export async function engineRequest(
  path: string,
  init: RequestInit = {},
  timeoutMs = ENGINE_TIMEOUT_MS
): Promise<{ status: number; payload: unknown; text: string }> {
  const apiKey = readEnv('WEKNORA_API_KEY')
  if (!apiKey) {
    throw new EngineError('ENGINE_NOT_CONFIGURED', '未配置 WEKNORA_API_KEY，无法访问引擎', 503)
  }
  const url = `${engineBaseUrl().replace(/\/+$/, '')}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'X-API-Key': apiKey, Accept: 'application/json', ...(init.headers ?? {}) }
    })
    const text = await res.text()
    let payload: unknown = null
    try {
      payload = text ? (JSON.parse(text) as unknown) : null
    } catch {
      // 非 JSON（代理页 / 纯文本报错）→ payload 留 null，调用方看 text
    }
    return { status: res.status, payload, text }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new EngineError(
      aborted ? 'ENGINE_TIMEOUT' : 'ENGINE_UNREACHABLE',
      aborted ? '引擎响应超时，请稍后重试' : '连不上资料库引擎，请确认引擎已启动',
      504
    )
  } finally {
    clearTimeout(timer)
  }
}

function pickString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
      return Number(value)
    }
  }
  return 0
}

function pickTags(source: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = source[key]
    if (Array.isArray(value)) return value.filter((t): t is string => typeof t === 'string')
    if (typeof value === 'string' && value.trim()) {
      return value
        .split(/[,，;；|]/)
        .map((t) => t.trim())
        .filter(Boolean)
    }
  }
  return []
}

/**
 * 从引擎的 custom_metadata 里取一项，转成字符串。
 *
 * 业务元数据（发布机构 / 年份 / 类型 / 领域）存这里，由「元数据补录」写入：
 *   {"org":"…","year":"2024","type":"研究报告","tags":"EPR"}
 * 引擎限制：值只能是字符串/数字/布尔 —— 所以这里的 key 全用单数短名。
 */
function metaString(source: Record<string, unknown>, key: string): string {
  const meta = source['custom_metadata']
  if (!isRecord(meta)) return ''
  const value = meta[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 引擎的时间字符串转毫秒。引擎带 6 位小数秒，JS 只认 3 位，先截断再解析。 */
function parseEngineTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const normalized = value.replace(/(\.\d{3})\d+/, '$1')
  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

/**
 * 把引擎返回的一条记录归一化成契约字段。
 *
 * 字段来源（2026-10-08 真机核对通过）：
 *   id / title / file_name / file_size / created_at —— 引擎原生字段
 *   org / year / type / tags / srcTable —— 引擎的 custom_metadata（元数据补录写入）
 *
 * ⚠️ 引擎另有一个 `metadata` 字段，存的是「处理配置」而不是业务元数据，别拿它当来源。
 */
function toEngineDoc(raw: unknown): KbDocInternal {
  if (!isRecord(raw)) {
    throw new EngineError('ENGINE_BAD_PAYLOAD', '引擎返回的记录格式不符合预期', 502)
  }
  const id = pickString(raw, ['id', 'knowledge_id', 'file_id'])
  const fileName = pickString(raw, ['file_name', 'filename', 'name', 'title'])
  const size = pickNumber(raw, ['file_size', 'size'])
  const yearValue = Number(metaString(raw, 'year'))
  return {
    id,
    title: pickString(raw, ['title', 'name', 'file_name']) || fileName,
    org: metaString(raw, 'org') || '未标注',
    year: Number.isFinite(yearValue) && yearValue > 0 ? yearValue : 0,
    type: metaString(raw, 'type') || '未分类',
    tags: pickTags({ tags: metaString(raw, 'tags') }, ['tags']),
    size,
    sourceUrl: pickString(raw, ['source_url', 'source']),
    fileName,
    filePath: pickString(raw, ['file_path']),
    sizeDeclared: size,
    // T8：所属方向（老库 603 份 100% 有这个字段：知识查询（零废弃）/ 知识查询（化学品））
    srcTable: metaString(raw, 'srcTable'),
    createdAt: parseEngineTime(raw['created_at'])
  }
}

function extractArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (isRecord(payload)) {
    for (const key of ['items', 'data', 'list', 'files']) {
      const value = payload[key]
      if (Array.isArray(value)) return value
    }
  }
  return []
}

async function engineJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await engineFetch(path, init)
  try {
    return (await res.json()) as unknown
  } catch {
    throw new EngineError('ENGINE_BAD_PAYLOAD', '引擎返回的不是合法 JSON', 502)
  }
}

/* ------------------------------------------------------------------ *
 * B01 对外能力
 * ------------------------------------------------------------------ */

/** 引擎列表结果缓存时长：书架每次请求都拉 600+ 条太费，60 秒内复用同一份 */
const ENGINE_LIST_TTL_MS = 60_000

let engineListCache: { at: number; docs: KbDocInternal[] } | null = null

/** 拉全量资料：引擎按页返回，这里翻页取完（上限 20 页 × 200 = 4000 条） */
async function fetchEngineDocs(): Promise<KbDocInternal[]> {
  const kbId = encodeURIComponent(engineKbId())
  const PAGE_SIZE = 200
  const all: KbDocInternal[] = []
  for (let page = 1; page <= 20; page += 1) {
    const payload = await engineJson(
      `/api/v1/knowledge-bases/${kbId}/knowledge?page=${page}&page_size=${PAGE_SIZE}`
    )
    const rows = extractArray(payload)
    if (rows.length === 0) break
    for (const row of rows) {
      all.push(toEngineDoc(row))
    }
    const total = isRecord(payload) ? pickNumber(payload, ['total']) : 0
    if (total > 0 && all.length >= total) break
  }
  return all
}

/**
 * 取知识库文件列表。
 *
 * ⚠️ 引擎的列表接口是 `/knowledge-bases/{id}/knowledge`。
 * 不要用 `/knowledge-bases/{id}/files` —— 那是文件代理路由，需要 `file_path`
 * 参数，用在这会 400（2026-10-08 实测）。
 *
 * 契约 C7（2026-10-21 用户拍板）：**上传即公开**，不再按 publish 标记隐藏任何资料；
 * 需要下架就直接删除文件。引擎返回什么就返回什么。
 */
export async function listFiles(): Promise<KbDocInternal[]> {
  const source = getDataSource()
  if (source === 'snapshot') return loadSnapshotDocs()
  if (source === 'local') return loadLocalDocs()

  if (engineListCache && Date.now() - engineListCache.at < ENGINE_LIST_TTL_MS) {
    return engineListCache.docs
  }
  const docs = await fetchEngineDocs()
  engineListCache = { at: Date.now(), docs }
  console.log(`[weknora] 引擎数据源已启用：${docs.length} 份资料`)
  return docs
}

/** 上传/删除资料后让列表缓存立刻失效，否则书架要等最多 60 秒才看得见变化 */
export function invalidateEngineListCache(): void {
  engineListCache = null
}

/**
 * 关键词检索（引擎的混合检索入口）。
 *
 * 说明：书架列表接口的 `q` 按契约走「匹配标题/文件名」，由路由层在
 * listFiles() 的结果上做，不走这里。本方法是 B01 要求的检索能力，
 * 供后续语义检索场景使用。
 */
export async function hybridSearch(query: string): Promise<KbDocInternal[]> {
  const keyword = query.trim()
  if (!keyword) return []

  if (getDataSource() === 'local') {
    const lower = keyword.toLowerCase()
    return loadLocalDocs().filter(
      (doc) =>
        doc.title.toLowerCase().includes(lower) ||
        doc.fileName.toLowerCase().includes(lower) ||
        doc.tags.some((tag) => tag.toLowerCase().includes(lower))
    )
  }

  const payload = await engineJson(
    `/api/v1/knowledge-bases/${engineKbId()}/hybrid-search?resource_urls=public`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 引擎的混合检索只认 query_text；写 query 会稳定返回 400 {"error":{"code":1000,"message":"query_text is required"}}
      body: JSON.stringify({ query_text: keyword })
    }
  )
  return extractArray(payload).map(toEngineDoc)
}

/** 按 id 取单份资料详情 */
export async function getDoc(id: string): Promise<KbDocInternal> {
  const source = getDataSource()
  if (source === 'snapshot' || source === 'local') {
    const pool = source === 'snapshot' ? loadSnapshotDocs() : loadLocalDocs()
    const doc = pool.find((d) => d.id === id)
    if (!doc) throw new EngineError('DOC_NOT_FOUND', `没有这份资料：${id}`, 404)
    return doc
  }
  // 引擎单条接口外面包了一层：{"success":true,"data":{…}}，必须解开再归一化，
  // 否则拿到的是外壳对象（id/title 全空）。2026-10-08 实测踩中。
  let payload: unknown
  try {
    payload = await engineJson(`/api/v1/knowledge/${encodeURIComponent(id)}`)
  } catch (err) {
    // 引擎回 404 = 这份资料不存在，对外必须是 404 + DOC_NOT_FOUND，不能变成 502
    if (err instanceof EngineError && err.code === 'ENGINE_NOT_FOUND') {
      throw new EngineError('DOC_NOT_FOUND', `没有这份资料：${id}`, 404)
    }
    throw err
  }
  const raw = isRecord(payload) && isRecord(payload['data']) ? payload['data'] : payload
  return toEngineDoc(raw)
}

/**
 * 解析进度（2026-10-21 新增）
 *
 * 为什么需要：投稿审核通过后会立刻变成「已通过」，但引擎那边其实还在解析
 * （实测：小 txt 约 9 秒，0.6MB PDF 约 1 分钟才 completed）。审核通过 ≠ 已入库，
 * 中间这段要能对用户说清楚「正在解析中」。
 *
 * 返回值刻意做成有限枚举：前端只按这六个值出标签，不在各处抄引擎原始状态串。
 */
/**
 * 解析状态统一口径（契约 C5，2026-10-21）
 *
 * 只认 6 个值：completed / failed / processing / pending / deleted / unknown。
 * 引擎那边的原始状态词（success、error、parsing、finalizing、deleting…）都在这里翻译，
 * 后面对外只出现这 6 个值，前端拿同一张表做映射。
 */
export type ParseState = 'completed' | 'failed' | 'processing' | 'pending' | 'deleted' | 'unknown'

/** 引擎状态 → 本站枚举（认不出来的算 unknown，不猜「已完成」） */
const PARSE_STATE_MAP: Record<string, ParseState> = {
  pending: 'pending',
  processing: 'processing',
  parsing: 'processing',
  finalizing: 'processing',
  completed: 'completed',
  success: 'completed',
  failed: 'failed',
  error: 'failed',
  deleting: 'deleted',
  deleted: 'deleted'
}

/**
 * 把引擎给的原始状态词翻译成 6 值口径（契约 C5）。
 * 认不出来的词一律记 unknown —— 宁可说「不知道」，不编一个看着像成功的状态。
 */
export function normalizeParseState(raw: string): ParseState {
  const key = raw.trim().toLowerCase()
  if (!key) return 'unknown'
  return PARSE_STATE_MAP[key] ?? 'unknown'
}

/**
 * 查一份资料的解析进度。
 *
 * 只有 engine 数据源才有真实进度；local / snapshot 是静态资料包，返回 unknown
 * （前端遇到 unknown 就只显示「已通过」，不编造进度）。查询失败也返回 unknown ——
 * 进度是附加信息，不能因为它让整张投稿列表报错。
 */
export async function getDocParseState(id: string): Promise<ParseState> {
  const docId = id.trim()
  if (!docId) return 'unknown'
  if (getDataSource() !== 'engine') return 'unknown'
  try {
    const payload = await engineJson(`/api/v1/knowledge/${encodeURIComponent(docId)}`)
    const raw = isRecord(payload) && isRecord(payload['data']) ? payload['data'] : payload
    const status = isRecord(raw) ? pickString(raw, ['parse_status', 'parseStatus']) : ''
    return normalizeParseState(status)
  } catch {
    return 'unknown'
  }
}

/**
 * 取资料文件流（预览 / 下载共用）。
 *
 * mode=inline 给在线预览，mode=attachment 给下载；本地与引擎两种来源统一成 DocStream。
 */
export async function getFileStream(id: string, _mode: 'inline' | 'attachment'): Promise<DocStream> {
  const doc = await getDoc(id)

  // 云端演示版：快照里只有目录信息，没有原件 —— 明确告知，不假装下载成功
  if (getDataSource() === 'snapshot') {
    throw new EngineError(
      'SNAPSHOT_NO_FILE',
      '云端演示版只提供资料目录，原件下载与在线预览请在正式版使用',
      404
    )
  }

  if (getDataSource() === 'local') {
    return {
      fileName: doc.fileName,
      size: doc.size,
      contentType: guessContentType(doc.fileName),
      stream: createReadStream(localAbsPath(doc))
    }
  }

  // 引擎没有「取单份原件」的接口（`/knowledge/{id}/preview|download` 不存在，
  // 2026-10-08 实测 404）。它只有批量下载，返回一个 zip：
  //   POST /api/v1/knowledge-bases/{id}/knowledge/batch-download  {ids:[…]}  → application/zip
  // 所以这里下这一份、把 zip 拆开、按普通文件流出去，上层（预览/下载）无感。
  const kbId = encodeURIComponent(engineKbId())
  const res = await engineFetch(`/api/v1/knowledge-bases/${kbId}/knowledge/batch-download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [id] })
  })
  const zipBuf = Buffer.from(await res.arrayBuffer())

  let entry: { name: string; data: Buffer }
  try {
    entry = unzipFirstEntry(zipBuf)
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误'
    throw new EngineError('ENGINE_BAD_PAYLOAD', `引擎下载包解不开：${message}`, 502)
  }

  const fileName = doc.fileName || baseNameOf(entry.name)
  return {
    fileName,
    size: entry.data.length,
    contentType: guessContentType(fileName),
    stream: Readable.from(entry.data)
  }
}

/** 兼容函数：按契约保留 getPreview / getDownload 两个语义入口 */
export function getPreview(id: string): Promise<DocStream> {
  return getFileStream(id, 'inline')
}

export function getDownload(id: string): Promise<DocStream> {
  return getFileStream(id, 'attachment')
}

/**
 * 换取问答临时钥匙（B08 用）。
 * 长期凭证 WEKNORA_PUBLISH_TOKEN 只留在服务端，**绝不返回给前端**。
 */
export async function exchangeEmbedToken(): Promise<EmbedToken> {
  const publishToken = readEnv('WEKNORA_PUBLISH_TOKEN')
  if (!publishToken) {
    throw new EngineError(
      'ENGINE_NOT_CONFIGURED',
      '问答引擎尚未配置（缺 WEKNORA_PUBLISH_TOKEN），AI 暂时不可用',
      503
    )
  }
  const channelId = readEnv('WEKNORA_CHANNEL_ID')
  if (!channelId) {
    throw new EngineError(
      'ENGINE_NOT_CONFIGURED',
      '问答引擎尚未配置（缺 WEKNORA_CHANNEL_ID），AI 暂时不可用',
      503
    )
  }

  const res = await engineFetch(`/api/v1/embed/${encodeURIComponent(channelId)}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Publish-Token': publishToken },
    body: JSON.stringify({ publish_token: publishToken })
  })
  const payload = (await res.json().catch(() => null)) as unknown

  if (!isRecord(payload)) {
    throw new EngineError('ENGINE_BAD_PAYLOAD', '引擎返回的钥匙格式不符合预期', 502)
  }
  const token = pickString(payload, ['token', 'access_token', 'embed_token'])
  if (!token) {
    throw new EngineError('ENGINE_BAD_PAYLOAD', '引擎未返回可用钥匙', 502)
  }
  const expiresIn = pickNumber(payload, ['expires_in', 'expiresIn']) || 1800
  return { token, expiresIn, channelId }
}

/* ------------------------------------------------------------------ *
 * 问答可选模型（T3 用）
 * ------------------------------------------------------------------ */

/** 引擎侧的一个问答模型选项（只回前端要用的字段，别把引擎内部结构整个倒出去） */
export interface QaModelOption {
  id: string
  name: string
  /** 引擎模型类型，能回答知识库问题的是 KnowledgeQA */
  type: string
  /** active / downloading / download_failed */
  status: string
}

/** 引擎里的任意类型模型（原样带上 type，由调用方按类型分组） */
export interface EngineModelOption {
  id: string
  name: string
  /** KnowledgeQA / VLLM / Embedding / Rerank —— 引擎的类型枚举 */
  type: string
  /** active / downloading / download_failed */
  status: string
}

/**
 * 列引擎里的**全部模型**（2026-10-21 新增：系统设置页「模型选择」要把各类模型都摆出来）。
 *
 * ⚠️ 引擎的 `GET /api/v1/models` **不支持 `?type=` 过滤参数** ——
 * 它后端一个 query 都不读（WeKnora 前端那个 `listModels(type)` 是在浏览器里
 * 过滤的，纯客户端行为）。所以这里一次拉全，调用方自己按 type 分组。
 *
 * ⚠️ name 优先取 `name` 而不是 `display_name`：前者是模型真实身份
 * （如 LongCat-2.5-Preview），后者可能只是运营随手起的标签（如「测试」），
 * 老师选模型时看真实名字更有用。
 */
export async function listEngineModels(): Promise<EngineModelOption[]> {
  const payload = await engineJson('/api/v1/models')
  const rows = extractArray(payload)
  const models: EngineModelOption[] = []
  for (const raw of rows) {
    if (!isRecord(raw)) continue
    const id = pickString(raw, ['id'])
    if (!id) continue
    models.push({
      id,
      name: pickString(raw, ['name', 'display_name']) || id,
      type: pickString(raw, ['type']),
      status: pickString(raw, ['status'])
    })
  }
  return models
}

/**
 * 列引擎当前可用的**知识问答模型**（老师后台「问答设置」用）。
 * 实现改为从 listEngineModels() 里筛 type，返回值形状与以前完全一致。
 */
export async function listQaModels(): Promise<QaModelOption[]> {
  const all = await listEngineModels()
  return all
    .filter((m) => m.type === 'KnowledgeQA')
    .map((m) => ({ id: m.id, name: m.name, type: 'KnowledgeQA', status: m.status }))
}

/**
 * 知识库上绑定的模型。
 *
 * 🔴 向量模型（embedding_model_id）**只读**：库里有 603 份资料的向量后换掉它，
 *    检索会悄悄变差（新问题用新模型算向量，跟老向量不在一个空间），只能重建库时改。
 *
 * ✅ 摘要模型（summary_model_id）**可改**（2026-10-22 实测打通），但走的是另一条路：
 *    PUT /api/v1/initialization/config/{kbId}（**camelCase** body，llmModelId 必填）。
 *    ⚠️ 这条路是整体替换：body 缺哪块，引擎就把哪块清零（vlm_config、chunking_config
 *    的 parent/child、overlap 都会被清掉）。所以必须先 GET 当前全量、重建完整 payload、
 *    只换 llmModelId 再发（见下面 buildKbConfigPayload / updateKnowledgeBaseSummaryModel）。
 *    🔴 不要用 PUT /api/v1/knowledge-bases/{id} 改这些：它只认 name / description，
 *    带 config 反而会把 chunking_config 清成 0（2026-10-22 临时库实测）。
 */
export interface EngineKbBindings {
  id: string
  name: string
  /** 向量模型 id（决定能检索到什么，已有向量后不能换） */
  embeddingModelId: string
  /** 摘要模型 id（资料卡片摘要 / profile 用） */
  summaryModelId: string
  /** 图片理解模型 id（vlm_config.model_id） */
  vlmModelId: string
  vlmEnabled: boolean
  /** 解析引擎规则：文件类型 → 解析器 */
  parserRules: Array<{ fileTypes: string; engine: string }>
}

/** 读知识库**原始记录**（GET /api/v1/knowledge-bases/{id} 的 data 层，一个字不裁剪） */
export async function fetchKnowledgeBaseRaw(): Promise<Record<string, unknown>> {
  const id = engineKbId()
  const payload = await engineJson(`/api/v1/knowledge-bases/${encodeURIComponent(id)}`)
  // 引擎单条接口外层包了一层 {success, data:{…}}（与 /knowledge/{id} 同一套路）
  const data = isRecord(payload) && isRecord(payload['data']) ? payload['data'] : payload
  if (!isRecord(data)) {
    throw new EngineError('ENGINE_BAD_PAYLOAD', '引擎返回的知识库格式不符合预期', 502)
  }
  return data
}

/** 读知识库当前绑定的模型（见上面 EngineKbBindings 的说明） */
export async function fetchKnowledgeBaseBindings(): Promise<EngineKbBindings> {
  const id = engineKbId()
  const data = await fetchKnowledgeBaseRaw()
  const vlm = isRecord(data['vlm_config']) ? data['vlm_config'] : {}
  const chunking = isRecord(data['chunking_config']) ? data['chunking_config'] : {}
  // 引擎实际形状是**数组**：[{ engine:'mineru_cloud', file_types:['pdf'] }, …]（2026-10-21 实测）。
  // 老版本/别的部署可能是 { pdf: 'mineru_cloud' } 这种映射，两种都认，别只写死一种。
  const parserRules: Array<{ fileTypes: string; engine: string }> = []
  const rawRules = chunking['parser_engine_rules']
  if (Array.isArray(rawRules)) {
    for (const item of rawRules) {
      if (!isRecord(item)) continue
      const engine = pickString(item, ['engine'])
      const types = Array.isArray(item['file_types'])
        ? item['file_types'].filter((t): t is string => typeof t === 'string')
        : []
      if (!engine) continue
      parserRules.push({ fileTypes: types.join('/') || '—', engine })
    }
  } else if (isRecord(rawRules)) {
    for (const [fileTypes, engine] of Object.entries(rawRules)) {
      if (typeof engine === 'string' && engine.trim()) parserRules.push({ fileTypes, engine })
    }
  }
  return {
    id: pickString(data, ['id']) || id,
    name: pickString(data, ['name']),
    embeddingModelId: pickString(data, ['embedding_model_id']),
    summaryModelId: pickString(data, ['summary_model_id']),
    vlmModelId: pickString(vlm, ['model_id']) || pickString(vlm, ['modelId']),
    vlmEnabled: vlm['enabled'] === true,
    parserRules
  }
}

/**
 * 把「知识库当前全量配置」重建成引擎要的模型配置 payload（**camelCase**）。
 *
 * 字段形状是 2026-10-22 从引擎自己前端的 KnowledgeBaseEditorModal 里逆向出来的
 * （它保存知识库时会发这一整份），逐个字段都在生产库上做过「原样写回 → 回读比对」。
 *
 * 🔴 为什么必须发全量：PUT /api/v1/initialization/config/{kbId} 是**整体替换**。
 *    只发 {llmModelId, embeddingModelId} 虽然也 200，但 vlm_config 会被关掉、
 *    chunking 的 chunk_overlap 归零、parent/child 开关丢失（临时库实测）。
 */
function buildKbConfigPayload(raw: Record<string, unknown>, summaryModelId: string): Record<string, unknown> {
  const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})
  const vlm = record(raw['vlm_config'])
  const asr = record(raw['asr_config'])
  const chunking = record(raw['chunking_config'])
  const storage = record(raw['storage_config'])
  const extract = record(raw['extract_config'])
  const questionGen = record(raw['question_generation_config'])
  const parserRules = Array.isArray(chunking['parser_engine_rules']) ? chunking['parser_engine_rules'] : []
  return {
    llmModelId: summaryModelId,
    embeddingModelId: pickString(raw, ['embedding_model_id']),
    vlm_config: vlm,
    asr_config: asr,
    documentSplitting: {
      chunkSize: pickNumber(chunking, ['chunk_size']),
      chunkOverlap: pickNumber(chunking, ['chunk_overlap']),
      separators: Array.isArray(chunking['separators']) ? chunking['separators'] : [],
      // 引擎只在有这个字段时才收；空数组会被当成「没配」→ 干脆不发，保持引擎原样
      ...(parserRules.length > 0 ? { parserEngineRules: parserRules } : {}),
      enableParentChild: chunking['enable_parent_child'] === true,
      parentChunkSize: pickNumber(chunking, ['parent_chunk_size']) || 4096,
      childChunkSize: pickNumber(chunking, ['child_chunk_size']) || 384,
      strategy: pickString(chunking, ['strategy']),
      tokenLimit: pickNumber(chunking, ['token_limit']),
      languages: Array.isArray(chunking['languages']) ? chunking['languages'] : [],
      tableMetadataInstructions: pickString(chunking, ['table_metadata_instructions'])
    },
    multimodal: { enabled: vlm['enabled'] === true },
    storageBackendId: pickString(raw, ['storage_backend_id']),
    storageProvider: pickString(storage, ['provider']) || 'local',
    nodeExtract: {
      enabled: extract['enabled'] === true,
      text: pickString(extract, ['text']),
      tags: Array.isArray(extract['tags']) ? extract['tags'] : [],
      nodes: Array.isArray(extract['nodes']) ? extract['nodes'] : [],
      relations: Array.isArray(extract['relations']) ? extract['relations'] : [],
      customInstructions: pickString(extract, ['custom_instructions'])
    },
    questionGeneration: {
      enabled: questionGen['enabled'] === true,
      questionCount: pickNumber(questionGen, ['question_count']) || 3,
      customInstructions: pickString(questionGen, ['custom_instructions'])
    }
  }
}

/** 键序无关的 JSON 串：用来比「写入前后是不是真的一字未变」（直接 JSON.stringify 会被键序骗） */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export interface KbSummaryModelUpdateResult {
  /** false = 本来就是它，一个字都没写 */
  changed: boolean
  message: string
  before: string
  after: string
  /** 回读校验：除摘要模型外，这几块必须一字未变 */
  preserved: Array<{ key: string; ok: boolean }>
}

/** 写入失败/校验失败时，拿写入前那份配置再发一次（尽力回滚，失败只记日志不抛） */
async function rollbackKbConfig(beforeRaw: Record<string, unknown>): Promise<void> {
  try {
    const id = engineKbId()
    await engineJson(`/api/v1/initialization/config/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildKbConfigPayload(beforeRaw, pickString(beforeRaw, ['summary_model_id'])))
    })
  } catch (err) {
    console.error('[weknora] 摘要模型写入失败后，回滚也失败了：', err)
  }
}

/**
 * 改知识库的**摘要模型**（2026-10-22 新增，系统设置页「摘要模型」下拉用）。
 *
 * 步骤：
 *   1. GET 知识库全量配置
 *   2. 重建完整 payload，只把 llmModelId 换成目标模型
 *   3. PUT /api/v1/initialization/config/{kbId}
 *   4. 回读：摘要模型确实变了 + embedding / chunking / vlm / indexing **一字未变**
 *   5. 任一条不满足 → 用写入前那份配置回滚，然后抛错（绝不假装成功）
 *
 * 为什么值得这么谨慎：这套配置里有 603 份资料的向量模型与分块规则，
 * 写坏一项检索就会悄悄变差 —— 宁可保存失败，也不能悄悄改坏。
 */
export async function updateKnowledgeBaseSummaryModel(modelId: string): Promise<KbSummaryModelUpdateResult> {
  const target = modelId.trim()
  if (!target) {
    throw new EngineError('INVALID_SUMMARY_MODEL', '摘要模型 id 不能是空串', 400)
  }
  const id = engineKbId()
  const beforeRaw = await fetchKnowledgeBaseRaw()
  const before = pickString(beforeRaw, ['summary_model_id'])
  if (before === target) {
    return {
      changed: false,
      message: '摘要模型没变，什么都没写（引擎那边的配置保持原样）',
      before,
      after: before,
      preserved: []
    }
  }

  await engineJson(`/api/v1/initialization/config/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildKbConfigPayload(beforeRaw, target))
  })

  const afterRaw = await fetchKnowledgeBaseRaw()
  const after = pickString(afterRaw, ['summary_model_id'])
  const preserved = [
    { key: 'embedding_model_id', ok: stableJson(beforeRaw['embedding_model_id']) === stableJson(afterRaw['embedding_model_id']) },
    { key: 'chunking_config', ok: stableJson(beforeRaw['chunking_config']) === stableJson(afterRaw['chunking_config']) },
    { key: 'vlm_config', ok: stableJson(beforeRaw['vlm_config']) === stableJson(afterRaw['vlm_config']) },
    { key: 'indexing_strategy', ok: stableJson(beforeRaw['indexing_strategy']) === stableJson(afterRaw['indexing_strategy']) }
  ]

  if (after !== target) {
    await rollbackKbConfig(beforeRaw)
    throw new EngineError(
      'KB_SUMMARY_MODEL_NOT_APPLIED',
      `摘要模型没写进去（引擎回读还是「${after || '空'}」），已回滚成原来的配置`,
      502
    )
  }
  const broken = preserved.filter((item) => !item.ok).map((item) => item.key)
  if (broken.length > 0) {
    await rollbackKbConfig(beforeRaw)
    throw new EngineError(
      'KB_CONFIG_NOT_PRESERVED',
      `改摘要模型时把别的配置也动了（${broken.join('、')}），已回滚成原来的配置`,
      502
    )
  }
  return {
    changed: true,
    message: '摘要模型已更新，其余配置回读一字未变',
    before,
    after,
    preserved
  }
}

/* ------------------------------------------------------------------ *
 * 流式问答（B07 用，路由见 routes/ask.ts）
 * ------------------------------------------------------------------ */

/** 流式问答的总时长上限：流式不能沿用 15s 非流式超时，否则长答案必被掐断 */
const ASK_TIMEOUT_MS = 180_000

/**
 * 兜底链路（knowledge-chat）的超时上限：T5 起与智能体链路分开收短。
 *
 * 为什么单独收短：实测当前引擎版本的 knowledge-chat 兜底链路**必然超时**
 * （带库字段 120s 不回、不带库字段 90s 不回），而智能体链路正常（50–79s 出答案）。
 * 沿用 180s 的话，公众点一次提问最多要干等 3 分钟才看到降级提示。
 * 这里给兜底链路 25s：超时就立刻按中文降级文案回「问答服务暂时不可用，请稍后重试」。
 */
const KNOWLEDGE_CHAT_TIMEOUT_MS = 25_000

/** 未配密钥就明确抛 ENGINE_NOT_CONFIGURED（路由据此降级，不让服务崩） */
function requireEngineApiKey(): string {
  const apiKey = readEnv('WEKNORA_API_KEY')
  if (!apiKey) {
    throw new EngineError(
      'ENGINE_NOT_CONFIGURED',
      'AI 问答暂未开放（当前为演示版，引擎未接入）',
      503
    )
  }
  return apiKey
}

/**
 * 创建一次问答会话，返回 session id。
 * **会话 id 只在服务端持有，绝不返回给前端**（前端只发问题、只收流）。
 */
export async function createAskSession(title: string): Promise<string> {
  // 云端演示版：ask 流程是「先建会话、再问答」，所以必须在建会话这里就拦，
  // 否则队友会看到「未配置 WEKNORA_API_KEY」这种内部错误文案（2026-10-08 实测踩中）。
  if (getDataSource() === 'snapshot') {
    throw new EngineError('ENGINE_NOT_CONFIGURED', 'AI 问答暂未开放（当前为演示版，引擎未接入）', 503)
  }
  const payload = await engineJson('/api/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.slice(0, 50) || 'web' })
  })
  const envelope = isRecord(payload) ? payload : {}
  const body = isRecord(envelope.data) ? envelope.data : envelope
  const id = pickString(body, ['id', 'session_id'])
  if (!id) {
    throw new EngineError('ENGINE_BAD_PAYLOAD', '引擎建会话成功但没返回 session id', 502)
  }
  return id
}

/**
 * 问一次知识库，拿到事件异步迭代器（调用方负责转成 HTTP SSE 流）
 *
 * ⚠️ 老师后台「问答设置」在这里生效（T3）：
 *   - 现读 backend/data/qa-settings.json（不缓存，改完下一次提问就生效）
 *   - 设了模型 → body 带 `summary_model_id`（**不是 model_id**，传了会被静默忽略）
 *   - 设了思考强度 → body 带 `reasoning_effort`（引擎原生参数）
 *   - 回答方式 → 在 query 前面拼一段风格指令
 *   读设置永远读不炸（文件坏了退回默认值），不会把问答主功能带崩。
 *
 * ⚠️ **T7：优先走引擎里的智能体**（`agent-chat`），失败自动回退 `knowledge-chat`。
 *   两条链路的事件形状**完全一致**（都产 AskEvent），所以路由层与前端都无感：
 *     智能体链路：POST /api/v1/agent-chat/{sessionId}
 *       body = {query: 原始问题, agent_id, agent_enabled: true}（**不下发库 id**）
 *       🔴 **不拼风格前缀**（提示词由智能体的 system_prompt 提供，再拼一遍会打架）
 *       🔴 **不下发 summary_model_id / reasoning_effort**（智能体有自己的 model_id / temperature，
 *          下发会和智能体配置冲突）
 *     兜底链路：POST /api/v1/knowledge-chat/{sessionId}（T3 的逻辑原样保留，一个字没改）
 *
 * ⚠️ 什么时候走智能体：`.env` 的 `WEKNORA_AGENT_ID` 有值、且这一轮 agent 请求在**开流前**就成功。
 *   引擎不存在这个 id（404）、拒绝（401/403）、参数不对（400）、连不上 —— 一律记一行 warn
 *   后自动回退 knowledge-chat，问答**照常可用**（任务单验收第 6 项）。
 *
 * ⚠️ 开流之后才断的（读到一半连接断了）**不回退**：回退会把已经吐出去的字再吐一遍，
 *   前端气泡会出现重复段落。这种情况仍按既有口径以 error 事件收尾。
 */
export async function askKnowledgeBase(params: {
  sessionId: string
  query: string
  /**
   * T7：走哪个智能体。**不传 = 从 .env 的 WEKNORA_AGENT_ID 读**；
   * 传空串 = 明确走兜底的 knowledge-chat（留个口子给将来做 A/B 对照）。
   */
  agentId?: string
  /** 外部取消（客户端断开）——真正透传给 fetch，让引擎侧也停下来 */
  signal?: AbortSignal
}): Promise<AsyncGenerator<AskEvent, void, void>> {
  // 云端演示版：快照数据源没有引擎可问 —— 不管密钥环境如何，一律友好拒绝。
  // （2026-10-08 实测：某些环境下密钥检查拦不住，问答会以诡异方式落到本地引擎上。）
  if (getDataSource() === 'snapshot') {
    throw new EngineError('ENGINE_NOT_CONFIGURED', 'AI 问答暂未开放（当前为演示版，引擎未接入）', 503)
  }
  const apiKey = requireEngineApiKey()
  /**
   * 兜底链路（knowledge-chat）用的**引擎集成默认库**。
   *
   * 🔴 这是引擎集成的默认库，不是用户可选的检索范围 —— 它是内部集成细节；
   *    面向访客的那层「由访客指定要检索哪些资料」的能力已于 2026-10-21 下线。
   *
   * ⚠️ 这份默认库**只给兜底链路用**：智能体链路（agent-chat）一律不下发库 id ——
   *    实测下发 knowledge_base_ids 会**覆盖智能体自己配置的库**（智能体按自己的
   *    knowledge_bases + kb_selection_mode: selected 走），那正是 T7-b 要修掉的「单库覆盖」。
   */
  const defaultLibraryIds: string[] = [engineKbId()]

  /* ── T7：先试智能体，失败自动回退 knowledge-chat ────────────────────── */
  const agentId = (params.agentId ?? getAgentId()).trim()
  if (agentId) {
    try {
      return await askAgentKnowledgeBase({ ...params, apiKey, agentId })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(
        `[weknora] 智能体问答没走成，自动回退到普通知识库问答（问答功能不受影响）：${reason}`
      )
    }
  }

  const url = `${engineBaseUrl().replace(/\/+$/, '')}/api/v1/knowledge-chat/${encodeURIComponent(
    params.sessionId
  )}`

  const qaSettings = loadQaSettings()
  const askBody: Record<string, unknown> = {
    query: buildStyledQuery(params.query, qaSettings.style),
    // 这是引擎集成的默认库，不是用户可选的检索范围（内部集成细节，仅兜底链路用）。
    knowledge_base_ids: defaultLibraryIds,
    ...buildEngineOverrides(qaSettings)
  }

  const controller = new AbortController()
  // 兜底链路用短超时：不让公众干等 3 分钟（T5）
  const timer = setTimeout(() => controller.abort(), KNOWLEDGE_CHAT_TIMEOUT_MS)
  const onExternalAbort = (): void => controller.abort()
  if (params.signal) {
    if (params.signal.aborted) controller.abort()
    else params.signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const cleanup = (): void => {
    clearTimeout(timer)
    params.signal?.removeEventListener('abort', onExternalAbort)
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'X-API-Key': apiKey,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(askBody)
    })
  } catch (err) {
    cleanup()
    const aborted = err instanceof Error && err.name === 'AbortError'
    // 对外只给中文降级文案：内部地址、引擎原文都不外泄（T5 契约 C6）
    throw new EngineError(
      aborted ? 'ENGINE_TIMEOUT' : 'ENGINE_UNREACHABLE',
      '问答服务暂时不可用，请稍后重试',
      504
    )
  }

  if (res.status === 401 || res.status === 403) {
    cleanup()
    throw new EngineError('ENGINE_UNAUTHORIZED', '引擎拒绝提问：API Key 无效或无权限', 502)
  }
  if (!res.ok) {
    cleanup()
    // 状态码与内部地址都不外泄（T5 契约 C6）
    // message 里带上状态码：仅用于**内部错误分类**（ask.ts 的 publicEngineError 据此识别 429，
    // 换成额度专用文案），对外信封不直接透出 message —— 引擎 URL / API Key / 上游 body 一律不进 message。
    throw new EngineError(
      'ENGINE_BAD_STATUS',
      `问答服务暂时不可用（引擎返回 ${res.status}），请稍后重试`,
      502
    )
  }
  if (!res.body) {
    cleanup()
    throw new EngineError('ENGINE_EMPTY_BODY', '引擎问答接口没返回响应体', 502)
  }

  const body = res.body
  return (async function* iterate(): AsyncGenerator<AskEvent, void, void> {
    try {
      // 传脱敏标识而不是引擎地址：断流错误消息里不能出现内部地址（T5 契约 C6）
      yield* parseSseStream(body, '引擎问答流')
    } finally {
      cleanup()
    }
  })()
}

/* ------------------------------------------------------------------ *
 * 智能体问答（T7：agent-chat 链路 + 失败自动回退）
 * ------------------------------------------------------------------ */

/**
 * 走引擎里的智能体提问：POST /api/v1/agent-chat/{sessionId}
 *
 * 🔴 body 的三处要点（少一处就不对）：
 *   1. `query` 是**原始问题**，不拼 T3 的风格前缀 —— 提示词由智能体的 system_prompt 提供
 *   2. **不下发** summary_model_id / reasoning_effort —— 智能体自己带 model_id / temperature，
 *      再下发会和智能体配置打架
 *   3. **不下发** `knowledge_base_ids` —— 下发会**覆盖**智能体自己配置的库，
 *      智能体按自己的 `knowledge_bases` + `kb_selection_mode: selected` 走。
 *      （引擎集成的默认库，不是用户可选的检索范围，只在兜底链路 knowledge-chat 用 —— 见 askKnowledgeBase）
 *
 * 抛错 = 开流前失败（网络/401/403/400/无响应体），由 askKnowledgeBase 捕获后回退 knowledge-chat。
 * 开流之后的异常不在这里处理（那时已经吐过字了，回退会造成重复段落）。
 */
async function askAgentKnowledgeBase(params: {
  sessionId: string
  query: string
  signal?: AbortSignal
  apiKey: string
  agentId: string
}): Promise<AsyncGenerator<AskEvent, void, void>> {
  const url = `${engineBaseUrl().replace(/\/+$/, '')}/api/v1/agent-chat/${encodeURIComponent(
    params.sessionId
  )}`

  const askBody: Record<string, unknown> = {
    query: params.query,
    agent_id: params.agentId,
    agent_enabled: true
  }
  // 🔴 刻意**不下发**库 id：下发 knowledge_base_ids 会覆盖智能体自己配置的库
  //    （引擎集成的默认库不是用户可选的检索范围，只在兜底链路用），
  //    智能体应当按自己的 knowledge_bases + kb_selection_mode: selected 走。

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS)
  const onExternalAbort = (): void => controller.abort()
  if (params.signal) {
    if (params.signal.aborted) controller.abort()
    else params.signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const cleanup = (): void => {
    clearTimeout(timer)
    params.signal?.removeEventListener('abort', onExternalAbort)
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'X-API-Key': params.apiKey,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(askBody)
    })
  } catch (err) {
    cleanup()
    const aborted = err instanceof Error && err.name === 'AbortError'
    // 对外只给中文降级文案：内部地址不外泄（T5 契约 C6）
    throw new EngineError(
      aborted ? 'ENGINE_TIMEOUT' : 'ENGINE_UNREACHABLE',
      '问答服务暂时不可用，请稍后重试',
      504
    )
  }

  // 🔴 下面的三个分支**必须抛错**，不能 return：抛出去才会被 askKnowledgeBase 捕获并回退。
  if (res.status === 401 || res.status === 403) {
    cleanup()
    throw new EngineError('ENGINE_UNAUTHORIZED', '智能体拒绝提问：API Key 无效或无权限', 502)
  }
  if (!res.ok) {
    cleanup()
    // 引擎正文与 agent_id 只进服务端日志，对外不给（T5 契约 C6）
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    console.warn(`[weknora] 智能体问答返回异常状态 ${res.status}：${detail}`)
    // message 里带上状态码：仅用于**内部错误分类**（ask.ts 的 publicEngineError 据此识别 429，
    // 换成额度专用文案），对外信封不直接透出 message —— 引擎 URL / API Key / 上游 body 一律不进 message。
    throw new EngineError(
      'ENGINE_BAD_STATUS',
      `问答服务暂时不可用（引擎返回 ${res.status}），请稍后重试`,
      502
    )
  }
  if (!res.body) {
    cleanup()
    throw new EngineError('ENGINE_EMPTY_BODY', '智能体问答接口没返回响应体', 502)
  }

  const body = res.body
  const raw = (async function* iterate(): AsyncGenerator<AskEvent, void, void> {
    try {
      // 传脱敏标识而不是引擎地址：断流错误消息里不能出现内部地址（T5 契约 C6）
      yield* parseSseStream(body, '引擎问答流')
    } finally {
      cleanup()
    }
  })()

  // 适配层：thinking / tool_call / tool_result / agent_query 计数后丢弃，
  // references 转成来源卡片，answer 原样透传（前端组件零改动）
  return translateAgentStream(raw, createAgentCounters(), {
    resolveDoc: makeAgentDocResolver()
  })
}

/**
 * 给适配层的资料查询：用 `knowledge_id` 在**书架已拉的全量清单**里本地关联 org/year/type。
 *
 * ⚠️ 不为一条引用单独发请求：listFiles() 自带 60 秒缓存，第一次调用拉全量、之后命中缓存。
 *    关联不上就返回 null（适配层会跳过这条引用，绝不给点进去 404 的死链）。
 */
function makeAgentDocResolver(): ResolveAgentDoc {
  let pool: Map<string, AgentSourceDoc> | null = null
  return async (knowledgeId: string): Promise<AgentSourceDoc | null> => {
    if (pool === null) {
      try {
        const docs = await listFiles()
        pool = new Map(docs.map((doc) => [doc.id, doc]))
      } catch {
        // 取不到清单就让这次关联整体失效（返回 null），绝不抛给问答链路
        pool = new Map()
      }
    }
    return pool.get(knowledgeId) ?? null
  }
}

/* ------------------------------------------------------------------ *
 * 引用来源解析（T4：B07 的「来源卡片」）
 * ------------------------------------------------------------------ */

/** 前端来源卡片的一条，契约见 docs/接口约定.md 第二节「流式问答」 */
export interface AskSource {
  /** 展示用的资料名（资料的 title，取不到则退回文件名） */
  name: string
  /** 站内详情页地址 */
  url: string
  /**
   * 【T8 追加，可选】发布机构 / 发布年份 / 类型。
   *
   * 来源：智能体链路优先读引用自带的 `data.references[].knowledge_custom_metadata`
   * （YAML 风格字符串），读不到才退回书架清单本地关联（见 weknora/agent-sse.ts）。
   * 前端 `AskSource` 只多两个可选字段，**不认它的旧调用方行为完全不变**。
   */
  org?: string
  year?: string
  type?: string
}

/** 来源卡片最多几条：再多气泡太长，读者也用不完 */
const MAX_SOURCES = 5

/**
 * 三种引用标记都要认，缺一不可 —— **模型在同一套提示词下并不稳定**，实测三种都出现过：
 *
 * 1. `<kb doc="382-厨余垃圾全生命低碳管理综述.pdf" chunk_id="…" kb_id="…" />`
 *    —— WeKnora 原生的引用组件标记（T4 任务单就是照这个格式写的）。
 * 2. `【资料名：382-厨余垃圾全生命低碳管理综述-厨余垃圾全生命低碳管理综述.pdf】`
 *    —— 知识问答风格提示词（qa-settings.ts 的 STYLE_PROMPTS.knowledge）要求
 *       「每点末尾用【资料名】注明出处」，模型多数时候照做。
 * 3. `【厨余垃圾全生命低碳管理综述】`
 *    —— **模型偷懒版**：只给标题，连「资料名：」前缀、文件名序号与扩展名全省了。
 *
 * 2026-10-12 连续两次真机实测（同一个问题、同一套提示词）：第一次全是第 2 种，
 * 第二次全是第 3 种，两次 `<kb>` 都是 0 个。所以只认第 1 种 → 卡片恒为空；
 * 只认前两种 → 时灵时不灵。三种都收，才稳。
 *
 * ⚠️ 第 3 种是「裸方括号」，和正文里 `【注意】` 这类正常内容长得一样。
 *    靠**匹配不上就丢弃**来区分（见 resolveCitationSources），不靠猜。
 */
const CITATION_KB_TAG = /<kb\s+doc="([^"]+)"[^>]*?\/?>/g
const CITATION_BRACKET_NAMED = /【\s*资料名[：:]\s*([^】]+?)\s*】/g
const CITATION_BRACKET_BARE = /【([^】]{2,})】/g
/**
 * **没闭合的** `【资料名：xxx` —— 回答在模型输出上限处被截断时，引用常常正好断在括号里
 * （2026-10-12 实测：`…—“十四五”城镇生活` 后面就没了）。上面两条都要求 `】`，会整条漏掉。
 * 放到最后跑：闭合的那种已经被前面的规则收进去并去重了。
 */
const CITATION_BRACKET_OPEN = /【\s*资料名[：:]\s*([^】\n]{4,})/g

/** 引用名里可能带的「资料名：」前缀（裸方括号那条要自己剥掉，否则去重对不上） */
const CITATION_NAME_PREFIX = /^\s*资料名\s*[：:]\s*/

/** 要去掉的扩展名（比对前统一剥掉） */
const DOC_EXTENSION = /\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|rtf|ofd)$/i

/**
 * 比对用的归一化键：去扩展名 → 去掉**所有**空白 → 转小写。
 *
 * ⚠️ 必须去所有空白（不是 trim 就完事）：模型抄文件名时常把空格吃掉或换成全角空格，
 *    留着空白会让本该命中的条目落空。去掉后 `382-厨余垃圾全生命低碳管理综述.pdf`
 *    与 `382-厨余垃圾全生命低碳管理综述` 才算同一个东西。
 */
function normalizeDocKey(raw: string): string {
  return raw
    .replace(CITATION_NAME_PREFIX, '')
    .trim()
    .replace(DOC_EXTENSION, '')
    .replace(/\s+/gu, '')
    .toLowerCase()
}

/**
 * 资料「核心名」：去掉开头的建档序号（`382-`）与文件名里重复的标题尾巴（`-标题-标题`）。
 *
 * 为什么需要：本库文件名是「序号-机构-标题」拼法，而入库时机构与标题常是同一句话，
 * 于是文件名长成 `280-《神奇的黑水虻》-《神奇的黑水虻》`。模型引用时只写标题
 * （`【神奇的黑水虻】`），既不等于完整文件名也不等于 title，得有个中间键才比得上。
 */
function coreKeys(doc: KbDocInternal): string[] {
  const cores: string[] = []
  for (const raw of [doc.fileName, doc.title]) {
    let key = normalizeDocKey(raw)
    const dash = key.indexOf('-')
    if (dash > 0 && /^\d+$/.test(key.slice(0, dash))) key = key.slice(dash + 1)
    // `A-A` 折叠成 `A`（倒着找一遍，容忍标题本身含破折号的情况）
    for (let i = key.length - 1; i > 0; i -= 1) {
      if (key[i] !== '-') continue
      const head = key.slice(0, i)
      if (head && head === key.slice(i + 1) && !cores.includes(head)) cores.push(head)
    }
    if (key && !cores.includes(key)) cores.push(key)
  }
  return cores
}

/** 一份资料可用于比对的键：核心名 / 文件名 / 标题（去重、丢掉空的） */
function docKeys(doc: KbDocInternal): string[] {
  const keys: string[] = []
  const all = [...coreKeys(doc), normalizeDocKey(doc.fileName), normalizeDocKey(doc.title)]
  for (const key of all) {
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/** 提取回答里引用的资料名（按「越明确的越先」排序，裸方括号那种靠后的兜底） */
function extractCitationNames(answerText: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const collect = (name: string): void => {
    const key = normalizeDocKey(name)
    if (!key || seen.has(key)) return
    seen.add(key)
    found.push(name)
  }
  for (const match of answerText.matchAll(CITATION_KB_TAG)) collect(match[1] ?? '')
  for (const match of answerText.matchAll(CITATION_BRACKET_NAMED)) collect(match[1] ?? '')
  for (const match of answerText.matchAll(CITATION_BRACKET_BARE)) collect(match[1] ?? '')
  for (const match of answerText.matchAll(CITATION_BRACKET_OPEN)) collect(match[1] ?? '')
  return found
}

/**
 * 包含式回退的门槛：太短的引用（如 `【注意】`、`【要点】`）不足以确认是哪份资料，
 * 宁可不给卡片也不给可能点错的链接。实测三条真引用里最短的是 `神奇的黑水虻`（6 字）。
 */
const MIN_CONTAIN_LEN = 6

/**
 * 在资料池里找一条引用对应的资料：先精确匹配，再包含式回退。
 *
 * 回退要同时覆盖两种残缺：
 *   - 模型只写了标题：`【厨余垃圾全生命低碳管理综述】` 对上
 *     `382-厨余垃圾全生命低碳管理综述-厨余垃圾全生命低碳管理综述`
 *   - 回答在**模型输出上限处被截断**，文件名只剩前半截
 *     （2026-10-12 实测见过 `88-“十四五”…-“十四五”城镇生活`）
 * 多个候选时取**键最短**的那条（最贴近引用的那一本），并列则取库里靠前的。
 */
function matchDoc(citationKey: string, entries: DocEntry[]): KbDocInternal | null {
  for (const entry of entries) {
    if (entry.keys.includes(citationKey)) return entry.doc
  }
  if (citationKey.length < MIN_CONTAIN_LEN) return null
  let best: KbDocInternal | null = null
  let bestKeyLen = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    for (const key of entry.keys) {
      // ⚠️ 这里只能判「包含」，不能判「前缀」：模型引用 `神奇的黑水虻`，
      //    而库里的核心名是 `《神奇的黑水虻》`（带书名号）—— 包含成立，前缀不成立。
      if (!key.includes(citationKey) && !citationKey.includes(key)) continue
      if (key.length < bestKeyLen) {
        best = entry.doc
        bestKeyLen = key.length
      }
    }
  }
  return best
}

interface DocEntry {
  doc: KbDocInternal
  keys: string[]
}

/**
 * 把回答正文里的引用标记解析成「来源卡片」。
 *
 * ⚠️ **本函数绝不抛异常**：这里失败只能表现为「这次没有来源卡片」，
 *    绝不能把已经流完的回答带崩 —— 来源是锦上添花，答案是主功能。
 *    取不到资料清单就返回空数组（宁可不给卡片，也不给点进去 404 的死链）。
 */
export async function resolveCitationSources(answerText: string): Promise<AskSource[]> {
  if (!answerText.trim()) return []
  const names = extractCitationNames(answerText)
  if (names.length === 0) return []

  let pool: KbDocInternal[]
  try {
    pool = await listFiles()
  } catch {
    return []
  }

  const entries: DocEntry[] = pool.map((doc) => ({ doc, keys: docKeys(doc) }))
  const out: AskSource[] = []
  const usedIds = new Set<string>()
  for (const raw of names) {
    if (out.length >= MAX_SOURCES) break
    const doc = matchDoc(normalizeDocKey(raw), entries)
    // 匹配不到就跳过这条（不放死链接）
    if (!doc || usedIds.has(doc.id)) continue
    usedIds.add(doc.id)
    out.push({ name: doc.title || doc.fileName || raw, url: `/doc/${doc.id}` })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain; charset=utf-8'
}

function guessContentType(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return CONTENT_TYPES[fileName.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 下载文件名：契约要求「年份-机构-标题」。
 *
 * ⚠️ 标题本身就是文件名（多半已带扩展名），不能无条件再拼 `.pdf` ——
 * 否则会得到 `xxx.pdf.pdf`（2026-10-08 实测踩过）。这里保留原扩展名，
 * 没有扩展名时才补 `.pdf`。
 */
export function buildDownloadName(doc: { year: number; org: string; title: string }): string {
  const clean = (text: string): string =>
    text
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
  const year = doc.year > 0 ? String(doc.year) : '年份待补'
  const source = clean(doc.title) || '未命名'
  const dot = source.lastIndexOf('.')
  const stem = dot > 0 ? source.slice(0, dot) : source
  const ext = dot > 0 ? source.slice(dot) : '.pdf'
  return `${year}-${clean(doc.org) || '机构待补'}-${stem}${ext}`
}

/**
 * 组装 Content-Disposition，中文名走 RFC 5987，避免浏览器乱码。
 *
 * 同时给一个「能看懂的」ASCII 兜底名：老写法把每个非 ASCII 字符都换成下划线，
 * 浏览器不支持 filename* 时就下载成 "2026______-_____________.pdf"，人根本认不出是什么。
 * 现在保留文件名里的 ASCII 片段（年份、英文、扩展名），中文段落折成一个短横线，
 * 实在没有 ASCII 内容时用 document 兜底。
 */
export function contentDisposition(fileName: string, mode: 'inline' | 'attachment'): string {
  const extMatch = /\.[A-Za-z0-9]{1,8}$/.exec(fileName)
  const ext = extMatch ? extMatch[0] : ''
  const stem = ext ? fileName.slice(0, fileName.length - ext.length) : fileName
  const asciiStem = stem
    .replace(/[^\x20-\x7e]+/g, '-')
    .replace(/["\\]/g, '_')
    .replace(/-{2,}/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '')
  const safeStem = asciiStem.length > 0 ? asciiStem : 'document'
  const ascii = `${safeStem}${ext}`.replace(/[^\x20-\x7e]/g, '_')
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}
