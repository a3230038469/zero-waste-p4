/**
 * AI 问答挂件接入 —— 负责人：瑞泽（B07，救急版由协作 AI 实现）
 *
 * 职责：加载官方嵌入挂件（<script> → 内部渲染跨源 iframe）、维护就绪状态、
 *      提供「问一句」的串行队列调用。
 *
 * ⚠️ 铁律第 2 条：前端只调自建后端 POST /api/embed/token 换临时钥匙，
 *    绝不直连引擎、绝不持有长期凭证（publish token 只在后端 .env）。
 *
 * ── 串行队列（P0，实测坑）────────────────────────────────────────
 * 挂件的 openWithQuery 只是 postMessage，**不排队**：
 * 用户连点 3 条示例问题，上游会把并发请求静默丢掉，结果只出 2 个气泡。
 * 因此同一时刻只允许一条提问在飞，收到挂件的 message_received 回执后
 * 才放行下一条；8 秒收不到回执按超时放行，避免永久死锁。
 * 验收：连点 3 条示例问题，挂件里必须出现 3 条气泡。
 * ────────────────────────────────────────────────────────────────
 */
import { onBeforeUnmount, ref } from 'vue'
import http from '../api/http'

/* ---------------- 常量（接口未定稿的字段集中在此，韶茹定稿后只改这里） ---------------- */

/**
 * 挂件对外全局对象名候选。
 * 官方 loader 为 <script> 引入、内部渲染跨源 iframe，暴露的全局名以实测为准。
 * 已知对外方法：openWithQuery(query) / setContext(context) / on('ready')
 * 这里按候选逐个探测，命中即用，避免绑定到未落定的具体名字。
 */
const WIDGET_GLOBAL_CANDIDATES = ['WeKnoraEmbed', 'WeKnoraWidget', 'WeKnora', 'weknoraEmbed']

/** 换取临时钥匙的自建后端接口（见 docs/接口约定.md 第 30 行「问答钥匙」） */
const TOKEN_ENDPOINT = '/embed/token'

/** 换钥匙超时（毫秒） */
const TOKEN_TIMEOUT_MS = 8000
/** 挂件脚本加载 + 就绪超时（毫秒） */
const WIDGET_LOAD_TIMEOUT_MS = 8000
/** 单条提问等待 message_received 回执的超时（毫秒）——超时即放行下一条，防死锁 */
const MESSAGE_ACK_TIMEOUT_MS = 8000

/** 统一降级文案（任务书口径） */
export const DEGRADED_MESSAGE = 'AI 助手暂时不可用，请稍后再试'
/** 挂件启动中提示 */
export const LOADING_MESSAGE = 'AI 助手正在接入中'

/* ---------------- 类型 ---------------- */

/**
 * POST /api/embed/token 的响应。
 * ⚠️ 字段名**待韶茹定稿**（docs/接口约定.md 只写了「临时钥匙 + 有效期」）。
 * 当前按建议值实现；定稿后若改名，只需同步此处与 fetchEmbedToken。
 */
export interface EmbedTokenResponse {
  token: string
  expiresIn: number
  channelId: string
  /** 挂件 loader 脚本地址（后端下发，前端不写死） */
  widgetUrl: string
}

/** 挂件实例的最小对外接口（未定稿，按已知方法做可选绑定） */
interface WidgetInstance {
  openWithQuery?: (query: string) => void
  setContext?: (context: Record<string, unknown>) => void
  on?: (event: string, handler: (...args: unknown[]) => void) => void
}

/** 挂件就绪状态 */
export type WidgetStatus = 'idle' | 'loading' | 'ready' | 'degraded'

/* ---------------- 模块级：跨实例共享的资源加载（只做「加载一次」的收敛） ----------------
 * 说明：脚本与换钥匙结果可以跨实例复用，因此放在模块级做单飞；
 *      而**队列状态必须是每个实例私有的**（见下方 makeQueue），
 *      否则组件卸载重挂载会互相污染队列。
 * ------------------------------------------------------------------------------ */

