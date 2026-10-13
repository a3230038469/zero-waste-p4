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
  /**
   * 【2026-10-10 追加，可选字段】若这份资料与另一份内容完全相同（SHA-256 一致），
   * 这里是「建议保留的那一份」的 id；否则该字段不出现。
   *
   * 为什么加：真实数据里有 11 组 12 份重复建档的文件。对外展示站要能把「这是副本」
   * 如实说出来（而不是假装没这回事），但是否撤下需业务方拍板，所以只标记、不删数据。
   * 旧调用方不受影响 —— 字段可选，不出现时行为与以前完全一致。
   */
  duplicateOf?: string
}

/** 后端内部额外持有的字段，**不随列表接口返回给前端** */
export interface KbDocInternal extends KbDoc {
  /** 原始出处链接（详情页「来源」用，见下方 CONTRACT_GAP 说明） */
  sourceUrl: string
  /** 原始文件名 */
  fileName: string
  /** 相对 backend/data 的路径（引擎来源为引擎侧的 file_path，仅排障用） */
  filePath: string
  /** 元数据表里声明的大小，仅用于人工核对 */
  sizeDeclared: number | null
  /**
   * 【T8 追加】所属方向，来自引擎 `custom_metadata.srcTable`（如 `知识查询（零废弃）`）。
   *
   * 为什么只放在内部字段：书架「所属方向」筛选器要按它筛，但契约第三节的七个字段
   * 不许增删，所以**不随列表接口外泄**。本地索引 / 演示快照没有这一项时是空串，
   * 此时 `srcTables` 返回空数组（前端不渲染该筛选项），不会出现「筛了永远 0 条」的假选项。
   */
  srcTable: string
  /**
   * 入库时间（毫秒时间戳）。引擎来源有（created_at），本地索引没有。
   * 用途：`sort=newest` 排序。引擎的 id 是 uuid，没有本地那种 k-35 数字后缀，
   * 不能再用 id 反推顺序，必须靠这个字段。
   */
  createdAt?: number
}

/** 筛选项：一个枚举值 + 条数 */
export interface FacetItem {
  value: string
  count: number
  /**
   * 【T8 追加，可选字段】展示名。**只影响显示**，提交筛选时仍传 `value`。
   *
   * 两种用法：
   *   · 联合发文：value 是那一长串原始机构值（筛选用），label 是 `A + B 等N家`（给人看）；
   *   · 所属方向：value 是数据里的 `知识查询（零废弃）`，label 是 `零废弃`。
   * 不出现时前端按 `value` 显示，旧调用方行为完全不变。
   */
  label?: string
}

/** GET /api/docs/facets 的响应体 */
export interface KbFacets {
  types: FacetItem[]
  orgs: FacetItem[]
  years: FacetItem[]
  tags: FacetItem[]
  /**
   * 【T8 追加】书架「所属方向」，来自 `custom_metadata.srcTable`。
   * 老库实测只有两个值：`知识查询（零废弃）` 480 份、`知识查询（化学品）` 123 份。
   * 数据源没有这一项时返回空数组（前端据此不渲染该筛选项）。
   */
  srcTables: FacetItem[]
}

/** 资料列表支持的排序方式 */
export type SortMode = 'year_desc' | 'newest'

/** 归一化后的列表查询条件 */
export interface DocsQuery {
  type: string[]
  org: string[]
  year: string[]
  tag: string[]
  /**
   * 【T8 追加】所属方向（`custom_metadata.srcTable` 的原值），可重复传参多选。
   * 单数参数名 `srcTable`，与数据字段同名，别写成 direction/topic。
   */
  srcTable: string[]
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

/** 数据来源：engine = 真实引擎；local = 本地资料包（引擎密钥未到位时的 demo 通道）；snapshot = 云端演示版（读元数据快照，无原件/AI） */
export type EngineSource = 'engine' | 'local' | 'snapshot'

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
