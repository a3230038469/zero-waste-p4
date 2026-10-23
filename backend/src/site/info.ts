/**
 * 站点信息（机构对外口径）—— 2026-10-19 新增，2026-10-22 扩展
 *
 * 背景：首页「项目简介 / 关于基金会 / 引用与转载」这些文案原来写死在前端，
 * 基金会老师希望能自己在管理台改。2026-10-22 起统一收进这里：
 *   - 联系方式 / 邮箱 / 地址 / 合作说明 / 版权行（2026-10-19 那 5 项，行为不变）
 *   - 首页「项目简介」正文
 *   - 首页「关于基金会」条目（小标题 + 正文，可增删排序）
 *   - 首页「引用与转载」正文 + 规则（规则可增删）
 *
 * 三条约定：
 *   1. key-value 存（表 SiteSetting）：字段会变，加字段不用改表结构。
 *      **数组字段存成 JSON 字符串**，读的时候解析失败一律当空数组（绝不把首页打挂）。
 *   2. **空就是不填**：没填的字段照实返回空值，前端回退到 `constants/site-defaults.ts`
 *      里的默认文案（联系方式这类对外口径仍显示「待补充」，不编内容）。
 *   3. 只认白名单里的 key：多写的字段直接报错，不静默吞掉（错别字要看得见）。
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** 字段类型：决定管理台渲染成单行 / 多行 / 条目编辑器 / 规则编辑器 */
export type SiteFieldKind = 'text' | 'longtext' | 'entries' | 'rules'

/** 「关于基金会」的一条：小标题 + 正文 */
export interface FoundationItem {
  title: string
  body: string
  /** 首页用浅绿底强调这一条（原来的「机构宗旨」就是这种样式） */
  emphasis?: boolean
}

/**
 * 允许公开的字段。
 *
 * max 的含义按 kind 分：
 *   - text / longtext：字数上限
 *   - entries：条目数上限（titleMax / bodyMax 是单条小标题与正文的上限）
 *   - rules：规则条数上限（itemMax 是单条规则的字数上限）
 */
export const SITE_INFO_FIELDS = [
  { key: 'contact', label: '联系方式', kind: 'text', max: 60, hint: '例如「电话 0551-xxxxxxx」，没有就留空' },
  { key: 'email', label: '邮箱', kind: 'text', max: 120, hint: '公开对外邮箱，例如 xx@example.org' },
  { key: 'address', label: '地址', kind: 'text', max: 160, hint: '办公地址，没有就留空' },
  { key: 'cooperation', label: '合作与共建说明', kind: 'text', max: 300, hint: '面向同行的合作口径，留空则用站点默认文案' },
  { key: 'copyright', label: '页脚版权行', kind: 'text', max: 120, hint: '留空则用站点默认版权行' },
  {
    key: 'introBody',
    label: '首页「项目简介」正文',
    kind: 'longtext',
    max: 1000,
    hint: '空一行 = 分一段；留空则用站点默认文案'
  },
  {
    key: 'foundationItems',
    label: '首页「关于基金会」条目',
    kind: 'entries',
    max: 8,
    titleMax: 40,
    bodyMax: 600,
    hint: '每条 = 小标题 + 正文，最多 8 条；留空则用站点默认的 4 条'
  },
  {
    key: 'citeIntro',
    label: '首页「引用与转载」正文',
    kind: 'longtext',
    max: 600,
    hint: '留空则用站点默认文案；用 **两个星号** 包住的字会加粗'
  },
  {
    key: 'citeRules',
    label: '首页「引用与转载」规则',
    kind: 'rules',
    max: 12,
    itemMax: 200,
    hint: '每条最多 200 字，最多 12 条；留空则用站点默认的 4 条'
  }
] as const

export type SiteInfoKey = (typeof SITE_INFO_FIELDS)[number]['key']

/** 对外返回的站点信息（数组字段已解析成结构，不是 JSON 字符串） */
export interface SiteInfo {
  contact: string
  email: string
  address: string
  cooperation: string
  copyright: string
  introBody: string
  foundationItems: FoundationItem[]
  citeIntro: string
  citeRules: string[]
}

const FIELD_KEYS: readonly string[] = SITE_INFO_FIELDS.map((f) => f.key)
const FIELD_BY_KEY = new Map<string, (typeof SITE_INFO_FIELDS)[number]>(
  SITE_INFO_FIELDS.map((f) => [f.key, f])
)

/** 邮箱非空时必须像个邮箱；其余字段只做长度与空白校验 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 读的时候也做一层防御：手改过库 / 老数据脏了，最多只取这么多条 */
const MAX_ENTRIES = 8
const MAX_RULES = 12

