/**
 * 解析引擎配置读写层（T10：老师后台「设置」页的 MinerU / 解析引擎设置 + 一键自检）
 *
 * 引擎侧接口（本文件代理的只有这三条）：
 *   GET  /api/v1/tenants/kv/parser-engine-config   读全量配置（密钥字段是脱敏的 `***`）
 *   PUT  /api/v1/tenants/kv/parser-engine-config   写配置 —— 🔴 **整体替换，不是字段级合并**
 *   POST /api/v1/system/parser-engines/check      按传入配置实测各解析引擎可用性
 *   GET  /api/v1/system/parser-engines             列各解析引擎及当前可用性
 *
 * ─────────────────────────────────────────────────────────────────
 * 🔴 写入为什么必须走这个文件：PUT 是「整体替换」
 * ─────────────────────────────────────────────────────────────────
 * 主控 2026-10-14 实测：只提交 `mineru_language` 一个字段，18 个字段被清掉 15 个。
 * 所以写入路径被写死成五步，**没有第二条路**：
 *
 *   1. GET 全量配置（原始对象，一个字不改）
 *   2. 把本次要改的字段覆盖上去（用户没填的字段保持原值）
 *   3. PUT **除密钥外的全部字段**（少一个就可能被清零）
 *   4. 再 GET 一次，逐字段比对（期望 = 第 ③ 步提交的那份）
 *   5. 校验结果如实返回给前端（哪一项没过就写哪一项，不静默吞掉）
 *
 * ─────────────────────────────────────────────────────────────────
 * 🔴 密钥字段的三条硬规则（主控实测踩过坑）
 * ─────────────────────────────────────────────────────────────────
 *   1. 引擎 GET 回来的密钥是**脱敏的** `***`（这是「已保存」的标志，不是空值）；
 *   2. 用户填了新密钥 → 提交新值；
 *   3. 用户没填 → **不提交该字段**（实测：不提交时引擎保留原值）；
 *      ⛔ 绝对不要「把 GET 回来的 `***` 原样 PUT 回去」——那会把真密钥覆盖成 `***`。
 *
 * 密钥字段不靠字段名单识别（引擎版本会加字段），而是按**字段名**判定：
 * 含 `key` / `token` / `secret` / `password` 的一律按密钥处理 —— 不回显、不比对真值，
 * 只回「已配置 / 未配置」。当前引擎实测 18 个字段里只有 `mineru_api_key` 命中。
 */
import { EngineError } from './types.js'

/* ------------------------------------------------------------------ *
 * 环境与引擎调用（与 agent-config.ts 同一套写法）
 * ------------------------------------------------------------------ */

/** 占位符识别：.env.example 抄来的值不算配置好 */
const PLACEHOLDER = /^(your_|please_|change_?me|xxx|todo)/i

function readEnv(name: string): string {
  const value = (process.env[name] ?? '').trim()
  if (!value || PLACEHOLDER.test(value)) return ''
  return value
}

function engineBaseUrl(): string {
  return readEnv('WEKNORA_BASE_URL') || 'http://localhost:8080'
}

/** 普通读写的超时（引擎在 Docker 里，冷启动会慢一点） */
const PARSER_TIMEOUT_MS = 20_000

/** 一键自检探活引擎时的超时（任务单第五节给的 5s） */
export const SELFCHECK_ENGINE_TIMEOUT_MS = 5_000

/**
 * 一次引擎调用（带 X-API-Key 与超时），只把「连不上 / 超时」抛成 EngineError。
 *
 * ⚠️ HTTP 状态码由调用方自己判（404 与 500 的处理完全不同），沿用本仓既有的写法。
 */
