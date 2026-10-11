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
    sizeDeclared: typeof sizeDeclared === 'number' ? sizeDeclared : null
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
    throw new EngineError(
      aborted ? 'ENGINE_TIMEOUT' : 'ENGINE_UNREACHABLE',
      aborted
        ? `引擎响应超时（${ENGINE_TIMEOUT_MS / 1000}s）：${url}`
        : `连不上引擎 ${url}，请确认引擎已启动、地址正确`,
      504
    )
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401 || res.status === 403) {
    throw new EngineError('ENGINE_UNAUTHORIZED', '引擎拒绝：API Key 无效或无权限', 502)
  }
  if (!res.ok) {
    throw new EngineError('ENGINE_BAD_STATUS', `引擎返回 ${res.status}：${url}`, 502)
  }
  return res
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
 *   org / year / type / tags —— 引擎的 custom_metadata（元数据补录写入）
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
    for (const row of rows) all.push(toEngineDoc(row))
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
 */
/** 取知识库文件列表。 */
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
      body: JSON.stringify({ query: keyword })
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
  const payload = await engineJson(`/api/v1/knowledge/${encodeURIComponent(id)}`)
  const raw = isRecord(payload) && isRecord(payload['data']) ? payload['data'] : payload
  return toEngineDoc(raw)
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

/**
 * 列引擎当前可用的**知识问答模型**（老师后台「问答设置」用）。
 *
 * ⚠️ 引擎的 `GET /api/v1/models` **不支持 `?type=` 过滤参数** ——
 * 它后端一个 query 都不读（WeKnora 前端那个 `listModels(type)` 是在浏览器里
 * 过滤的，纯客户端行为）。所以这里必须自己按 type 过滤。
 *
 * ⚠️ name 优先取 `name` 而不是 `display_name`：前者是模型真实身份
 * （如 LongCat-2.5-Preview），后者可能只是运营随手起的标签（如「测试」），
 * 老师选模型时看真实名字更有用。
 */
export async function listQaModels(): Promise<QaModelOption[]> {
  const payload = await engineJson('/api/v1/models')
  const rows = extractArray(payload)
  const models: QaModelOption[] = []
  for (const raw of rows) {
    if (!isRecord(raw)) continue
    if (pickString(raw, ['type']) !== 'KnowledgeQA') continue
    const id = pickString(raw, ['id'])
    if (!id) continue
    models.push({
      id,
      name: pickString(raw, ['name', 'display_name']) || id,
      type: 'KnowledgeQA',
      status: pickString(raw, ['status'])
    })
  }
  return models
}

/* ------------------------------------------------------------------ *
 * 流式问答（B07 用，路由见 routes/ask.ts）
 * ------------------------------------------------------------------ */

/** 流式问答的总时长上限：流式不能沿用 15s 非流式超时，否则长答案必被掐断 */
const ASK_TIMEOUT_MS = 180_000

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
 */
export async function askKnowledgeBase(params: {
  sessionId: string
  query: string
  knowledgeBaseIds?: string[]
  /** 外部取消（客户端断开）——真正透传给 fetch，让引擎侧也停下来 */
  signal?: AbortSignal
}): Promise<AsyncGenerator<AskEvent, void, void>> {
  // 云端演示版：快照数据源没有引擎可问 —— 不管密钥环境如何，一律友好拒绝。
  // （2026-10-08 实测：某些环境下密钥检查拦不住，问答会以诡异方式落到本地引擎上。）
  if (getDataSource() === 'snapshot') {
    throw new EngineError('ENGINE_NOT_CONFIGURED', 'AI 问答暂未开放（当前为演示版，引擎未接入）', 503)
  }
  const apiKey = requireEngineApiKey()
  const kbIds =
    params.knowledgeBaseIds && params.knowledgeBaseIds.length > 0
      ? params.knowledgeBaseIds
      : [engineKbId()]
  const url = `${engineBaseUrl().replace(/\/+$/, '')}/api/v1/knowledge-chat/${encodeURIComponent(
    params.sessionId
  )}`

  const qaSettings = loadQaSettings()
  const askBody: Record<string, unknown> = {
    query: buildStyledQuery(params.query, qaSettings.style),
    knowledge_base_ids: kbIds,
    ...buildEngineOverrides(qaSettings)
  }

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
        'X-API-Key': apiKey,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(askBody)
    })
  } catch (err) {
    cleanup()
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new EngineError(
      aborted ? 'ENGINE_TIMEOUT' : 'ENGINE_UNREACHABLE',
      aborted
        ? `引擎问答超时（${ASK_TIMEOUT_MS / 1000}s）：${url}`
        : `连不上引擎 ${url}，请确认引擎已启动、地址正确`,
      504
    )
  }

  if (res.status === 401 || res.status === 403) {
    cleanup()
    throw new EngineError('ENGINE_UNAUTHORIZED', '引擎拒绝提问：API Key 无效或无权限', 502)
  }
  if (!res.ok) {
    cleanup()
    throw new EngineError('ENGINE_BAD_STATUS', `引擎问答返回 ${res.status}：${url}`, 502)
  }
  if (!res.body) {
    cleanup()
    throw new EngineError('ENGINE_EMPTY_BODY', '引擎问答接口没返回响应体', 502)
  }

  const body = res.body
  return (async function* iterate(): AsyncGenerator<AskEvent, void, void> {
    try {
      yield* parseSseStream(body, url)
    } finally {
      cleanup()
    }
  })()
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

/** 组装 Content-Disposition，中文名走 RFC 5987，避免浏览器乱码 */
export function contentDisposition(fileName: string, mode: 'inline' | 'attachment'): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}
