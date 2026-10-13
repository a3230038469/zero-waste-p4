/**
 * 智能体问答 · SSE 适配层（T7）—— 负责人：韶茹
 *
 * 存在的唯一理由：**前端的问答组件一个字都不许改**（任务单 4.4 / 六.3）。
 * 所以本文件把引擎 `agent-chat` 的 `response_type` 事件，翻译成现有链路认得的形状。
 *
 * ── 引擎 agent-chat 的事件构成（2026-10-13 真机实测，一次问答 246KB / 2745 行）──
 *
 *   response_type   条数    内容                        本文件的处理
 *   ──────────────────────────────────────────────────────────────────────
 *   agent_query       1     首帧（含 session/message id）  计数，不转发
 *   thinking        791     思考过程逐字推                🔴 **丢弃**（只计数）
 *   tool_call          2     Calling tool: …              丢弃（只计数）
 *   tool_result        2     工具结果（含 count/doc_count）丢弃（只计数）
 *   references         1     **一条事件带全部引用**        ✅ 转成 sources
 *   answer           117     答案逐字推（content 字段）    ✅ 原样转发
 *   complete           1     结束                         ✅ 用它判定结束
 *
 * ── T8：来源卡片上的机构 / 年份从哪来 ─────────────────────────────────
 *   `references` 事件里有两个引用数组，**读 `data.references`**（顶层少 2 个字段）：
 *   它带 `knowledge_custom_metadata`（YAML 风格字符串，直接写着 org / year / type / srcTable）。
 *   解析见 parseCustomMetadata()；读不到才退回书架清单本地关联（老路保留做兜底）。
 *
 * ── 为什么丢弃 thinking（任务单 3.4 的决定）──
 *   一次问答里 791 条 thinking 占了 246KB 的绝大部分。现有前端没有「思考过程」展示区，
 *   硬转发会变成一大坨文字、把流量吃干。但**不能静默丢掉** —— 所以这里**逐类计数**，
 *   流结束时打一行日志（`thinking=791 tool_call=2 …`），老师报「为什么慢」时一查就有。
 *   将来要加「可折叠思考区」，只需要在本文件把 thinking 分支改成 yield 一行即可。
 *
 * ── 事件时序（实测）──
 *   agent_query → tool_call×2 → tool_result×2 → **references** → thinking/answer… → complete
 *   `references` 落在**正文之前**，不是分段推。消费方按「赋值覆盖」渲染，先来后到都一样。
 */
import type { AskEvent } from './types.js'

/** 一次问答的事件计数（流结束时打日志用） */
export interface AgentSseCounters {
  total: number
  agentQuery: number
  thinking: number
  toolCall: number
  toolResult: number
  answer: number
  references: number
  other: number
}

/** 来源卡片的一条。
 *
 * ⚠️ 契约里前端只认 `{name, url}`；`org/year/type/kbId` 是**多带的下游字段**
 *    （接口约定「sources 事件的 items[]」一节，全部可选）。
 *    T8 起卡片上会显示 `机构 / 年份`（frontend ChatBubble.vue），
 *    数据来源：优先引用自带的 `knowledge_custom_metadata`，兜底走书架清单本地关联。
 */
export interface AgentSource {
  /** 站内详情页地址 /doc/<id> */
  url: string
  /** 展示用资料名 */
  name: string
  /** 引擎侧的知识库编号（关联库 = readonly.knowledge_bases） */
  kbId: string
  /** 发布机构：优先引用自带元数据，其次书架清单本地关联；都取不到时是空串 */
  org: string
  year: string
  type: string
}

/** 一条「可用于本地关联的资料信息」——由 index.ts 用 listFiles() 的结果提供 */
export interface AgentSourceDoc {
  id: string
  title: string
  fileName: string
  org: string
  year: number
  type: string
}

/** 由 index.ts 注入的资料查询（避免本文件反向 import index.ts 形成循环依赖） */
export type ResolveAgentDoc = (knowledgeId: string) => Promise<AgentSourceDoc | null>

/** 新建一组计数器 */
export function createAgentCounters(): AgentSseCounters {
  return {
    total: 0,
    agentQuery: 0,
    thinking: 0,
    toolCall: 0,
    toolResult: 0,
    answer: 0,
    references: 0,
    other: 0
  }
}

/** 来源卡片最多几条（与既有 knowledge-chat 链路的 MAX_SOURCES 保持一致） */
const MAX_SOURCES = 5

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/** 引擎 references 事件里的一条引用（2026-10-13 实测字段名） */
interface EngineReference {
  knowledgeId: string
  knowledgeTitle: string
  knowledgeBaseId: string
  /** 引用自带的业务元数据（org / year / type / srcTable），读不到时是空表 */
  meta: Record<string, string>
}

