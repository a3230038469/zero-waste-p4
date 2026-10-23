/**
 * 在途问答的「模块级暂存」—— 2026-10-21 新增（修「切页回来问答没了」）
 *
 * 问题：问答发出后、回答还没收完，用户点了顶部导航去别的页面（比如去资料库看看），
 * 回来时 `ChatView` 是重新挂载的：组件里的 messages 全没了，`busy` 也是 false，
 * 于是只剩一个光秃秃的提问气泡 —— 而服务端其实还在跑，稍后回答会照常落库。
 *
 * 做法：把「一次正在进行的流」提到组件外面（模块级 Map，按 conversationId 存）。
 *   - 组件卸载**不 abort**，流继续跑，回答继续累积在这份暂存里；
 *   - 组件再挂载时，如果这个会话还有在途/刚落定的回答，就把它接回界面上；
 *   - 服务端已经落库的回答优先（暂存只是补界面，不替代数据库）。
 *
 * 为什么不用 Pinia：全站没有引入状态库（见 frontend/package.json），为一个功能
 * 单引一个依赖不值当；这里用「模块级 Map + 订阅回调」就够，且天然是全局单例。
 *
 * ⚠️ 暂存只活到回答结束后 5 分钟：过期自动清掉，避免长期占内存，
 *    也避免用户几天后回来看到一条「幽灵回答」。
 */
import { askStream, AskError, type AskSource } from '../api/ask'
import { publicErrorDetail, publicErrorText } from '../api/http'
import {
  ASK_ERROR_TEXT,
  NO_ANSWER_TEXT,
  engineErrorText,
  looksLikeEngineError,
  looksLikeNoAnswerText
} from '../utils/askCopy'

/** 一条正在进行 / 刚结束的回答 */
export interface LiveAnswer {
  conversationId: string
  /** 本轮提问原文（用来还原提问气泡） */
  question: string
  /** 已经收到的回答正文（逐字累积） */
  text: string
  sources: AskSource[]
  /** 流是否还在进行 */
  streaming: boolean
  /** 连接层面失败的原因；空串 = 没失败 */
  failed: string
  /** 流正常结束但一个字都没有（落固定文案） */
  noAnswer: boolean
  startedAt: number
  /** 结束时间；0 = 还在流里 */
  finishedAt: number
  controller: AbortController
}

type Listener = (live: LiveAnswer) => void

/** conversationId → 在途/刚结束的回答 */
const liveMap = new Map<string, LiveAnswer>()
/** conversationId → 订阅者集合 */
const listeners = new Map<string, Set<Listener>>()
/** conversationId → 过期清理定时器 */
const gcTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 结束后在内存里保留多久（毫秒）—— 够用户切页回来接上即可 */
const KEEP_FINISHED_MS = 5 * 60 * 1000

function snapshot(live: LiveAnswer): LiveAnswer {
  return { ...live, sources: [...live.sources] }
}

function emit(live: LiveAnswer): void {
  const set = listeners.get(live.conversationId)
  if (!set) return
  for (const fn of set) {
    try {
      fn(snapshot(live))
    } catch {
      // 单个订阅者的错误不能影响流本身
    }
  }
}

function scheduleGc(conversationId: string): void {
  const prev = gcTimers.get(conversationId)
  if (prev) clearTimeout(prev)
  gcTimers.set(
    conversationId,
    setTimeout(() => {
      const cur = liveMap.get(conversationId)
      // 只有「仍然是那条已结束的」才清；期间又开始新流的话不动它
      if (cur && !cur.streaming) {
        liveMap.delete(conversationId)
        gcTimers.delete(conversationId)
      }
    }, KEEP_FINISHED_MS)
  )
}

/** 读某个会话当前的暂存（没有就 undefined）；读出来的是副本，改它不影响真实状态 */
export function getLiveAnswer(conversationId: string): LiveAnswer | undefined {
  const live = liveMap.get(conversationId)
  return live ? snapshot(live) : undefined
}

/** 这个会话是不是有在途回答（用于按钮禁用、提示语） */
export function hasLiveAnswer(conversationId: string): boolean {
  return liveMap.has(conversationId)
}

/**
 * 这个会话**此刻是不是真的还在流**。
 *
 * 🔴 2026-10-21（task-21 · D1）：`hasLiveAnswer` 看的是「内存里有没有这条暂存」，
 *    而暂存在回答**结束后还要留 5 分钟**（切页回来能接上）——
 *    于是「同一会话 5 分钟内问第二句」会被当成「还有一条在流」而**静默丢弃**。
 *    门禁要拦的只有「真的正在输出」的那一条，所以这里单独给一个判断：
 *    `live.streaming === true` 才算在流。
 */