export function emptySiteInfo(): SiteInfo {
  return {
    contact: '',
    email: '',
    address: '',
    cooperation: '',
    copyright: '',
    introBody: '',
    foundationItems: [],
    citeIntro: '',
    citeRules: []
  }
}

/**
 * 把控制字符（U+0000–U+001F、U+007F）换成空格，**但保留换行**。
 *
 * 🔴 2026-10-22 修：以前这里把所有控制字符（含 \n）都换成空格，
 *    多行正文（项目简介「空一行分一段」、条目正文「每行一条」）会被压成一行。
 *    现在先把 CRLF / CR 统一成 LF，再清洗其余控制字符。
 */
function stripControlChars(input: string): string {
  const normalized = input.replace(/\r\n?/g, '\n')
  let out = ''
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x0a) {
      out += '\n'
      continue
    }
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return out
}

/** 多行文本：保留换行，去掉首尾空白 */
function cleanText(input: string): string {
  return stripControlChars(input).trim()
}

/** 单行文本（联系方式、小标题、规则这类）：换行压成空格 */
function cleanSingleLine(input: string): string {
  return cleanText(input).replace(/\s*\n+\s*/g, ' ')
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 解析库里存的 JSON 数组；坏了就当空数组（首页不能因为一条脏数据打不开） */
function parseArray(raw: string): unknown[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 库里的 JSON → 干净的条目数组（字段缺失 / 类型不对的条目直接丢掉） */
function toFoundationItems(raw: string): FoundationItem[] {
  const out: FoundationItem[] = []
  for (const entry of parseArray(raw)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const obj = entry as Record<string, unknown>
    const title = cleanSingleLine(readString(obj['title']))
    const body = cleanText(readString(obj['body']))
    if (!title && !body) continue
    out.push({
      title,
      body,
      ...(obj['emphasis'] === true ? { emphasis: true } : {})
    })
    if (out.length >= MAX_ENTRIES) break
  }
  return out
}

/** 库里的 JSON → 干净的规则数组 */
function toCiteRules(raw: string): string[] {
  const out: string[] = []
  for (const entry of parseArray(raw)) {
    if (typeof entry !== 'string') continue
    const text = cleanSingleLine(entry)
    if (!text) continue
    out.push(text)
    if (out.length >= MAX_RULES) break
  }
  return out
}

/** 读全部字段；没写过的返回空值 */
export async function readSiteInfo(): Promise<SiteInfo> {
  const rows = await prisma.siteSetting.findMany()
  const map = new Map<string, string>()
  for (const row of rows) {
    if (FIELD_KEYS.includes(row.key)) map.set(row.key, row.value)
  }
  const info = emptySiteInfo()
  info.contact = cleanSingleLine(map.get('contact') ?? '')
  info.email = cleanSingleLine(map.get('email') ?? '')
  info.address = cleanSingleLine(map.get('address') ?? '')
  info.cooperation = cleanSingleLine(map.get('cooperation') ?? '')
  info.copyright = cleanSingleLine(map.get('copyright') ?? '')
  info.introBody = cleanText(map.get('introBody') ?? '')
  info.citeIntro = cleanText(map.get('citeIntro') ?? '')
  info.foundationItems = toFoundationItems(map.get('foundationItems') ?? '')
  info.citeRules = toCiteRules(map.get('citeRules') ?? '')
  return info
}

export type SiteInfoWriteResult =
  | { ok: true; info: SiteInfo; changed: SiteInfoKey[] }
  | { ok: false; code: 'BAD_PATCH' | 'BAD_FIELD' | 'BAD_VALUE'; message: string }

function badValue(message: string): { ok: false; code: 'BAD_VALUE'; message: string } {
  return { ok: false, code: 'BAD_VALUE', message }
}

/**
 * 条目数组的校验：逐条 trim、丢掉全空的条目、超长 / 超量直接报错（不静默截断）。
 * 返回序列化后的字符串（空数组 → 空串，等于清空这个字段）。
 */
function normalizeEntries(
  raw: unknown
): { ok: true; value: string } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: '「关于基金会」必须是条目数组' }
  const field = FIELD_BY_KEY.get('foundationItems')
  const maxItems = field && 'max' in field ? field.max : MAX_ENTRIES
  const titleMax = field && 'titleMax' in field ? field.titleMax : 40
  const bodyMax = field && 'bodyMax' in field ? field.bodyMax : 600
  if (raw.length > maxItems) {
    return { ok: false, message: `「关于基金会」最多 ${maxItems} 条，当前 ${raw.length} 条` }
  }
  const items: FoundationItem[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, message: `「关于基金会」第 ${i + 1} 条格式不对` }
    }
    const obj = entry as Record<string, unknown>
    const title = cleanSingleLine(readString(obj['title']))
    const body = cleanText(readString(obj['body']))
    if (title.length > titleMax) {
      return { ok: false, message: `「关于基金会」第 ${i + 1} 条的小标题最多 ${titleMax} 个字` }
    }
    if (body.length > bodyMax) {
      return { ok: false, message: `「关于基金会」第 ${i + 1} 条的正文最多 ${bodyMax} 个字` }
    }
    if (!title && !body) continue // 全空 = 老师还没填，直接跳过
    items.push({
      title,
      body,
      ...(obj['emphasis'] === true ? { emphasis: true } : {})
    })
  }
  return { ok: true, value: items.length ? JSON.stringify(items) : '' }
}

