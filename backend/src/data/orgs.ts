/**
 * 机构名归一 · 联合发文拆分 · 机构筛选器 —— T8 负责人：韶茹
 *
 * 为什么单独一个文件：书架筛选器（routes/docs.ts）与单元自查都要用这套规则，
 * 混在路由文件里既难读也难单独跑。本文件**纯函数、无 IO、不 import 任何服务**。
 *
 * ── 老库（603 份）实测出来的三件事 ─────────────────────────────────────
 *   1. 机构下拉原来全列 **371** 个原始值，其中 296 个只对应 1 份资料 —— 等于废掉。
 *   2. 266 份资料的 org 值里塞了**多家机构**（占 44%），分隔符**不止顿号**：
 *      顿号 123 个值、普通空格 91 个、换行 10 个、\xa0 不换行空格 1 个（4 份）、
 *      `+` 2 个、半角逗号 3 个。所以「按顿号切」会漏掉一半以上。
 *   3. 同一家机构有多种写法（UNEP / 联合国环境规划署，发改委四条写法…），
 *      不归一就会在下拉里出现多个几乎一样的选项。
 *
 * ── 本文件的三个口径（都不改数据，只改显示与筛选）────────────────────
 *   · 默认下拉只列**单机构**且出现 ≥2 次的值（实测 41 个 + 1 条联合发文汇总 = 42 项）；
 *   · 联合发文的长串**不单独列**，改为 `A + B 等N家` 的短标签（搜索命中时显示）；
 *   · 别名归一：筛选与计数都按主名走，原始数据一个字不动。
 */
import type { FacetItem } from '../weknora/types.js'

/**
 * 联合发文（一个 org 值里有多家机构）在筛选器里的统一入口。
 *
 * 为什么要有一个入口：老库里 266 份资料是多家机构联合署名，占比 44%。
 * 单机构下拉里永远列不到它们，选任何一家机构都筛不出这些资料 ——
 * 把「联合发文」做成一条可选项，这些资料才**点得到**（否则等于筛选器漏了 44% 的库）。
 */
export const JOINT_ORG_VALUE = '__joint__'

/** 联合发文那一条的显示名 */
export const JOINT_ORG_LABEL = '联合发文（多家机构联合署名）'

/** 默认下拉的机构门槛：出现 ≥2 次才列（只出现 1 次的那 296 个靠搜索框找） */
export const ORG_MIN_COUNT = 2

/** 机构搜索一次最多回几条（契约要求上限 20） */
export const ORG_SEARCH_LIMIT = 20

/**
 * 「所属方向」显示名：数据里的 `srcTable` 值 → 对外中文名。
 *
 * ⚠️ 只影响显示。筛选参数仍传数据原值（`知识查询（零废弃）`），保证「下拉标的数字」
 * 与「选中后筛出来的条数」永远一致（接口约定第二节的硬要求）。
 */
export const SRC_TABLE_LABELS: Readonly<Record<string, string>> = {
  '知识查询（零废弃）': '零废弃',
  '知识查询（化学品）': '化学品与健康'
}

/** 方向的展示名（没有专门映射就用原值，绝不显示空） */
export function srcTableLabel(value: string): string {
  return SRC_TABLE_LABELS[value] ?? value
}

/**
 * 别名归一表：**只归一显示与筛选口径，不改任何数据**。
 *
 * 🔴 `环境保护部` / `生态环境部` **故意不合并**：2018 年机构改名，历史文件用旧名是事实，
 *    合并反而失真（任务单第二节 1️⃣ 明确要求）。
 * ⚠️ 任务单列出的等价写法之外，这里按**老库实测的同一家机构的其它写法**补齐了两条
 *    （不补的话下拉里会并排出现四个几乎一样的选项，正是这次要修的毛病）：
 *      · `发展改革委`（6 份，联合发文串里大量使用这个写法）
 *      · `国家发展改革委`（2 份，独立出现）
 */
const ORG_ALIASES = new Map<string, string>([
  ['UNEP', '联合国环境规划署'],
  ['WWF', '世界自然基金会'],
  ['国家发改委', '国家发展和改革委员会'],
  ['发改委', '国家发展和改革委员会'],
  ['发展改革委', '国家发展和改革委员会'],
  ['国家发展改革委', '国家发展和改革委员会'],
  ['市场监管总局', '国家市场监督管理总局']
])

/**
 * 把所有 Unicode 空白压成普通空格。
 *
 * 🔴 必须显式处理 `\xa0`（不换行空格）与 `\u3000`（全角空格）：任务单要求
 *    「JS 里 `\s` 默认不含 `\xa0`，要用 `\p{Zs}` 或显式加」。
 *    老库实测有 1 个值带 `\xa0`、10 个值带换行，不压平就切不开。
 */