async function parserFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = PARSER_TIMEOUT_MS
): Promise<Response> {
  const apiKey = readEnv('WEKNORA_API_KEY')
  if (!apiKey) {
    throw new EngineError('ENGINE_NOT_CONFIGURED', '未配置 WEKNORA_API_KEY，读不了解析引擎设置', 503)
  }
  const url = `${engineBaseUrl().replace(/\/+$/, '')}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
        ...(init.headers ?? {})
      }
    })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new EngineError(
      aborted ? 'ENGINE_TIMEOUT' : 'ENGINE_UNREACHABLE',
      aborted ? `引擎响应超时（${timeoutMs / 1000}s）` : '连不上引擎地址',
      504
    )
  } finally {
    clearTimeout(timer)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 展示用：把任意值压成一行短文本（校验表里显示「期望 / 实际」） */
function tokenOf(value: unknown): string {
  if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 40)}…` : value
  if (value === undefined) return '(无)'
  if (value === null) return '(空)'
  return String(value)
}

/* ------------------------------------------------------------------ *
 * 字段与密钥
 * ------------------------------------------------------------------ */

/**
 * 引擎那份配置的原始形状。
 *
 * ⚠️ 故意用 `Record<string, unknown>` 而不是逐字段写死一个 interface：
 *   这个接口的字段数随引擎版本变（当前实测 18 个），**我们不在代码里复述它** ——
 *   写死就等于「引擎加一个字段，我们这边不知道，PUT 时它就被清掉了」。
 *   读到的原样带回去，才是对的。
 */
export type ParserConfigMap = Record<string, unknown>

/** 能进表单的基本类型（引擎的 ParserEngineConfig 只有这三种） */
export type ParserPrimitive = string | number | boolean

/** 密钥字段的判定：字段名带 key / token / secret / password 的一律按密钥处理 */
const SECRET_FIELD = /(key|token|secret|password)/i

export function isParserSecretField(key: string): boolean {
  return SECRET_FIELD.test(key)
}

/**
 * 「这个密钥字段算不算已配置」。
 *
 * ⚠️ 口径（2026-10-14 真机实测，别改）：引擎对**已保存**的密钥回的是脱敏串 `***`，
 *    对没配的字段回的是空串。所以判据是「非空」，**不是**「是不是 `***`」。
 *    佐证：本机 MinerU 云解析 `mineru_cloud.Available = true`（说明那把 key 是好的），
 *    而同一时刻 `GET` 回来的 `mineru_api_key` 就是 `***`。
 *    若按「`***` 视为未配置」去判，页面上会一直显示「未配置」，与真实状态相反。
 */
function isConfiguredSecret(value: unknown): boolean {
  return str(value).trim() !== ''
}

/** 一个密钥字段的公开状态（**只回这个，绝不回真值**） */
export interface ParserSecretState {
  configured: boolean
}

/** GET /api/admin/parser-config 里的 `values`：非密钥字段的原值 */
export type ParserPublicValues = Record<string, ParserPrimitive>

/** 各字段的中文名（只影响展示；没列到的字段直接显示字段名） */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  mineru_api_key: 'MinerU 云解析 API Key',
  mineru_endpoint: 'MinerU 服务地址',
  mineru_model: 'MinerU 模型',
  mineru_parse_method: '解析方式',
  mineru_language: '默认语言',
  mineru_enable_ocr: 'OCR 识别',
  mineru_enable_table: '表格识别',
  mineru_enable_formula: '公式识别',
  mineru_cloud_model: '云解析模型',
  mineru_cloud_language: '云解析语言',
  mineru_cloud_enable_ocr: '云解析 OCR',
  mineru_cloud_enable_table: '云解析表格识别',
  mineru_cloud_enable_formula: '云解析公式识别',
  paddleocr_vl_use_seal_recognition: 'PaddleOCR 印章识别',
  paddleocr_vl_use_chart_recognition: 'PaddleOCR 图表识别',
  paddleocr_vl_cloud_model: 'PaddleOCR 云模型',
  paddleocr_vl_cloud_token: 'PaddleOCR 云端 Token',
  paddleocr_vl_cloud_use_seal_recognition: 'PaddleOCR 云端印章识别',
  paddleocr_vl_cloud_use_chart_recognition: 'PaddleOCR 云端图表识别'
}

export function parserFieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key
}