/** 从引擎 references 事件的 raw 里抽出引用列表（脏数据只丢那一条，不整条事件作废） */
function readEngineReferences(evt: AskEvent): EngineReference[] {
  const list = pickReferenceList(evt.raw)
  const out: EngineReference[] = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const knowledgeId = readString(entry, 'knowledge_id') || readString(entry, 'id')
    if (!knowledgeId) continue
    out.push({
      knowledgeId,
      knowledgeTitle:
        readString(entry, 'knowledge_title') ||
        readString(entry, 'knowledge_filename') ||
        readString(entry, 'title'),
      knowledgeBaseId: readString(entry, 'knowledge_base_id'),
      meta: readReferenceMeta(entry)
    })
  }
  return out
}

/**
 * 挑出引用数组：**优先 `data.references`**。
 *
 * 🔴 同一条 references 事件里有两个引用数组，内容不一样（2026-10-13 对方用 12 份原始响应实测）：
 *
 *   | 字段 | 字段数 | 有没有 knowledge_custom_metadata |
 *   |---|---|---|
 *   | 顶层 `knowledge_references` | 21 | ❌ 没有 |
 *   | `data.references`           | 23 | ✅ 有（另有 chunk_metadata / matched_content）|
 *
 * 读顶层就永远拿不到机构/年份 —— 这正是当初「断言引用里没有元数据、必须反查」的由来。
 * 顶层保留作兜底：引擎万一不推 `data.references`（字段只在文档有 custom_metadata 时才出现），
 * 至少还能拿到 knowledge_id，继续走书架清单本地关联那条老路。
 */
function pickReferenceList(raw: Record<string, unknown>): unknown[] {
  const data = raw['data']
  if (isRecord(data)) {
    const nested = data['references']
    if (Array.isArray(nested) && nested.length > 0) return nested
  }
  const top = raw['knowledge_references']
  return Array.isArray(top) ? top : []
}

/**
 * 解析引擎引用的业务元数据。
 *
 * 🔴 格式是「YAML 风格字符串」，不是 JSON 对象：
 *
 * ```
 * org: 宁波市商务局
 * srcTable: 知识查询（零废弃）
 * tags: 垃圾分类
 * type: 政策法规
 * year: 2020
 * ```
 *
 * ⚠️ **值里可能带冒号**，所以只能按「第一个 `: `（冒号 **加空格**）」切，不能按第一个冒号切一刀。
 *    行内没有「: 」的一律跳过（宁可少一项，也不猜一个脏值出来）。
 * ⚠️ 老实测也有把整个对象直接塞进来的情况，所以对象形状也认（防御性）。
 */
export function parseCustomMetadata(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const sep = line.indexOf(': ')
    if (sep <= 0) continue
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 2).trim()
    if (key && value) out[key] = value
  }
  return out
}

/** 把引用里的 `knowledge_custom_metadata`（字符串或对象）读成一张平表 */
function readReferenceMeta(entry: Record<string, unknown>): Record<string, string> {
  const rawMeta = entry['knowledge_custom_metadata']
  if (typeof rawMeta === 'string' && rawMeta.trim()) return parseCustomMetadata(rawMeta)
  if (isRecord(rawMeta)) {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawMeta)) {
      if (typeof value === 'string' && value.trim()) out[key] = value.trim()
      else if (typeof value === 'number' && Number.isFinite(value)) out[key] = String(value)
    }
    return out
  }
  return {}
}

/** 来源卡片的条数上限在适配层也卡一道（引擎将来若一次给 50 条，不给前端 50 张卡） */
function limitSources(items: AgentSource[]): AgentSource[] {
  const seen = new Set<string>()
  const out: AgentSource[] = []
  for (const item of items) {
    if (out.length >= MAX_SOURCES) break
    if (seen.has(item.url)) continue
    seen.add(item.url)
    out.push(item)
  }
  return out
}

/**
 * 把引擎引用翻译成前端来源卡片。
 *
 * ⚠️ **本函数绝不抛异常**：这里失败只能表现为「这次没有来源卡片」，
 *    绝不能把已经流完的回答带崩 —— 回答是主功能，来源是锦上添花。
 */