let scriptPromise: Promise<boolean> | null = null
let instance: WidgetInstance | null = null
/** 已注入的 loader 节点，失败时用于清理 */
let scriptEl: HTMLScriptElement | null = null
/** mount 单飞：避免预热 / 点开面板 / 点示例问题三路并发换钥匙 */
let mountPromise: Promise<boolean> | null = null

/** 取挂件全局对象（逐个候选探测） */
function resolveWidgetGlobal(): WidgetInstance | null {
  const w = window as unknown as Record<string, unknown>
  for (const name of WIDGET_GLOBAL_CANDIDATES) {
    const candidate = w[name]
    if (candidate && typeof candidate === 'object') {
      return candidate as WidgetInstance
    }
  }
  return null
}

/** 带超时的 Promise（避免任何等待把页面卡死） */
function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    task.then(
      (v) => {
        window.clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        window.clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/**
 * 调自建后端换临时钥匙。silent 关闭全局红字 toast，降级由组件自行呈现。
 */
async function fetchEmbedToken(): Promise<EmbedTokenResponse> {
  const res = await http.post<EmbedTokenResponse>(
    TOKEN_ENDPOINT,
    {},
    { silent: true, timeout: TOKEN_TIMEOUT_MS }
  )
  const data = res.data
  if (!data || typeof data.token !== 'string' || !data.token) {
    throw new Error('换钥匙返回无效')
  }
  return data
}

/** 移除已注入但加载失败的 loader 节点 */
function removeFailedScript(): void {
  if (scriptEl && scriptEl.parentNode) {
    scriptEl.parentNode.removeChild(scriptEl)
  }
  scriptEl = null
}

/** 注入挂件 loader 脚本并等待就绪；失败/超时返回 false（失败会复位缓存以便重试） */
function loadWidgetScript(widgetUrl: string): Promise<boolean> {
  if (scriptPromise) {
    return scriptPromise
  }
  const pending = new Promise<boolean>((resolve) => {
    if (resolveWidgetGlobal()) {
      resolve(true)
      return
    }
    const script = document.createElement('script')
    script.src = widgetUrl
    script.async = true
    scriptEl = script
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      window.clearTimeout(timer)
      resolve(ok)
    }
    const timer = window.setTimeout(() => finish(false), WIDGET_LOAD_TIMEOUT_MS)
    script.onload = () => {
      const g = resolveWidgetGlobal()
      instance = g
      finish(Boolean(g))
    }
    script.onerror = () => finish(false)
    document.head.appendChild(script)
  })
  scriptPromise = pending
  // 失败后复位缓存并清理坏脚本，允许用户重试时重新加载（避免「一次失败永久降级」）
  void pending.then((ok) => {
    if (!ok) {
      removeFailedScript()
      // 仅当缓存的仍是自己时才复位，避免覆盖后续重试产生的新 promise
      if (scriptPromise === pending) {
        scriptPromise = null
      }
    }
  })
  return pending
}

/** 启动：换钥匙 → 载 loader → 就绪。任一步失败即降级。单飞，可重复调用。 */
async function mountWidget(): Promise<boolean> {
  if (mountPromise) {
    return mountPromise
  }
  mountPromise = (async () => {
    try {
      const payload = await withTimeout(fetchEmbedToken(), TOKEN_TIMEOUT_MS, '换钥匙')
      const url = typeof payload.widgetUrl === 'string' ? payload.widgetUrl : ''
      if (!url) {
        throw new Error('后端未下发 widgetUrl')
      }
      const ok = await loadWidgetScript(url)
      if (!ok) {
        throw new Error('挂件加载失败')
      }
      instance = instance ?? resolveWidgetGlobal()
      return true
    } catch {
      return false
    }
  })()
  const ok = await mountPromise
  mountPromise = null
  return ok
}

/* ---------------- 每实例私有的串行队列 ---------------- */

interface AckSlot {
  /** 当前活跃的回执回调；结束时要校验归属再清，避免误清下一条 */
  handler: (() => void) | null
}

/**
 * 创建一条私有串行队列。
 * 之所以不用模块级变量：组件卸载重挂载时，旧实例的清空动作会污染新实例。
 */
function makeQueue() {
  let inFlight = false
  const waiters: Array<() => void> = []

  function release(): void {
    inFlight = false
    const next = waiters.shift()
    if (next) {
      next()
    }
  }

  function acquire(): Promise<void> {
    if (!inFlight) {
      inFlight = true
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        inFlight = true
        resolve()
      })
    })
  }

  /** 清空队列（仅本实例），并把在飞标记复位 */
  function reset(): void {
    waiters.length = 0
    inFlight = false
  }

  return { acquire, release, reset }
}