/** 把引擎那份配置折成「可安全外发」的视图：密钥只留 configured */
export function toPublicParserConfig(map: ParserConfigMap): {
  values: ParserPublicValues
  secrets: Record<string, ParserSecretState>
} {
  const values: ParserPublicValues = {}
  const secrets: Record<string, ParserSecretState> = {}
  for (const [key, value] of Object.entries(map)) {
    if (isParserSecretField(key)) {
      secrets[key] = { configured: isConfiguredSecret(value) }
      continue
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
      values[key] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      values[key] = value
    }
    // 其它形状（数组/对象）不外发：它们不是表单能表达的类型，也不该原样丢给前端
  }
  return { values, secrets }
}

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

/**
 * GET /api/v1/tenants/kv/parser-engine-config 的全量原始结果（**一个字都不裁剪**）。
 *
 * 🔴 updateParserConfig 依赖这里拿到的**全量**配置做合并 —— 一旦这里做白名单过滤，
 *    PUT 就会把没在白名单里的字段全部清零（这正是要防的事故）。
 */
export async function fetchParserConfigMap(): Promise<ParserConfigMap> {
  const res = await parserFetch('/api/v1/tenants/kv/parser-engine-config')
  if (res.status === 401 || res.status === 403) {
    throw new EngineError('ENGINE_UNAUTHORIZED', '引擎拒绝：API Key 无效或无权限', 502)
  }
  if (!res.ok) {
    throw new EngineError('ENGINE_BAD_STATUS', `引擎返回 ${res.status}（读解析引擎配置）`, 502)
  }
  const payload: unknown = await res.json().catch(() => null)
  // 引擎这批 kv 接口统一包一层 {success, data:{…}}（2026-10-14 实测）
  const data = isRecord(payload) && isRecord(payload['data']) ? payload['data'] : payload
  if (!isRecord(data)) {
    throw new EngineError('ENGINE_BAD_PAYLOAD', '引擎返回的解析引擎配置格式不符合预期', 502)
  }
  return data
}

/* ------------------------------------------------------------------ *
 * 解析引擎可用性（列表 / 测试连接）
 * ------------------------------------------------------------------ */

/** 一个解析引擎的可用状态（字段名是引擎 Go 结构体的 PascalCase，已归一成小驼峰） */
export interface ParserEngineInfo {
  name: string
  description: string
  /** 这个引擎能吃哪些文件后缀 */
  fileTypes: string[]
  available: boolean
  /** 不可用时引擎给的原因（中文提示由前端/路由层翻译，这里只透传） */
  unavailableReason: string
}

/**
 * 归一化引擎列表。
 *
 * ⚠️ 两条接口的形状**不一样**（2026-10-14 实测，都还在用，所以都得认）：
 *   GET  /system/parser-engines → `data` 是以序号为键的对象 `{"0":{…},"1":{…}}`，
 *                                   且 `FileTypes` 也是对象 `{"0":"pdf",…}`
 *   POST /system/parser-engines/check → `data` 是数组，`FileTypes` 是真正的数组
 */
function toEngineList(data: unknown): ParserEngineInfo[] {
  const rows: unknown[] = Array.isArray(data)
    ? data
    : isRecord(data)
      ? Object.values(data).filter(isRecord)
      : []
  const out: ParserEngineInfo[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const name = str(row['Name']) || str(row['name'])
    if (!name) continue
    const rawTypes = row['FileTypes']
    const fileTypes = Array.isArray(rawTypes)
      ? rawTypes.filter((t): t is string => typeof t === 'string')
      : isRecord(rawTypes)
        ? Object.values(rawTypes).filter((t): t is string => typeof t === 'string')
        : []
    out.push({
      name,
      description: str(row['Description']) || str(row['description']),
      fileTypes,
      available: row['Available'] === true || row['available'] === true,
      unavailableReason: str(row['UnavailableReason']) || str(row['unavailableReason'])
    })
  }
  return out
}