export function normalizeOrgWhitespace(raw: string): string {
  return raw
    .replace(/\p{Zs}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * 按 5 种分隔符拆出机构名：`、` / `,`（半角逗号）/ `+` / 普通空格 / 其它 Unicode 空白（含 \n、\xa0）。
 *
 * ⚠️ 先压平空白再切，所以换行与 `\xa0` 会被 `\s+` 一并吃掉；连续分隔符（如「、 」）只算一次。
 * ⚠️ 已知副作用：英文机构名（如 `Organisation for Economic Co-operation and Development`）
 *    会被空格切碎 —— 上游数据本身就是「多家机构用空格并排」，无法两全。
 *    这类碎片的出现次数都很低（1–4 份），进不了 ≥2 次的默认下拉；
 *    搜索框里仍能按原串搜到（搜索是包含匹配，且会把每一段的别名写法一并纳入）。
 *    这条已写进交付说明的「未改问题」。
 */
export function splitOrgNames(raw: string): string[] {
  return normalizeOrgWhitespace(raw)
    .split(/[、,+]+|\s+/u)
    .map((part) => part.trim())
    .filter(Boolean)
}

/** 只由标点 / 符号组成的碎片（如 `A / B` 里被空格切出来的那个 `/`）——不是机构名 */
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u

/**
 * 一个 org 值的**机构片段**：按 5 种分隔符切开，丢掉纯标点碎片，并按原顺序去重。
 *
 * 为什么要丢掉 `/` 这种碎片：老库真实值是 `巴塞尔公约秘书处 / UNEP`，
 * 按空格切会多出一个孤零零的 `/`。它显然不是机构名，留着只会让短标签长成
 * `巴塞尔公约秘书处 + / 等3家`（对外展示站上很难看）。
 * ⚠️ 这**不是**新增分隔符：`/` 只是被当成噪声丢掉，`A/B`（无空格）这种整串仍是单个机构。
 */
export function orgParts(raw: string): string[] {
  const out: string[] = []
  for (const part of splitOrgNames(raw)) {
    if (PUNCTUATION_ONLY.test(part)) continue
    if (!out.includes(part)) out.push(part)
  }
  return out
}

/** 一个 org 值里是否塞了多家机构（= 联合发文） */
export function isJointOrg(raw: string): boolean {
  return orgParts(raw).length > 1
}

/** 单机构值的别名归一（联合发文串请用 `orgKey()` 或 `orgParts()`，别拿整串查表） */
export function canonicalOrgName(raw: string): string {
  const name = normalizeOrgWhitespace(raw)
  return ORG_ALIASES.get(name) ?? name
}

/**
 * 筛选 / 计数用的键。
 *
 *   单机构 → 主名（UNEP 与 联合国环境规划署 归成同一个键，计数合并且互筛得到）
 *   联合发文 → **逐段归一后用 ` + ` 拼回来**（`财政部 + 国家发展和改革委员会 + 国家能源局`）
 *
 * 为什么联合发文也要逐段归一：同一个组合在数据里有不同写法（顿号 / 空格 / 换行 / 别名的
 * 各种拼法），逐段归一后它们才会落成**同一个键**，下拉与搜索里不会并排出现三条几乎一样的
 * 长串。这个函数是**幂等**的：拿它自己的输出再算一次，结果不变 —— 所以「选它 → 传回来 →
 * 再算一遍」始终落在同一个键上。
 *
 * 查询参数也用这个函数归一，所以「下拉里选的」与「资料里的」永远落在同一套键上。
 */
export function orgKey(raw: string): string {
  const parts = orgParts(raw)
  if (parts.length === 0) return ''
  if (parts.length === 1) return ORG_ALIASES.get(parts[0] ?? '') ?? parts[0] ?? ''
  return parts.map((part) => ORG_ALIASES.get(part) ?? part).join(' + ')
}

/** 联合发文串的短标签：`A + B` / `A + B 等N家`（最多列 2 个，N = 实际有几家） */
export function abbreviateJointOrg(raw: string): string {
  const parts = orgParts(raw)
  if (parts.length === 0) return normalizeOrgWhitespace(raw)
  if (parts.length === 1) return parts[0] ?? ''
  const head = parts.slice(0, 2).map((part) => ORG_ALIASES.get(part) ?? part).join(' + ')
  return parts.length > 2 ? `${head} 等${parts.length}家` : head
}

/** 主名 + 它的全部等价写法（搜索时要能从任一写法命中主名） */
function aliasSpellings(canonical: string): string[] {
  const out: string[] = [canonical]
  for (const [alias, main] of ORG_ALIASES) {
    if (main === canonical) out.push(alias)
  }
  return out
}

/**
 * 归一后转小写（`orgLike` 的包含比对专用）。
 *
 * 🔴 为什么还要再转小写：老库里有 `UNEP` / `WWF` 这类大写写法，
 *    用户输入 `unep` 也应该命中 —— 「大小写不敏感」是任务单的硬要求。
 */
function foldOrgText(raw: string): string {
  return normalizeOrgWhitespace(raw).toLowerCase()
}

/**
 * 「机构名包含这个关键词」（T10 书架机构改成文本式检索的判定口径）。
 *
 * 与下拉的精确匹配（`orgKey()` 全等）是**两套语义**，刻意并存：
 *   · 下拉选一项 = 「机构恰好是这一家」（数字与筛出来的条数严格相等，接口约定的硬要求）；
 *   · 这里输关键词 = 「机构名里含这个词」（老库 371 个机构值里 296 个只出现一次，
 *     全列等于废掉；改成文本式之后，一次输入就能把所有含该词的资料都列出来）。
 *
 * 两侧都先做 Unicode 空白归一（`\xa0` / `\u3000` → 普通空格）再转小写：
 * 老库实测有机构名里带 `\xa0`（如「中国家用电器研究院\xa0生产者责任延伸…」），
 * 不归一的话用户敲普通空格就搜不到（任务单第二节 2.3 明确要求）。
 *
 * 关键词为空 = 「不按机构过滤」，返回 true。
 */
export function matchesOrgLike(raw: string, keyword: string): boolean {
  const needle = foldOrgText(keyword)
  if (!needle) return true
  return foldOrgText(raw).includes(needle)
}

/** 数量从多到少；数量相同按字面序（与 routes/docs.ts 的排序口径一致） */
function byCountThenValue(a: FacetItem, b: FacetItem): number {
  return b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN')
}

/**
 * 默认机构下拉：只列**单机构**且出现 ≥ 2 次的值 + 一条「联合发文」汇总。
 *
 * 计数口径（与筛选严格对齐）：
 *   · 单机构项的 count = org 归一后**恰好等于**这个键的资料数（联合发文串不计入，
 *     否则「下拉标的数字」会大于「选中后筛出来的条数」，违反接口约定）；
 *   · 联合发文项的 count = org 里含 ≥2 家机构的资料数。
 */
export function buildOrgFacets(docs: readonly { org: string }[], minCount = ORG_MIN_COUNT): FacetItem[] {
  const counter = new Map<string, number>()
  let jointDocs = 0
  for (const doc of docs) {
    const raw = doc.org
    if (!raw) continue
    if (isJointOrg(raw)) {
      jointDocs += 1
      continue
    }
    const key = orgKey(raw)
    if (!key) continue
    counter.set(key, (counter.get(key) ?? 0) + 1)
  }

  const items: FacetItem[] = [...counter.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([value, count]) => ({ value, count }))
  if (jointDocs > 0) {
    items.push({ value: JOINT_ORG_VALUE, count: jointDocs, label: JOINT_ORG_LABEL })
  }
  return items.sort(byCountThenValue)
}

/**
 * 机构搜索（`GET /api/docs/facets?orgSearch=关键字`）：把**全部**机构值都放进搜索池。
 *
 * 为什么不能只搜默认下拉那 41 个：老库里有 296 个机构值只出现 1 次，它们上不了默认下拉，
 * 但用户找资料时恰恰可能指名道姓要某一家（任务单第二节 1️⃣ 的硬要求）。
 *
 * 匹配规则：大小写不敏感的**包含**匹配；单机构值会把别名写法一并纳入
 * （所以输入「发改委」能命中「国家发展和改革委员会」）；联合发文**按其中每一家机构**匹配
 * （输入「发改委」也能命中「财政部 + 国家发展和改革委员会 + 国家能源局」），
 * 命中时显示**短标签**（`A + B 等N家`）而不是那一长串。
 */
export function searchOrgFacets(
  docs: readonly { org: string }[],
  keyword: string,
  limit = ORG_SEARCH_LIMIT
): FacetItem[] {
  const query = normalizeOrgWhitespace(keyword).toLowerCase()
  if (!query) return []

  const counter = new Map<string, number>()
  for (const doc of docs) {
    const key = orgKey(doc.org)
    if (!key) continue
    counter.set(key, (counter.get(key) ?? 0) + 1)
  }

  const hits: FacetItem[] = []
  for (const [value, count] of counter) {
    const joint = isJointOrg(value)
    const haystacks = joint
      ? [value, ...orgParts(value).flatMap((part) => aliasSpellings(part))]
      : aliasSpellings(value)
    const matched = haystacks.some((text) => normalizeOrgWhitespace(text).toLowerCase().includes(query))
    if (!matched) continue
    hits.push(joint ? { value, count, label: abbreviateJointOrg(value) } : { value, count })
  }
  return hits.sort(byCountThenValue).slice(0, limit)
}