export function isAnswerStreaming(conversationId: string): boolean {
  const live = liveMap.get(conversationId)
  return Boolean(live && live.streaming)
}

/** 订阅某个会话的暂存更新，返回取消订阅函数 */
export function subscribeLiveAnswer(conversationId: string, fn: Listener): () => void {
  let set = listeners.get(conversationId)
  if (!set) {
    set = new Set()
    listeners.set(conversationId, set)
  }
  set.add(fn)
  return () => {
    const cur = listeners.get(conversationId)
    if (!cur) return
    cur.delete(fn)
    if (cur.size === 0) listeners.delete(conversationId)
  }
}

/**
 * 清掉暂存。
 *
 * 用在三种地方：① 回答已确认落库（界面用服务端数据即可，不需要暂存）
 * ② 会话被删除 ③ 用户手动重新生成（旧的那条作废）。
 */
export function clearLiveAnswer(conversationId: string): void {
  const live = liveMap.get(conversationId)
  if (live?.streaming) return // 还在跑的不清，避免「看不见但还在烧钱」
  liveMap.delete(conversationId)
  const timer = gcTimers.get(conversationId)
  if (timer) {
    clearTimeout(timer)
    gcTimers.delete(conversationId)
  }
}

/** 中止某个会话的在途回答（会真正断开上游，不让引擎白跑） */
export function abortLiveAnswer(conversationId: string): void {
  const live = liveMap.get(conversationId)
  if (!live || !live.streaming) return
  live.controller.abort()
  live.streaming = false
  live.finishedAt = Date.now()
  if (!live.text) {
    live.failed = '已取消'
  }
  emit(live)
  scheduleGc(conversationId)
}

/**
 * 用户主动「停止生成」：中止这一轮，并让界面上**看得见**「本次提问已取消」。
 *
 * 与 `abortLiveAnswer` 的区别：
 *   - abortLiveAnswer 是内部作废（重新生成、删会话），失败文案是「已取消」；
 *   - cancelLiveAnswer 是用户明确喊停，失败文案用「本次提问已取消」，
 *     并且**保留已经收到的半截正文**（不装作什么都没发生），
 *     末尾补一句取消说明，来源条一并撤掉（这一轮没答完，不挂假引用）。
 *
 * @returns true = 确实停掉了一条正在流的回答；false = 这条已经结束（没什么可停）
 */
export function cancelLiveAnswer(conversationId: string, reason = '本次提问已取消'): boolean {
  const live = liveMap.get(conversationId)
  if (!live || !live.streaming) return false
  live.controller.abort()
  live.streaming = false
  live.finishedAt = Date.now()
  live.failed = reason
  live.sources = [] // 取消的一轮不挂来源条
  live.text = live.text ? `${live.text}\n\n${reason}` : reason
  emit(live)
  scheduleGc(conversationId)
  return true
}

/**
 * 发起一次流式提问，并把过程写进暂存。
 *
 * 返回同一份 LiveAnswer（调用方可立即读到初始状态）；
 * 后续变化一律通过 `subscribeLiveAnswer` 推。
 *
 * 不抛错：连接层错误写进 `failed`，UI 直接渲染（与改造前 ChatView 的兜底一致）。
 */