/** GET /api/v1/system/parser-engines —— 各解析引擎当前是否可用 */
export async function listParserEngines(timeoutMs = PARSER_TIMEOUT_MS): Promise<ParserEngineInfo[]> {
  const res = await parserFetch('/api/v1/system/parser-engines', {}, timeoutMs)
  if (!res.ok) {
    throw new EngineError('ENGINE_BAD_STATUS', `引擎返回 ${res.status}（列解析引擎）`, 502)
  }
  const payload: unknown = await res.json().catch(() => null)
  return toEngineList(isRecord(payload) ? payload['data'] : null)
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

/** PUT 的请求体：只放**非密钥**的基本类型字段 */
export type ParserConfigPatch = Record<string, ParserPrimitive>

/** 回读校验的一项（老师要看得见「到底哪一项没过」） */
export interface ParserFieldCheck {
  key: string
  label: string
  expected: string
  actual: string
  ok: boolean
}

/** PUT /api/admin/parser-config 的响应体 */
export interface ParserConfigUpdateResult {
  /** 全部校验通过才是 true；false 时 message 与 checks 说清哪一项没生效 */
  success: boolean
  message: string
  /** 本次真正改动过的字段 */
  changed: string[]
  /** 本次**没有提交**的密钥字段（引擎保留原值） */
  keptSecrets: string[]
  /** 本次提交了几个字段（任务单验收第 6 项要比对的就是它） */
  submittedCount: number
  /** 回读到了几个字段 */
  readBackCount: number
  /** 回读时发现「提交了但消失了」的字段（应为空数组；非空说明引擎把它清掉了） */
  missingFields: string[]
  checks: ParserFieldCheck[]
  /** 回读后的公开视图（密钥仍只回 configured） */
  config: ParserConfigView
}

/** GET /api/admin/parser-config 的响应体 */
export interface ParserConfigView {
  success: true
  /** 非密钥字段的原值（引擎有 18 个字段，除密钥外全在这儿） */
  values: ParserPublicValues
  /** 密钥字段的「已配置 / 未配置」，绝不回真值 */
  secrets: Record<string, ParserSecretState>
  /** 各解析引擎当前是否可用 */
  engines: ParserEngineInfo[]
  /** 读配置时引擎连不上（引擎列表取不到）时的原因；接口本身仍 200 */
  enginesError: string
}

/**
 * 校验请求体：字段必须存在于引擎当前配置里、且类型与现状一致。
 *
 * 🔴 为什么要这么严：
 *   · 字段名写错（比如把 `mineru_cloud_langauge` 拼错）→ 引擎收到的是「多一个字段」，
 *     老师会以为改上了，其实没改；
 *   · 类型不对（把 `true` 传成字符串 `"true"`）→ 引擎会**静默忽略**整份配置还是覆盖，
 *     两种行为都让人以为保存成功了。
 */
export function parseParserPatch(current: ParserConfigMap, body: unknown): ParserConfigPatch {
  if (!isRecord(body)) {
    throw new EngineError('INVALID_PARSER_FIELD', '请求体得是一个对象', 400)
  }
  const out: ParserConfigPatch = {}
  const unknownKeys: string[] = []
  for (const [key, value] of Object.entries(body)) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      unknownKeys.push(key)
      continue
    }
    const before = current[key]
    const sameKind =
      typeof before === typeof value &&
      (typeof before !== 'number' || Number.isFinite(value as number))
    if (!sameKind) {
      throw new EngineError(
        'INVALID_PARSER_FIELD',
        `${parserFieldLabel(key)}（${key}）得是 ${typeName(before)}，收到 ${typeName(value)}`,
        400
      )
    }
    out[key] = value as ParserPrimitive
  }
  if (unknownKeys.length > 0) {
    const allowed = Object.keys(current).filter((k) => !isParserSecretField(k))
    throw new EngineError(
      'PARSER_UNKNOWN_FIELD',
      `引擎配置里没有这些字段：${unknownKeys.join('、')}。可改的字段有：${allowed.join('、')}`,
      400
    )
  }
  return out
}

function typeName(value: unknown): string {
  if (typeof value === 'string') return '文本'
  if (typeof value === 'boolean') return '开关（true / false）'
  if (typeof value === 'number') return '数字'
  if (value === null) return '空值'
  return typeof value
}

