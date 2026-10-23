/**
 * 会话存储（T5 · 乙方案：会话存数据库）—— 负责人：韶茹
 *
 * 为什么单独一个模块：`routes/chat.ts`（前端管会话列表）和 `routes/ask.ts`（流式问答落库）
 * 都要读写同一批数据，两边各写一份 Prisma 调用迟早口径漂移，**收口在这里**。
 *
 * 三条铁律在这里的落法：
 *   - 密钥永不进代码：engineSessionId 只落库、不出接口（铁律 1）
 *   - 前端不直连引擎：全部经 weknora 层，密钥留在服务端（铁律 2）
 *   - 不改 WeKnora 源码：只调它的 HTTP 接口（铁律 3）
 *
 * 2026-10-21（T1 会话鉴权）：会话开始记归属（ownerId），
 * 列表与新建都按归属过滤；归属怎么算、怎么比对在 ./owner.ts。
 */
import { PrismaClient } from '@prisma/client'

import type { AskSource } from '../weknora/index.js'

/**
 * Prisma 客户端。
 *
 * ⚠️ auth.ts 也 `new PrismaClient()` 了（各模块自持，模块间互不 import 是本仓既有风格）。
 *    多几个实例只是多几个连接池，SQLite 下无影响；要统一成一个实例应整体重构，不在本轮范围。
 */
export const prisma = new PrismaClient()

/** 会话列表最多返回多少条（对话是「最近的几十个」这种量级，设上限防库大了拖垮列表） */
const MAX_LIST = 100

/** 摘要取多少字 */
const PREVIEW_LEN = 40

/** 前端约定的空标题（此时第一条提问会自动改写成标题） */
export const DEFAULT_TITLE = '新对话'

/** 给前端的一条会话摘要 */
export interface ConversationSummary {
  id: string
  title: string
  /** 引擎会话是否已就绪。false = 首次提问时会懒建 */
  engineReady: boolean
  createdAt: string
  updatedAt: string
  messageCount: number
  /** 最后一条消息的摘要（列表里给读者一眼认出这个会话聊过什么） */
  lastMessage: string
}

/** 给前端的一条消息（sources 已从 JSON 字符串还原成数组） */
export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources: AskSource[]
  createdAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把回答正文压成一行摘要。
 *
 * 模型的 Markdown 记号（#、`**`、列表符号）留在摘要里会很脏，先剥掉；
 * 再按**字符数**截断（中文一个字一个字跳，比按 UTF-16 单元更符合肉眼观感）。
 */
export function buildPreview(content: string): string {
  const flat = content
    .replace(/```[\s\S]*?```/g, ' ') // 代码块整体丢掉
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只留文字
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ') // <kb/> 这类标签
    .replace(/[#>*_~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...flat]
  if (chars.length <= PREVIEW_LEN) return flat
  return `${chars.slice(0, PREVIEW_LEN).join('')}…`
}

function isKnownRole(raw: string): raw is 'user' | 'assistant' {
  return raw === 'user' || raw === 'assistant'
}

/**
 * 库里存的 sources 是 JSON 字符串，读出来还原成数组；坏了就当没有来源卡片。
 *
 * T8：org / year / type 跟着一起还原（来源卡片上要显示机构与年份）。
 * **老数据没有这三个字段** —— 那时它们是 undefined，卡片退化成只显示资料名，
 * 与加这个功能之前一模一样，不会渲染出「undefined」。
 */
function parseSources(raw: string | null): AskSource[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: AskSource[] = []
  for (const entry of parsed) {
    if (!isRecord(entry)) continue
    const name = entry['name']
    const url = entry['url']
    if (typeof name !== 'string' || typeof url !== 'string') continue
    const org = entry['org']
    const year = entry['year']
    const type = entry['type']
    out.push({
      name,
      url,
      ...(typeof org === 'string' && org ? { org } : {}),
      ...(typeof year === 'string' && year ? { year } : {}),
      ...(typeof type === 'string' && type ? { type } : {})
    })
  }
  return out
}

interface ConversationRow {
  id: string
  title: string
  engineSessionId: string | null
  /**
   * 归属（2026-10-21 加 · T1 会话鉴权）：
   *   'u:'+userId = 登录用户的会话；'t:'+令牌 = 匿名访客的会话；
   *   null = 这个字段加之前的历史会话（谁都不属于）。
   * 归属的判定与比对在 ./owner.ts，这里只负责存取。
   */
  ownerId: string | null
  createdAt: Date
  updatedAt: Date
}

interface MessageRow {
  id: string
  role: string
  content: string
  sources: string | null
  createdAt: Date
}

function toSummary(
  row: ConversationRow,
  messageCount: number,
  lastMessage: string | null
): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    // ⚠️ 只回「有没有」，**绝不回 engineSessionId 的值**（铁律 1）
    engineReady: row.engineSessionId !== null && row.engineSessionId !== '',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messageCount,
    lastMessage: lastMessage === null ? '' : buildPreview(lastMessage)
  }
}