/** 规则数组的校验：同上 */
function normalizeRules(
  raw: unknown
): { ok: true; value: string } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: '「引用与转载」规则必须是字符串数组' }
  const field = FIELD_BY_KEY.get('citeRules')
  const maxItems = field && 'max' in field ? field.max : MAX_RULES
  const itemMax = field && 'itemMax' in field ? field.itemMax : 200
  if (raw.length > maxItems) {
    return { ok: false, message: `「引用与转载」最多 ${maxItems} 条规则，当前 ${raw.length} 条` }
  }
  const rules: string[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i]
    if (typeof entry !== 'string') {
      return { ok: false, message: `「引用与转载」第 ${i + 1} 条必须是文字` }
    }
    const text = cleanSingleLine(entry)
    if (text.length > itemMax) {
      return { ok: false, message: `「引用与转载」第 ${i + 1} 条最多 ${itemMax} 个字` }
    }
    if (!text) continue
    rules.push(text)
  }
  return { ok: true, value: rules.length ? JSON.stringify(rules) : '' }
}

/**
 * 写字段（只写传进来的那些，其余原样保留）。
 * 传空串 / 空数组 = 清空该字段（删行，不留空记录）。
 */
export async function writeSiteInfo(patch: unknown): Promise<SiteInfoWriteResult> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, code: 'BAD_PATCH', message: '请求体必须是一个对象' }
  }
  const entries = Object.entries(patch as Record<string, unknown>)
  if (!entries.length) {
    return { ok: false, code: 'BAD_PATCH', message: '没有要修改的字段' }
  }
  const unknownKeys = entries.map(([k]) => k).filter((k) => !FIELD_KEYS.includes(k))
  if (unknownKeys.length) {
    return {
      ok: false,
      code: 'BAD_FIELD',
      message: `不认识的字段：${unknownKeys.join('、')}（可用：${FIELD_KEYS.join('、')}）`
    }
  }

  const cleaned = new Map<SiteInfoKey, string>()
  for (const [key, raw] of entries) {
    const field = FIELD_BY_KEY.get(key)
    if (!field) continue

    if (field.kind === 'entries') {
      const result = normalizeEntries(raw)
      if (!result.ok) return badValue(result.message)
      cleaned.set(key as SiteInfoKey, result.value)
      continue
    }
    if (field.kind === 'rules') {
      const result = normalizeRules(raw)
      if (!result.ok) return badValue(result.message)
      cleaned.set(key as SiteInfoKey, result.value)
      continue
    }

    if (typeof raw !== 'string') {
      return { ok: false, code: 'BAD_VALUE', message: `字段 ${key} 必须是字符串` }
    }
    // 去掉首尾空白与控制字符（老师从 Word 里粘过来的内容常带不可见字符）。
    // text 是单行字段（换行压成空格）；longtext 保留换行（「空一行分一段」靠它）。
    const value = field.kind === 'text' ? cleanSingleLine(raw) : cleanText(raw)
    const max = field.max
    if (value.length > max) {
      return {
        ok: false,
        code: 'BAD_VALUE',
        message: `字段 ${key} 最多 ${max} 个字，当前 ${value.length} 个`
      }
    }
    if (key === 'email' && value && !EMAIL_RE.test(value)) {
      return { ok: false, code: 'BAD_VALUE', message: '邮箱格式看起来不对（要形如 name@example.org）' }
    }
    cleaned.set(key as SiteInfoKey, value)
  }

  const changed: SiteInfoKey[] = []
  for (const [key, value] of cleaned) {
    if (value) {
      await prisma.siteSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value }
      })
    } else {
      // 清空 = 删行；deleteMany 不会因为「本来就没有」而报错
      await prisma.siteSetting.deleteMany({ where: { key } })
    }
    changed.push(key)
  }

  return { ok: true, info: await readSiteInfo(), changed }
}