export function startLiveAnswer(options: {
  conversationId: string
  question: string
}): LiveAnswer {
  const { conversationId, question } = options
  const live: LiveAnswer = {
    conversationId,
    question,
    text: '',
    sources: [],
    streaming: true,
    failed: '',
    noAnswer: false,
    startedAt: Date.now(),
    finishedAt: 0,
    controller: new AbortController()
  }
  liveMap.set(conversationId, live)
  emit(live)

  void (async () => {
    try {
      await askStream({
        query: question,
        conversationId,
        signal: live.controller.signal,
        onEvent: (evt) => {
          if (evt.type === 'answer' || evt.type === 'thinking') {
            if (evt.type === 'answer') {
              live.text += evt.content
              // 🔴 引擎有时把「报错」当「答案正文」吐出来（2026-10-21 实测：
              //    "Sorry, this answer hit the model's per-response output limit ..."）。
              //    认出来就转成中文失败态，**不把英文当答案渲染给公众**。
              if (looksLikeEngineError(live.text)) {
                live.failed = engineErrorText(live.text)
                live.text = live.failed
                live.sources = [] // 失败的一轮不挂来源条
                live.noAnswer = false
              }
            }
          } else if (evt.type === 'sources') {
            live.sources = evt.items
          } else if (evt.type === 'error') {
            // 与改造前一致：流内报错标失败；已经吐了一半的正文保留，不抹掉
            live.failed = evt.content || ASK_ERROR_TEXT.unknown
            live.sources = [] // 失败的一轮不挂来源条（不挂假引用）
            if (!live.text) live.text = live.failed
          }
          emit(live)
        }
      })
      // 正文为空，或引擎把「答不上来」的兜底说明当正文吐出来 → 都按拒答处理，不挂引用
      if (!live.text || looksLikeNoAnswerText(live.text)) {
        live.noAnswer = true
        if (!live.text) live.text = NO_ANSWER_TEXT
        live.sources = [] // 无答案时不挂来源条
      }
    } catch (err) {
      /**
       * 连接层异常收尾。
       *
       * 🔴 2026-10-22：这里以前有两处会**吃掉已经流出来的正文**：
       *   1. `aborted` 只认 DOMException。但 askStream 把我们自己的 abort 包成了
       *      `AskError('aborted')`（见 api/ask.ts 的 catch），所以点「停止生成」后
       *      这条 catch 照常执行，把 `live.text` 覆盖成一句「已取消」——
       *      用户在气泡里看到的半截回答会突然消失。
       *   2. 断网 / 超时同样直接 `live.text = 失败文案`，前面收到的字全丢。
       * 现在：自己中止的一律交给 cancelLiveAnswer / abortLiveAnswer 收尾（它们已写好文案）；
       * 其它异常**保留半截正文**，把提示接在后面 —— 断流不代表刚才那些字没发生。
       */
      const aborted =
        (err instanceof DOMException && err.name === 'AbortError') ||
        (err instanceof AskError && err.kind === 'aborted')
      if (!aborted) {
        const notice = errorTextOf(err)
        live.failed = notice
        live.sources = [] // 失败的一轮不挂来源条
        live.text = live.text ? `${live.text}\n\n${notice}` : notice
      }
    } finally {
      live.streaming = false
      live.finishedAt = Date.now()
      emit(live)
      scheduleGc(conversationId)
    }
  })()

  return snapshot(live)
}

/**
 * 连接层错误的可读文案。
 *
 * 🔴 以前兜底是 `err.message`，断网时就是浏览器原话 **'Failed to fetch'**（英文，直接甩给公众）。
 *    现在按 kind 分类：断网 / 超时 / 被中止 各给一句中文；
 *    后端返回的中文错误信封优先保留（游客额度用完这类提示要让人看懂）。
 *
 * ⚠️ 2026-10-21（task-20）：后端原文**不再**直接甩给用户 —— 原文里可能带
 *    内部引擎地址、英文堆栈。原文只进 console.warn；对外只给「过了清洗的
 *    中文原因」（publicErrorDetail：拒 URL / IP / 端口 / 英文堆栈 / 超长）
 *    或前端本地固定中文（publicErrorText：错误码 → 状态码 → 兜底）。
 */
function errorTextOf(err: unknown): string {
  if (err instanceof AskError) {
    // AskError 的 status / code / message 拼成 axios 形状，复用统一文案表
    const shaped = {
      response: {
        status: typeof err.status === 'number' ? err.status : 0,
        data: { error: { code: err.code ?? '', message: err.message } }
      }
    }
    console.warn('[chat] 提问失败：', err.kind, err.status ?? '-', err.code ?? '-', err.message)
    const detail = publicErrorDetail(shaped)
    // 「提问失败（HTTP 500）」这类带状态码的原文也不算人话
    if (detail && !/HTTP\s*\d+/i.test(detail)) return detail
    return publicErrorText(shaped, ASK_ERROR_TEXT.unknown)
  }
  const errObj = err as {
    response?: { status?: number; data?: { error?: { code?: string; message?: string } } }
    message?: string
  }
  const raw = errObj?.response?.data?.error?.message
  if (typeof raw === 'string' && raw.trim()) {
    console.warn('[chat] 请求失败：', errObj?.response?.status ?? '-', raw)
  }
  // 英文原话（Failed to fetch / NetworkError / Load failed）一律换中文
  if (typeof errObj?.message === 'string' && errObj.message.trim()) {
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(errObj.message)) {
      return ASK_ERROR_TEXT.network
    }
  }
  return publicErrorText(err, ASK_ERROR_TEXT.unknown)
}