/**
 * 拼出「要提交的那一份配置」。
 *
 * 🔴 三条硬规则都在这里落地：
 *   1. 以 GET 的全量为底（漏传 = 被清零）；
 *   2. 覆盖本次要改的字段；
 *   3. 密钥字段：用户填了新值才带上，**没填就连字段一起删掉**，
 *      ⛔ 绝不把引擎返回的 `***` 原样写回去。
 *
 * @param current 引擎当前的全量配置
 * @param patch   本次要改的字段
 * @returns 要提交的配置、随之保留的密钥字段、改动过的字段
 */
export function buildSubmitBody(
  current: ParserConfigMap,
  patch: ParserConfigPatch
): { body: ParserConfigMap; keptSecrets: string[]; changed: string[] } {
  const body: ParserConfigMap = { ...current }
  const keptSecrets: string[] = []
  const changed: string[] = []

  for (const [key, value] of Object.entries(patch)) {
    if (value !== current[key]) changed.push(key)
    body[key] = value
  }

  for (const key of Object.keys(body)) {
    if (!isParserSecretField(key)) continue
    const submitted = patch[key]
    if (typeof submitted === 'string' && submitted.trim() !== '') {
      body[key] = submitted // 用户填了新密钥 → 提交新值
      continue
    }
    // 用户没填（或填了空串）→ 不提交这个字段，引擎保留原值。
    // ⛔ 这里绝不能写成 body[key] = current[key]：那会把脱敏的 `***` 写回去，
    //    把真密钥覆盖成 `***`（主控 2026-10-14 实测踩过的坑）。
    delete body[key]
    keptSecrets.push(key)
  }

  return { body, keptSecrets, changed }
}

/** 逐字段比对：期望 = 本次提交的那份，实际 = 回读到的 */
function buildChecks(submitted: ParserConfigMap, actual: ParserConfigMap): ParserFieldCheck[] {
  const checks: ParserFieldCheck[] = []
  for (const [key, expected] of Object.entries(submitted)) {
    const got = actual[key]
    // 字符串按去空白后比（引擎可能 trim），其余按类型比
    const ok =
      typeof expected === 'string' && typeof got === 'string'
        ? expected.trim() === got.trim()
        : expected === got
    checks.push({
      key,
      label: parserFieldLabel(key),
      expected: tokenOf(expected),
      actual: tokenOf(got),
      ok
    })
  }
  return checks
}

/**
 * 写解析引擎配置。**这是本项目唯一允许写这份配置的地方。**
 *
 * 步骤（顺序不可换，见文件头）：GET 全量 → 合并 → PUT 除密钥外全量 → 回读逐字段比对。
 *
 * ⚠️ 校验没过**不抛错**：已经写进去了，抛错等于让前端显示成「保存失败」，
 *    而实际配置可能已经变了。老师需要看到的是「哪一项没生效」——逐项结果原样返回。
 */