/* ---------------- 对外 API ---------------- */

export function useWidget() {
  const status = ref<WidgetStatus>('idle')
  const errorMessage = ref('')

  /** 本实例私有的队列与回执槽 */
  const queue = makeQueue()
  const ack: AckSlot = { handler: null }

  /** 若挂件支持事件订阅，则按当前槽位登记 message_received 回执 */
  function bindAck(handler: () => void): void {
    ack.handler = handler
    const g = instance ?? resolveWidgetGlobal()
    if (g && typeof g.on === 'function') {
      try {
        g.on('message_received', handler)
      } catch {
        // 忽略：回执缺失时用超时兜底
      }
    }
  }

  /** 仅当槽位上还是自己那个回调时才清 —— 防止清掉下一条刚绑定的 handler */
  function unbindAck(handler: () => void): void {
    if (ack.handler === handler) {
      ack.handler = null
    }
  }

  /** 启动（幂等，内部单飞） */
  async function mount(): Promise<boolean> {
    if (status.value === 'ready') {
      return true
    }
    status.value = 'loading'
    errorMessage.value = ''
    const ok = await mountWidget()
    if (ok) {
      status.value = 'ready'
    } else {
      status.value = 'degraded'
      errorMessage.value = DEGRADED_MESSAGE
    }
    return ok
  }

  /**
   * 提问（走本实例的串行队列）。
   * - 未就绪先尝试 mount；mount 失败直接抛错，由调用方呈现降级提示。
   * - 同一时刻只放一条：收到 message_received 回执才释放；
   *   8 秒无回执按超时释放（防死锁）。
   */
  async function ask(question: string): Promise<void> {
    const q = question.trim()
    if (!q) {
      return
    }
    if (status.value !== 'ready' && !(await mount())) {
      throw new Error(DEGRADED_MESSAGE)
    }
    const target = instance ?? resolveWidgetGlobal()
    if (!target) {
      status.value = 'degraded'
      errorMessage.value = DEGRADED_MESSAGE
      throw new Error(DEGRADED_MESSAGE)
    }

    await queue.acquire()
    let timeoutId: number | null = null
    let onAck: (() => void) | null = null
    try {
      let ackResolve: (() => void) | null = null
      const ackPromise = new Promise<void>((resolve) => {
        ackResolve = resolve
      })
      // 保存本条的 handler 引用，用于「归属校验」后再清
      const handler = (): void => {
        ackResolve?.()
      }
      onAck = handler
      bindAck(handler)

      if (typeof target.openWithQuery === 'function') {
        target.openWithQuery(q)
      } else if (typeof target.setContext === 'function') {
        target.setContext({ query: q })
      } else {
        throw new Error('挂件未提供提问接口')
      }

      // 等回执；超时放行下一条（超时分支同时 resolve ackPromise，避免悬挂）
      await Promise.race([
        ackPromise,
        new Promise<void>((resolve) => {
          timeoutId = window.setTimeout(() => {
            ackResolve?.()
            resolve()
          }, MESSAGE_ACK_TIMEOUT_MS)
        })
      ])
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
      // 只清属于本条的回调，避免误清下一条
      if (onAck) {
        unbindAck(onAck)
      }
      queue.release()
    }
  }

  onBeforeUnmount(() => {
    // 只重置本实例的队列；脚本/实例缓存是全局共享资源，不动
    queue.reset()
    ack.handler = null
  })

  return { status, errorMessage, mount, ask }
}