export class ConversationNotFoundError extends Error {
  constructor(id: string) {
    super(`对话不存在：${id}`)
    this.name = 'ConversationNotFoundError'
  }
}

/**
 * 建一条空会话。
 *
 * ⚠️ ownerId 必填：会话从这一刻起就有主了。
 *    没有归属的会话谁都能读、谁都能删 —— 那正是这次要修的漏洞（P0-3）。
 */
export async function createConversation(ownerId: string, title?: string): Promise<ConversationSummary> {
  const clean = (title ?? '').trim().slice(0, 40)
  const row = await prisma.conversation.create({
    data: { ownerId, ...(clean ? { title: clean } : {}) }
  })
  return toSummary(row, 0, null)
}

/**
 * 会话列表：按最近活动倒序，带最后一条摘要与消息条数。
 *
 * ⚠️ 只列**这个归属**的会话（ownerId 精确匹配）：
 *    以前这里是全表返回，库里 31 条历史会话互相全可见。
 *    ownerId 为 null 的历史会话不匹配任何人，因此谁都列不出来。
 */
export async function listConversations(ownerId: string): Promise<ConversationSummary[]> {
  const rows = await prisma.conversation.findMany({
    where: { ownerId },
    orderBy: { updatedAt: 'desc' },
    take: MAX_LIST,
    include: {
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true } },
      _count: { select: { messages: true } }
    }
  })
  return rows.map((row) =>
    toSummary(row, row._count.messages, row.messages[0]?.content ?? null)
  )
}

/** 取一条会话（不存在抛 ConversationNotFoundError） */
export async function getConversation(id: string): Promise<ConversationRow> {
  const row = await prisma.conversation.findUnique({ where: { id } })
  if (!row) throw new ConversationNotFoundError(id)
  return row
}

/** 某个会话的全部消息（按时间正序，前端直接顺着重画） */
export async function listMessages(conversationId: string): Promise<StoredMessage[]> {
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' }
  })
  return rows.map((row: MessageRow) => ({
    id: row.id,
    // 库里只认这两个角色；别的（脏数据/未来扩展）一律当 assistant 显示，别把气泡渲染崩
    role: isKnownRole(row.role) ? row.role : 'assistant',
    content: row.content,
    sources: parseSources(row.sources),
    createdAt: row.createdAt.toISOString()
  }))
}

/** 某条会话的摘要（详情页给标题用） */
export async function summarize(conversationId: string): Promise<ConversationSummary> {
  const row = await getConversation(conversationId)
  const count = await prisma.message.count({ where: { conversationId } })
  const last = await prisma.message.findFirst({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    select: { content: true }
  })
  return toSummary(row, count, last?.content ?? null)
}

/** 追加一条消息。sources 只在 assistant 上有意义 */
export async function appendMessage(params: {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  sources?: AskSource[]
}): Promise<void> {
  await prisma.message.create({
    data: {
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      ...(params.sources && params.sources.length > 0
        ? { sources: JSON.stringify(params.sources) }
        : {})
    }
  })
}

/**
 * 记一次会话活动：把 updatedAt 顶上去，会话列表因此按「最近聊过」排序。
 *
 * ⚠️ updatedAt **显式赋值**，不依赖 Prisma 的 @updatedAt 自动填：
 *    那套只在 update 语句真的改了别的列时才可靠，这里我们恰恰常常一个字段都不改。
 * `newTitle` 只在「还是默认标题 + 这是第一条用户消息」时传，用首问改标题（列表才认得出会话）。
 */
export async function touchConversation(params: {
  conversationId: string
  newTitle?: string
}): Promise<void> {
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      updatedAt: new Date(),
      ...(params.newTitle ? { title: params.newTitle } : {})
    }
  })
}

/** 记下引擎会话 id（懒建成功后回填）。仅在原来为空时写入，不覆盖已有的。 */
export async function setEngineSessionId(conversationId: string, engineSessionId: string): Promise<void> {
  await prisma.conversation.updateMany({
    where: { id: conversationId, engineSessionId: null },
    data: { engineSessionId }
  })
}

/**
 * 删会话（连带删它全部消息）。
 *
 * ⚠️ 不只靠 schema 上的 onDelete: Cascade：SQLite 的外键级联受 PRAGMA foreign_keys 控制，
 *    引擎行为不同就可能留下孤儿消息。这里先显式删消息再删会话，两条路都堵死。
 *    引擎侧 session 不管 —— 它自己会过期。
 */
export async function deleteConversation(id: string): Promise<void> {
  await prisma.message.deleteMany({ where: { conversationId: id } })
  await prisma.conversation.deleteMany({ where: { id } })
}