export async function updateParserConfig(patch: ParserConfigPatch): Promise<ParserConfigUpdateResult> {
  /* 步骤 1：GET 全量 ---------------------------------------------------- */
  const before = await fetchParserConfigMap()
  const cleanPatch = parseParserPatch(before, patch)

  /* 步骤 2 + 3：合并 → PUT 除密钥外的全部字段 ---------------------------- */
  const { body, keptSecrets, changed } = buildSubmitBody(before, cleanPatch)

  const res = await parserFetch('/api/v1/tenants/kv/parser-engine-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    throw new EngineError(
      'ENGINE_REJECTED_UPDATE',
      `引擎拒绝了这次保存（HTTP ${res.status}），配置**没有**改动。引擎原话：${detail || '(空)'}`,
      502
    )
  }

  /* 步骤 4 + 5：回读 + 逐字段校验 ---------------------------------------- */
  const after = await fetchParserConfigMap()
  const checks = buildChecks(body, after)

  // 「提交了但回读时不见了」= 被引擎清零了（整体替换漏字段的典型后果），单独列出来
  const missingFields = Object.keys(body).filter((key) => !(key in after))
  for (const key of missingFields) {
    checks.push({
      key,
      label: parserFieldLabel(key),
      expected: tokenOf(body[key]),
      actual: '(引擎里没有这个字段)',
      ok: false
    })
  }

  // 密钥：只核对「有没有被这次保存弄丢」（不碰真值）
  for (const key of keptSecrets) {
    const wasConfigured = isConfiguredSecret(before[key])
    const isConfigured = isConfiguredSecret(after[key])
    checks.push({
      key,
      label: `${parserFieldLabel(key)}（密钥，不回显）`,
      expected: wasConfigured ? '保持已配置' : '保持未配置',
      actual: isConfigured ? '已配置' : '未配置',
      ok: wasConfigured === isConfigured
    })
  }

  const failed = checks.filter((c) => !c.ok)
  const message =
    failed.length === 0
      ? changed.length === 0
        ? `已原样写回（一个字没改），${checks.length} 项回读校验全过`
        : `已保存并生效（改了 ${changed.length} 项：${changed.join('、')}），${checks.length} 项回读校验全过`
      : `已写入引擎，但**回读校验没过**（${failed.length}/${checks.length} 项）：` +
        `${failed.map((c) => `${c.label} 期望 ${c.expected}，实际 ${c.actual}`).join('；')}`

  return {
    success: failed.length === 0,
    message,
    changed,
    keptSecrets,
    submittedCount: Object.keys(body).length,
    readBackCount: Object.keys(after).length,
    missingFields,
    checks,
    config: await buildParserView(after)
  }
}

/* ------------------------------------------------------------------ *
 * 测试连接（不保存）
 * ------------------------------------------------------------------ */

/** POST /api/admin/parser-config/check 的响应体 */
export interface ParserCheckResult {
  success: true
  message: string
  /** 各解析引擎按「本次填的内容」实测出来的可用性 */
  engines: ParserEngineInfo[]
  /** 本次是否带了新密钥去测（false = 用引擎里已保存的密钥测） */
  usedPendingSecret: boolean
}

/**
 * 测试连接：**只测不存**。
 *
 * 引擎的 `/system/parser-engines/check` 会按**传入的配置**实测（实测：传一个假 key
 * 回去，它会说「MinerU Cloud API Key 无效」；传空/不传，则沿用引擎里已保存的那份）。
 * 所以这里传「当前全量 + 你这次填的字段」，密钥没填就不带这个字段 ——
 * 这样老师不重敲密钥也能测出「已保存的那把还能不能用」。
 */
export async function checkParserConfig(patch: ParserConfigPatch): Promise<ParserCheckResult> {
  const current = await fetchParserConfigMap()
  const cleanPatch = parseParserPatch(current, patch)
  const { body, keptSecrets } = buildSubmitBody(current, cleanPatch)

  const res = await parserFetch('/api/v1/system/parser-engines/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    throw new EngineError('ENGINE_REJECTED_CHECK', `引擎测不了（HTTP ${res.status}）`, 502)
  }
  const payload: unknown = await res.json().catch(() => null)
  const engines = toEngineList(isRecord(payload) ? payload['data'] : null)
  const usable = engines.filter((e) => e.available).length

  return {
    success: true,
    message: `实测完成：${engines.length} 个解析引擎里有 ${usable} 个可用`,
    engines,
    usedPendingSecret: keptSecrets.length === 0
  }
}

/* ------------------------------------------------------------------ *
 * 读视图
 * ------------------------------------------------------------------ */

/** 组 GET 的响应体：配置视图 + 引擎可用性（引擎取不到也不让整个接口失败） */
export async function buildParserView(map?: ParserConfigMap): Promise<ParserConfigView> {
  const config = map ?? (await fetchParserConfigMap())
  let engines: ParserEngineInfo[] = []
  let enginesError = ''
  try {
    engines = await listParserEngines()
  } catch (err) {
    enginesError = err instanceof EngineError ? err.message : '取解析引擎列表失败'
  }
  const { values, secrets } = toPublicParserConfig(config)
  return { success: true, values, secrets, engines, enginesError }
}

/** GET /api/admin/parser-config */
export async function getParserConfigView(): Promise<ParserConfigView> {
  return buildParserView()
}