export async function toAgentSources(
  evt: AskEvent,
  resolveDoc: ResolveAgentDoc
): Promise<AgentSource[]> {
  const refs = readEngineReferences(evt)
  if (refs.length === 0) return []
  const items: AgentSource[] = []
  for (const ref of refs) {
    if (items.length >= MAX_SOURCES) break
    // 用 knowledge_id 从**书架已拉的全量清单**本地关联（listFiles() 自带 60 秒缓存），
    // 不为一条引用单独发请求。用途有两个：拿到本地 id 拼站内链接、兜底元数据。
    let doc: AgentSourceDoc | null = null
    try {
      doc = await resolveDoc(ref.knowledgeId)
    } catch {
      doc = null
    }
    // 本地清单里没有这条引用 → 直接跳过，绝不给点进去 404 的死链（与既有口径一致）
    if (!doc) continue
    /**
     * T8：机构 / 年份**优先读引用自带的 knowledge_custom_metadata**（更准、更省），
     * 读不到才退回书架清单本地关联（老路保留做兜底）。
     *
     * 为什么引用自带的那份更准：它就是这条资料自己的元数据快照，不会再出现
     * 「清单 60 秒缓存里恰好没有它」这种时间差。
     */
    const org = ref.meta['org'] || doc.org
    const year = ref.meta['year'] || (doc.year > 0 ? String(doc.year) : '')
    const type = ref.meta['type'] || doc.type
    items.push({
      url: `/doc/${doc.id}`,
      name: doc.title || doc.fileName || ref.knowledgeTitle || ref.knowledgeId,
      kbId: ref.knowledgeBaseId,
      org,
      year,
      type
    })
  }
  return limitSources(items)
}

/**
 * 读一条 references 事件里已经翻译好的来源（由 translateAgentStream 挂上去的）。
 *
 * 消费方（routes/ask.ts）只需一行：`const items = readAgentSources(evt)`，
 * 不必知道 `raw` 里挂了什么键。形状不对就返回空数组。
 */
export function readAgentSources(evt: AskEvent): AgentSource[] {
  const list = evt.raw['agent_sources']
  if (!Array.isArray(list)) return []
  const out: AgentSource[] = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const url = readString(entry, 'url')
    const name = readString(entry, 'name')
    if (!url.startsWith('/') || !name) continue
    out.push({
      url,
      name,
      kbId: readString(entry, 'kbId'),
      org: readString(entry, 'org'),
      year: readString(entry, 'year'),
      type: readString(entry, 'type')
    })
  }
  return out
}

/** 计数转成一行日志文本（「为什么慢」排查用） */
export function formatCounters(c: AgentSseCounters): string {
  return (
    `total=${c.total} agent_query=${c.agentQuery} thinking=${c.thinking} ` +
    `tool_call=${c.toolCall} tool_result=${c.toolResult} answer=${c.answer} references=${c.references}`
  )
}

export interface TranslateAgentOptions {
  /** 由 index.ts 注入：用 knowledge_id 在书架清单里找资料（不发请求） */
  resolveDoc: ResolveAgentDoc
  /** 一条日志的前缀，默认 `[agent-chat]` */
  logPrefix?: string
}

/**
 * 智能体原始事件流 → 适配后的事件流。
 *
 * 产出的仍是 `AskEvent`（与 knowledge-chat 链路同一种类型），差别只有两点：
 *   - `thinking` / `tool_call` / `tool_result` / `agent_query` **不再往下发**（已计数）
 *   - `references` 会被就地补一个 `raw.agent_sources`，供 routes/ask.ts 取出来转成 `sources`
 *
 * 消费方对「没收到 thinking」的既有行为（`includeThinking` 才透）完全无感。
 */
export async function* translateAgentStream(
  source: AsyncGenerator<AskEvent, void, void>,
  counters: AgentSseCounters,
  options: TranslateAgentOptions
): AsyncGenerator<AskEvent, void, void> {
  const prefix = options.logPrefix ?? '[agent-chat]'
  try {
    for await (const evt of source) {
      counters.total += 1
      switch (evt.responseType) {
        case 'agent_query':
          counters.agentQuery += 1
          continue
        case 'thinking':
          // 🔴 本轮不转发（理由见文件头）；计数保留，将来加「可折叠思考区」时改这一处即可
          counters.thinking += 1
          continue
        case 'tool_call':
          counters.toolCall += 1
          continue
        case 'tool_result':
          counters.toolResult += 1
          continue
        case 'references': {
          counters.references += 1
          const items = await toAgentSources(evt, options.resolveDoc)
          // 把翻译结果挂回 raw：消费方用 readAgentSources(evt) 取，不关心引擎的原始字段名
          yield items.length > 0 ? { ...evt, raw: { ...evt.raw, agent_sources: items } } : evt
          continue
        }
        case 'answer':
          counters.answer += 1
          yield evt
          continue
        case 'complete':
        case 'stop':
        case 'error':
          yield evt
          continue
        default:
          // 引擎将来新增的 response_type（如 session_title）：计数后透传，
          // 由 routes/ask.ts 按既有规则忽略，不在这里替它做取舍。
          counters.other += 1
          yield evt
      }
    }
  } finally {
    console.log(`${prefix} 事件统计：${formatCounters(counters)}`)
  }
}
