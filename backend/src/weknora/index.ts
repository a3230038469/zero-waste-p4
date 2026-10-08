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
      '[weknora] 原因：未配置 WEKNORA_API_KEY / WEKNORA_KB_ID。' +
      '配好密钥后自动切回真实引擎，无需改代码。'
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
 * 把引擎返回的一条记录归一化成契约字段。
 *
 * ⚠️ 待真机联调：WeKnora v0.8.2 的文件列表字段名尚未在真机上核对过，
 * 这里按常见命名做了容错取值（见 docs/接口约定.md 第五节）。
 * 拿到真实回显后，把用不到的候选键删掉，只留实测通过的那一个。
 */
function toEngineDoc(raw: unknown): KbDocInternal {
  if (!isRecord(raw)) {
    throw new EngineError('ENGINE_BAD_PAYLOAD', '引擎返回的记录格式不符合预期', 502)
  }
  const id = pickString(raw, ['id', 'knowledge_id', 'file_id'])
  const fileName = pickString(raw, ['file_name', 'filename', 'name', 'title'])
  const size = pickNumber(raw, ['size', 'file_size'])
  return {
    id,
    title: pickString(raw, ['title', 'name', 'file_name']) || fileName,
    org: pickString(raw, ['org', 'organization', 'publisher', 'source_org']) || '未标注',
    year: pickNumber(raw, ['year', 'publish_year', 'published_year']),
    type: pickString(raw, ['type', 'category', 'doc_type']) || '未分类',
    tags: pickTags(raw, ['tags', 'topics', 'keywords']),
    size,
    sourceUrl: pickString(raw, ['source_url', 'url', 'source']),
    fileName,
    filePath: '',
    sizeDeclared: size
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

/** 取知识库文件列表 */
export async function listFiles(): Promise<KbDocInternal[]> {
  if (getDataSource() === 'local') return loadLocalDocs()
  const payload = await engineJson(`/api/v1/knowledge-bases/${engineKbId()}/files`)
  return extractArray(payload).map(toEngineDoc)
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
  if (getDataSource() === 'local') {
    const doc = loadLocalDocs().find((d) => d.id === id)
    if (!doc) throw new EngineError('DOC_NOT_FOUND', `没有这份资料：${id}`, 404)
    return doc
  }
  return toEngineDoc(await engineJson(`/api/v1/knowledge/${encodeURIComponent(id)}`))
}

/**
 * 取资料文件流（预览 / 下载共用）。
 *
 * mode=inline 给在线预览，mode=attachment 给下载；本地与引擎两种来源统一成 DocStream。
 */
export async function getFileStream(id: string, mode: 'inline' | 'attachment'): Promise<DocStream> {
  const doc = await getDoc(id)

  if (getDataSource() === 'local') {
    return {
      fileName: doc.fileName,
      size: doc.size,
      contentType: guessContentType(doc.fileName),
      stream: createReadStream(localAbsPath(doc))
    }
  }

  const suffix = mode === 'attachment' ? 'download' : 'preview'
  const res = await engineFetch(`/api/v1/knowledge/${encodeURIComponent(id)}/${suffix}`)
  if (!res.body) {
    throw new EngineError('ENGINE_EMPTY_BODY', '引擎返回了空文件流', 502)
  }
  const declared = Number(res.headers.get('content-length') ?? '')
  return {
    fileName: doc.fileName || `${id}.pdf`,
    size: Number.isFinite(declared) && declared > 0 ? declared : doc.size,
    contentType: res.headers.get('content-type') ?? guessContentType(doc.fileName),
    stream: Readable.fromWeb(res.body)
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
      '问答引擎尚未配置（缺 WEKNORA_API_KEY），AI 暂时不可用',
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

/** 问一次知识库，拿到事件异步迭代器（调用方负责转成 HTTP SSE 流） */
export async function askKnowledgeBase(params: {
  sessionId: string
  query: string
  knowledgeBaseIds?: string[]
  /** 外部取消（客户端断开）——真正透传给 fetch，让引擎侧也停下来 */
  signal?: AbortSignal
}): Promise<AsyncGenerator<AskEvent, void, void>> {
  const apiKey = requireEngineApiKey()
  const kbIds =
    params.knowledgeBaseIds && params.knowledgeBaseIds.length > 0
      ? params.knowledgeBaseIds
      : [engineKbId()]
  const url = `${engineBaseUrl().replace(/\/+$/, '')}/api/v1/knowledge-chat/${encodeURIComponent(
    params.sessionId
  )}`

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
      body: JSON.stringify({ query: params.query, knowledge_base_ids: kbIds })
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

/** 下载文件名：契约要求「年份-机构-标题」 */
export function buildDownloadName(doc: { year: number; org: string; title: string }): string {
  const clean = (text: string): string =>
    text
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
  const year = doc.year > 0 ? String(doc.year) : '年份待补'
  return `${year}-${clean(doc.org) || '机构待补'}-${clean(doc.title) || '未命名'}.pdf`
}

/** 组装 Content-Disposition，中文名走 RFC 5987，避免浏览器乱码 */
export function contentDisposition(fileName: string, mode: 'inline' | 'attachment'): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}
