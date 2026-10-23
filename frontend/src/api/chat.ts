/**
 * 会话接口客户端（T5 · 独立问答页）—— 负责人：韶茹
 *
 *   POST   /api/chat/conversations                建会话
 *   GET    /api/chat/conversations                会话列表
 *   GET    /api/chat/conversations/:id/messages   会话全部消息
 *   DELETE /api/chat/conversations/:id            删会话
 *
 * 契约见 docs/接口约定.md 第二节「会话（T5）」。
 * ⚠️ 这里只调自建后端（localhost:4000），绝不直接连引擎（铁律 2）。
 * ⚠️ 用现成的 api/http.ts 封装，不新造第二个 axios 实例：baseURL / 凭证 / 错误 toast 统一在那里。
 */
import type { AxiosResponse } from 'axios'
import http from './http'
import type { AskSource } from './ask'

/**
 * 匿名归属令牌（2026-10-21 · T1 会话鉴权）
 *
 * 后端给每个匿名访客发一枚不可猜的令牌（响应头 X-Chat-Owner），
 * 会话按它归属；四个会话请求都必须带上它，
 * 否则后端认不出「这条会话是不是你的」→ 403。
 *
 * 为什么存 localStorage 而不是只放内存：刷新页面、换标签页后还得认回自己的会话。
 * 为什么不用 httpOnly cookie 顶一顶：cookie 虽然浏览器自动带，
 * 但前端与后端不同端口时是跨域请求，第三方 cookie 会被浏览器拦掉，
 * 所以两条腿走路（cookie 由后端种下，这里再存一份备用）。
 */
const OWNER_KEY = 'zwp.chat.owner'
const OWNER_HEADER = 'X-Chat-Owner'
/** 后端令牌的格式：32 位十六进制（格式不对的一律不存，免得脏数据进来） */
const OWNER_TOKEN_RE = /^[0-9a-f]{32}$/

/** 取出本地存的归属令牌（没有就是空串） */
function ownerToken(): string {
  return localStorage.getItem(OWNER_KEY) ?? ''
}

/** 请求头：带上归属令牌（没有就先不带，等后端下发了再说） */
function ownerHeaders(): Record<string, string> {
  const token = ownerToken()
  return token ? { [OWNER_HEADER]: token } : {}
}

/** 记下后端下发的归属令牌（登录状态下后端不下发，这时不动本地那一份） */
function rememberOwner(res: AxiosResponse): void {
  const raw = res.headers?.['x-chat-owner']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value === 'string' && OWNER_TOKEN_RE.test(value)) {
    localStorage.setItem(OWNER_KEY, value)
  }
}

/** 一条会话摘要（列表项） */
export interface ConversationSummary {
  id: string
  title: string
  /** 引擎会话是否就绪（false = 首次提问时懒建，不影响使用） */
  engineReady: boolean
  createdAt: string
  updatedAt: string
  messageCount: number
  /** 最后一条消息摘要（后端已压成一行短文字） */
  lastMessage: string
}

/** 一条消息（后端已把 sources 从 JSON 字符串还原成数组） */
export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources: AskSource[]
  createdAt: string
}

interface CreateResponse {
  success: boolean
  conversation: ConversationSummary
}

interface ListResponse {
  success: boolean
  items: ConversationSummary[]
}

interface MessagesResponse {
  success: boolean
  conversation: ConversationSummary
  messages: StoredMessage[]
}

/**
 * 后端只会回我们约定的形状，但 axios 拿到的是 `unknown` 之下的 any。
 *
 * ⚠️ 这里逐字段校验而不是直接 `as ConversationSummary`：会话列表是「决定用户看到哪个会话」
 * 的依据，一个 undefined 标题会让整个侧栏渲染崩掉。宁可少渲染一条，也别整页白屏。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toSummary(raw: unknown): ConversationSummary | null {
  if (!isRecord(raw)) return null
  const id = raw['id']
  const title = raw['title']
  const createdAt = raw['createdAt']
  const updatedAt = raw['updatedAt']
  if (typeof id !== 'string' || !id) return null
  if (typeof title !== 'string') return null
  return {
    id,
    title: title.trim() || '新对话',
    engineReady: raw['engineReady'] === true,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
    messageCount: typeof raw['messageCount'] === 'number' ? raw['messageCount'] : 0,
    lastMessage: typeof raw['lastMessage'] === 'string' ? raw['lastMessage'] : ''
  }
}

function toSources(raw: unknown): AskSource[] {
  if (!Array.isArray(raw)) return []
  const out: AskSource[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const name = entry['name']
    const url = entry['url']
    if (typeof name !== 'string' || typeof url !== 'string' || !url.startsWith('/')) continue
    // T8：刷新历史时也要带上机构/年份（老数据没有这三个字段 → 只显示资料名）
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

function toMessage(raw: unknown): StoredMessage | null {
  if (!isRecord(raw)) return null
  const id = raw['id']
  const content = raw['content']
  if (typeof id !== 'string' || typeof content !== 'string') return null
  return {
    id,
    role: raw['role'] === 'user' ? 'user' : 'assistant',
    content,
    sources: toSources(raw['sources']),
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : ''
  }
}

/** 建一个新会话（引擎就绪与否看返回的 engineReady，不影响本页使用） */
export async function createConversation(): Promise<ConversationSummary> {
  const res = await http.post<CreateResponse>('/chat/conversations', undefined, {
    headers: ownerHeaders()
  })
  rememberOwner(res)
  const conv = toSummary(res.data?.conversation)
  if (!conv) throw new Error('后端返回的会话数据不完整，请刷新重试')
  return conv
}

/** 会话列表（按最近活动倒序，后端已排好） */
export async function listConversations(): Promise<ConversationSummary[]> {
  const res = await http.get<ListResponse>('/chat/conversations', {
    silent: true,
    headers: ownerHeaders()
  })
  rememberOwner(res)
  const raw = res.data?.items
  if (!Array.isArray(raw)) return []
  const out: ConversationSummary[] = []
  for (const entry of raw) {
    const conv = toSummary(entry)
    if (conv) out.push(conv)
  }
  return out
}

/** 取某个会话的全部消息（刷新页面靠它恢复画面） */
export async function fetchMessages(
  conversationId: string
): Promise<{ conversation: ConversationSummary; messages: StoredMessage[] }> {
  const res = await http.get<MessagesResponse>(
    `/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    { headers: ownerHeaders() }
  )
  rememberOwner(res)
  const conv = toSummary(res.data?.conversation)
  if (!conv) throw new Error('会话数据不完整，请刷新重试')
  const raw = res.data.messages
  const messages: StoredMessage[] = []
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const msg = toMessage(entry)
      if (msg) messages.push(msg)
    }
  }
  return { conversation: conv, messages }
}

/**
 * 删会话。
 *
 * 404 也当成删成功：并发展示时可能两个标签页删同一个，会话已经没了就是达成了目标，
 * 让用户看到一条红色报错纯属制造困惑。
 */
export async function deleteConversation(conversationId: string): Promise<void> {
  try {
    await http.delete(`/chat/conversations/${encodeURIComponent(conversationId)}`, {
      silent: true,
      headers: ownerHeaders()
    })
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status !== 404) throw err
  }
}