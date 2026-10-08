/**
 * WeKnora 对接层 · 契约类型 —— 负责人：韶茹
 *
 * 字段名严格照抄 docs/接口约定.md 第二、三节，**禁止自创同义别名**
 * （不能用 name / organization / publishYear 之类）。
 */

/** 一份资料 —— 前端可见字段，与 docs/接口约定.md 第三节逐项对应 */
export interface KbDoc {
  id: string
  title: string
  org: string
  year: number
  type: string
  tags: string[]
  /** 文件大小，单位：字节（number，不是 "0.9MB" 字符串） */
  size: number
}

/** 后端内部额外持有的字段，**不随列表接口返回给前端** */
export interface KbDocInternal extends KbDoc {
  /** 原始出处链接（详情页「来源」用，见下方 CONTRACT_GAP 说明） */
  sourceUrl: string
  /** 原始文件名 */
  fileName: string
  /** 相对 backend/data 的路径 */
  filePath: string
  /** 元数据表里声明的大小，仅用于人工核对 */
  sizeDeclared: number | null
}

/** 筛选项：一个枚举值 + 条数 */
export interface FacetItem {
  value: string
  count: number
}

/** GET /api/docs/facets 的响应体 */
export interface KbFacets {
  types: FacetItem[]
  orgs: FacetItem[]
  years: FacetItem[]
  tags: FacetItem[]
}

/** 资料列表支持的排序方式 */
export type SortMode = 'year_desc' | 'newest'

/** 归一化后的列表查询条件 */
export interface DocsQuery {
  type: string[]
  org: string[]
  year: string[]
  tag: string[]
  q: string
  page: number
  pageSize: number
  sort: SortMode
}

/** GET /api/docs 的响应体（形状固定，字段不可增删） */
export interface DocsPage {
  total: number
  page: number
  pageSize: number
  zeroResult: boolean
  items: KbDoc[]
}

/** 资料详情响应体 = 契约七字段 + sourceUrl */
export interface DocDetail extends KbDoc {
  sourceUrl: string
}

/** 取一份资料文件时用的流，本地/引擎两种来源统一成这个形状 */
export interface DocStream {
  fileName: string
  size: number
  contentType: string
  stream: NodeJS.ReadableStream
}

/** 数据来源：engine = 真实引擎；local = 本地资料包（引擎密钥未到位时的 demo 通道） */
export type EngineSource = 'engine' | 'local'

/** 问答临时钥匙 */
export interface EmbedToken {
  token: string
  /** 有效期（秒），引擎要求 30 分钟 */
  expiresIn: number
  channelId: string
}

/**
 * 问答流里的一条事件（引擎 SSE 帧解析而来）。
 *
 * ⚠️ 协议实测（portal 项目用真实引擎取过证，别再退回旧写法）：
 * 引擎每个事件都可能带 `done: true`，它只表示「该消息片段完结」，**不是整段流结束**。
 * 实测首帧就是 `{"response_type":"agent_query","done":true,"content":""}` 入队确认帧；
 * 若见 done 就断流，正文一个字都拿不到。真正的终止信号是 `response_type` 为
 * `complete` / `stop` / `error`（依据：WeKnora 前端 useChatStreamHandler 只在 complete 分支收尾）。
 */
export interface AskEvent {
  /** SSE 的 `event:` 字段 */
  event: string
  /** 引擎的 `response_type`：agent_query / thinking / answer / references / complete / stop / error … */
  responseType: string
  content: string
  /** 仅表示「该片段完结」，**不是**整段流结束——判断收尾请用 isTerminalEvent() */
  done: boolean
  /** 引擎原始对象（排障用，默认不透给前端） */
  raw: Record<string, unknown>
}

/**
 * 统一错误：带机器可读的 code，路由层据此决定 HTTP 状态码，
 * 并保证「引擎没开 / 密钥错」这类情况返回清楚提示而不是 500 崩栈。
 */
export class EngineError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 502) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.status = status
  }
}
