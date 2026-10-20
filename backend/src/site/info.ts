/**
 * 站点信息（机构对外口径）—— 2026-10-19 新增
 *
 * 背景：首页「项目简介 → 合作与共建」里的**联系方式 / 邮箱 / 地址**一直是
 * 「待补充」占位 —— 因为这些是基金会的对外口径，未确认前一个字都不许编
 * （见根 AGENTS.md 第 2 条与 AboutView 当年的写作纪律）。
 * 现在把它们做成**老师自己在管理台里填**的字段（管理台「机构信息」页）。
 *
 * 三条约定：
 *   1. key-value 存（表 SiteSetting）：字段会变，加字段不用改表结构。
 *   2. **空串就是不填**：没填的字段照实返回空串，前端继续显示「待补充」，
 *      绝不用默认值把占位替换成看似真实的机构信息。
 *   3. 只认白名单里的 key：多写的字段直接报错，不静默吞掉（错别字要看得见）。
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** 允许公开的字段：key 就是库里的键，max 是长度上限（超了报错，不静默截断） */
export const SITE_INFO_FIELDS = [
  { key: 'contact', label: '联系方式', max: 60, hint: '例如「电话 0551-xxxxxxx」，没有就留空' },
  { key: 'email', label: '邮箱', max: 120, hint: '公开对外邮箱，例如 xx@example.org' },
  { key: 'address', label: '地址', max: 160, hint: '办公地址，没有就留空' },
  { key: 'cooperation', label: '合作与共建说明', max: 300, hint: '面向同行的合作口径，留空则用站点默认文案' },
  { key: 'copyright', label: '页脚版权行', max: 120, hint: '留空则用站点默认版权行' }
] as const

export type SiteInfoKey = (typeof SITE_INFO_FIELDS)[number]['key']
export type SiteInfo = Record<SiteInfoKey, string>

const FIELD_KEYS: readonly string[] = SITE_INFO_FIELDS.map((f) => f.key)
const MAX_BY_KEY = new Map<string, number>(SITE_INFO_FIELDS.map((f) => [f.key, f.max]))

/** 邮箱非空时必须像个邮箱；其余字段只做长度与空白校验 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function emptySiteInfo(): SiteInfo {
  const out = {} as SiteInfo
  for (const f of SITE_INFO_FIELDS) out[f.key] = ''
  return out
}

/**
 * 把控制字符（U+0000–U+001F、U+007F）换成空格，其余原样保留。
 * 逐字符扫描即可 —— 不需要正则，也避开 eslint `no-control-regex`。
 */
function stripControlChars(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return out
}

/** 读全部字段；没写过的返回空串 */
export async function readSiteInfo(): Promise<SiteInfo> {
  const rows = await prisma.siteSetting.findMany()
  const info = emptySiteInfo()
  for (const row of rows) {
    if (FIELD_KEYS.includes(row.key)) info[row.key as SiteInfoKey] = row.value
  }
  return info
}

export type SiteInfoWriteResult =
  | { ok: true; info: SiteInfo; changed: SiteInfoKey[] }
  | { ok: false; code: 'BAD_PATCH' | 'BAD_FIELD' | 'BAD_VALUE'; message: string }

/**
 * 写字段（只写传进来的那些，其余原样保留）。
 * 传空串 = 清空该字段（删行，不留空记录）。
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
    if (typeof raw !== 'string') {
      return { ok: false, code: 'BAD_VALUE', message: `字段 ${key} 必须是字符串` }
    }
    // 去掉首尾空白与控制字符（老师从 Word 里粘过来的内容常带不可见字符）。
    // 用逐字符判断而不是正则：eslint 的 no-control-regex 会拦下 [\u0000-\u001f] 这种写法，
    // 而这里本来也不需要正则表达式的匹配能力。
    const value = stripControlChars(raw).trim()
    const max = MAX_BY_KEY.get(key) ?? 0
    if (value.length > max) {
      return { ok: false, code: 'BAD_VALUE', message: `字段 ${key} 最多 ${max} 个字，当前 ${value.length} 个` }
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
