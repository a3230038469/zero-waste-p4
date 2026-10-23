<script setup lang="ts">
/**
 * AI 问答独立页 —— T5 起，2026-10-19 整页重做（T14）
 *
 * 界面口径（主人拍板）：左会话栏 + 中对话流 + 右侧「引用来源」抽屉，形制参考主流问答产品，
 * 配色/圆角/字号全部走本站 `--zw-*` 令牌，不外挂一套风格。
 *
 * 这一版改掉的三件事：
 *   1. 正文引用从「文件名胶囊」改成【上标小方块数字】—— 名字糊在句子中间又长又乱；
 *      数字点一下 → 右侧抽屉打开并定位到那一条（`ChatBubble` 的 cite-style="sup"）。
 *   2. 回答底部一条「N 份资料 ▾」胶囊，点开同一个抽屉（不再在气泡里摊一排卡片）。
 *   3. 提问/回答不再套气泡：用户提问浅底气泡，回答平铺 + 头像 + 操作行（复制/重新生成/赞踩/分享）。
 *
 * 保留的既有行为（一个字都没动）：
 *   - 会话存数据库（后端 /api/chat），刷新页面画面原样回来；删会话是真删
 *   - 提问带 conversationId = 接着聊；切换会话先掐断未完成的流
 *   - 空正文收尾 → noAnswer 固定文案（不是故障，不用警示色）
 *   - 游客每日次数从 /api/guest/permissions 读，读不到就不显示数字
 *   - 资料库零结果带 ?q= 过来只预填、不自动发
 *
 * ⚠️ 赞/踩与「分享」都不写后端：赞踩只在本页记状态（不声称已上报），分享复制对话链接。
 *    要做成真分享页要在后端加接口，属于另一件事。
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import ChatBubble, { type BubbleMessage } from '../components/ChatBubble.vue'
import { useWaitingLines } from '../composables/useWaitingLines'
import { useAuth } from '../composables/useAuth'
import type { AskSource } from '../api/ask'
import {
  MAX_QUESTION_LENGTH,
  cancelAskTurn,
  fetchAiStatus,
  fetchAskUsage,
  type AskAiStatus,
  type AskUsage
} from '../api/ask'
import {
  abortLiveAnswer,
  cancelLiveAnswer,
  clearLiveAnswer,
  getLiveAnswer,
  hasLiveAnswer,
  isAnswerStreaming,
  startLiveAnswer,
  subscribeLiveAnswer,
  type LiveAnswer
} from '../composables/useChatStreamStore'
import { fetchGuestPermissions } from '../api/guest'
import { publicErrorText } from '../api/http'
import { ASK_DISCLAIMER, ASK_ERROR_TEXT, ASK_SCOPE_NOTE, parseStoredAnswer } from '../utils/askCopy'
import {
  createConversation,
  deleteConversation,
  fetchMessages,
  listConversations,
  type ConversationSummary,
  type StoredMessage
} from '../api/chat'

const route = useRoute()
const router = useRouter()

/** 会话列表（后端已按最近活动倒序） */
const conversations = ref<ConversationSummary[]>([])
/** 当前选中会话的 id；'' = 还没建/还没选中 */
const activeId = ref<string>('')
const messages = ref<BubbleMessage[]>([])
const draft = ref('')
const busy = ref(false)
const loading = ref(true)
/** 正在流式输出的那条消息的下标 */
const streamingIdx = ref(-1)
const bodyRef = ref<HTMLElement | null>(null)

/** 窄屏：会话栏变成覆盖层抽屉（选中会话后自动收起） */
const railOpen = ref(false)

/** 引用来源抽屉：打开的是第几条回答的引用 */
const citeMsg = ref(-1)
const citeOpen = ref(false)
/** 这次是从哪个上标点开的（打开后滚到那一条并高亮） */
const citeHit = ref(-1)

/** 赞/踩只在本页记状态，不写后端（见文件头） */
const rated = ref<Record<number, 'up' | 'down'>>({})

/** 游客每日提问上限：只有公开接口真实返回时才用于展示，读不到保持 null */
const guestDailyLimit = ref<number | null>(null)
const guestAiOpen = ref(true)
/** 游客今天已用/剩余次数（后端 GET /api/guest/ask-usage）；读不到保持 null（不编数字） */
const guestUsage = ref<AskUsage | null>(null)
/** 引擎可用状态（后端 GET /api/ai/status）；读不到保持 null（不显示降级公告） */
const aiStatus = ref<AskAiStatus | null>(null)
/** 这一轮还在服务端生成中（刷新/切页回来时轮询历史把它捞回来） */
const pendingReply = ref(false)
/** 「停止生成」正在执行中（避免连点两次） */
const stopping = ref(false)
const { isLoggedIn } = useAuth()

const activeTitle = computed(
  () => conversations.value.find((c) => c.id === activeId.value)?.title ?? 'AI 问答'
)

/** 抽屉里正在看的那条回答的引用列表 */
const citeSources = computed<AskSource[]>(() => {
  const m = messages.value[citeMsg.value]
  return m?.sources ?? []
})

/** 空状态：没有消息时显示引导（加载中不显示，避免闪一下） */
const showHero = computed(() => !loading.value && messages.value.length === 0)

/**
 * 「停止生成」按钮：只有这一轮**真的在流**的时候才出现。
 *
 * 🔴 2026-10-21（task-21 · T2-7）：后端早有 POST /api/ask/cancel，
 *    界面上却没有入口 —— 用户只能看着半截正文干等。
 */
const canStop = computed(() => streamingIdx.value >= 0 && !stopping.value)

/**
 * 「游客是否可提问」判断（仅未登录时有意义）。
 * - 游客问答关闭、或次数用完 → 不可问
 */
const guestCanAsk = computed(() => {
  if (isLoggedIn.value) return true
  if (!guestAiOpen.value) return false
  if (guestUsage.value && guestUsage.value.remaining <= 0) return false
  return true
})

/** 空面板时的示例问题 */
const EXAMPLES = [
  '社区堆肥要注意什么？',
  '低值可回收物为什么难回收？',
  '零废弃城市怎么建？',
  '塑料回收的经济性怎么样？',
  '化学品对健康有哪些风险？'
]

/** 从资料库零结果带过来的检索词（只预填，不自动发） */
const pulledKeyword = ref('')

const hasConversation = computed(() => conversations.value.length > 0)

/**
 * 会话按「今天 / 昨天 / 更早」分组 —— 参考产品左侧栏的做法。
 * 时间读的是后端给的 updatedAt（ISO），解析不出来就落到「更早」，不丢条目。
 */
function dayLabel(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return '更早'
  const now = new Date()
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(then, now)) return '今天'
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  if (sameDay(then, yest)) return '昨天'
  return '更早'
}

const convGroups = computed(() => {
  const groups: { label: string; items: ConversationSummary[] }[] = []
  for (const c of conversations.value) {
    const label = dayLabel(c.updatedAt)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(c)
    else groups.push({ label, items: [c] })
  }
  return groups
})

/**
 * 访客每日可提问次数的提示（数字只有一个来源：后端真实返回）。
 *
 * P3-1：光说「每天 5 次」没用，公众不知道今天还剩几次 →
 * 有 /api/guest/ask-usage 就显示「今天还能问 N 次」，用完了直接说用完。
 */
const guestLimitText = computed(() => {
  if (isLoggedIn.value || !guestAiOpen.value) return ''
  const usage = guestUsage.value
  if (usage && usage.limit > 0) {
    if (usage.remaining <= 0) return '今天的提问次数已经用完了，登录后不受此限制'
    return `游客今天还能问 ${usage.remaining} 次，登录后不设上限`
  }
  const limit = guestDailyLimit.value
  if (limit === null || limit <= 0) return ''
  return `游客每天可提问 ${limit} 次，登录后不受此限制`
})

/** 引擎不可用时的公告（后端说不可用才显示；读不到状态就不显示） */
const aiStatusText = computed(() => {
  const status = aiStatus.value
  if (!status || status.available) return ''
  return status.messageZh || 'AI 问答暂时不可用，请稍后再试'
})

/** 输入框字数（上限 ${MAX_QUESTION_LENGTH}） */
const draftLength = computed(() => draft.value.length)
/** 超长：前端先拦住，别等后端回 400 */
const overLimit = computed(() => draftLength.value > MAX_QUESTION_LENGTH)
/** DeepSeek 式输入卡：计数器平时不显示，接近上限才浮出来 */
const nearLimit = computed(() => draftLength.value > MAX_QUESTION_LENGTH * 0.8)

async function loadGuestLimit(): Promise<void> {
  if (isLoggedIn.value) return
  const payload = await fetchGuestPermissions()
  if (!payload.success) return
  guestAiOpen.value = payload.values.aiAsk
  guestDailyLimit.value = payload.values.aiAskDailyLimit
}

/** 游客今天还剩几次（P3-1；接口没有 / 读不到就静默） */
async function loadGuestUsage(): Promise<void> {
  if (isLoggedIn.value) return
  guestUsage.value = await fetchAskUsage()
}

/** 引擎能不能用（P3-5；接口没有 / 读不到就静默） */
async function loadAiStatus(): Promise<void> {
  aiStatus.value = await fetchAiStatus()
}

/** 轮询定时器（刷新/切页回来时把服务端那一轮的回答捞回来） */
let pollTimer: number | null = null
let pollDeadline = 0

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer)
    pollTimer = null
  }
  pendingReply.value = false
}

/**
 * 把库里读回来的消息转成气泡。
 *
 * 失败/拒答/取消在库里是「正文 + 前缀标记」（Message 表只有 content 一列，加字段要迁移），
 * 这里按前缀还原成 failed / noAnswer 状态。
 */
function toBubbleMessages(stored: StoredMessage[]): BubbleMessage[] {
  return stored.map((m) => {
    if (m.role === 'assistant') {
      const parsed = parseStoredAnswer(m.content)
      return {
        role: m.role,
        text: parsed.text,
        ...(parsed.failed ? { failed: true } : {}),
        ...(parsed.noAnswer ? { noAnswer: true } : {}),
        ...(m.sources.length > 0 ? { sources: m.sources } : {})
      }
    }
    return {
      role: m.role,
      text: m.content,
      ...(m.sources.length > 0 ? { sources: m.sources } : {})
    }
  })
}

/**
 * 轮询等服务端把这一轮回答落库。
 *
 * 🔴 为什么需要：服务端从 2026-10-21 起不再因为「客户端断开」而中止上游，
 *    所以刷新页面 / 切走再回来时，这一轮可能还在跑 —— 库里此时只有那条提问。
 *    这里每隔 2 秒拉一次历史，答案一落库就把它显示出来。
 */
function maybePollPendingReply(id: string): void {
  const last = messages.value[messages.value.length - 1]
  if (!last || last.role !== 'user') return
  pendingReply.value = true
  pollDeadline = Date.now() + 120_000

  const tick = async (): Promise<void> => {
    if (activeId.value !== id) {
      stopPolling()
      return
    }
    try {
      const { conversation, messages: stored } = await fetchMessages(id)
      if (activeId.value !== id) return
      const hasAssistant = stored.some((m) => m.role === 'assistant')
      if (hasAssistant) {
        messages.value = toBubbleMessages(stored)
        conversations.value = conversations.value.map((c) => (c.id === id ? conversation : c))
        pendingReply.value = false
        scrollToBottom()
        return
      }
    } catch {
      // 拉不到就等下一轮（别打扰用户）
    }
    if (Date.now() > pollDeadline) {
      pendingReply.value = false
      ElMessage.warning('这次提问没有完成，可以点「重新生成」再试一次')
      return
    }
    pollTimer = window.setTimeout(() => {
      void tick()
    }, 2000)
  }
  pollTimer = window.setTimeout(() => {
    void tick()
  }, 1500)
}

/** 把当前会话写进地址栏（?c=<id>）：刷新、分享、后退都能回到同一个会话 */
function syncUrlWithConversation(id: string): void {
  if (!id) return
  void router.replace({ path: '/chat', query: { ...route.query, c: id } })
}

/**
 * 流式输出时的滚动跟随。
 *
 * 🔴 2026-10-22：以前每个 SSE 片段都无条件 `scrollTop = scrollHeight`，
 *    用户往上滚去看前一段（长回答里很常见），下个字一到就被拽回底部 ——
 *    等于读不了已经生成的内容。
 * 现在只做「粘底跟随」：本来就在底部（距底 ≤ 80px）才跟着滚；
 * 用户手动往上滚就暂停跟随，自己滚回底部后自动恢复。
 */
const followBottom = ref(true)
const FOLLOW_THRESHOLD_PX = 80

function onStreamScroll(): void {
  const el = bodyRef.value
  if (!el) return
  followBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX
}

/**
 * 滚到底部。
 * @param force true = 无视当前是否在底部（发新问题时用）
 */
function scrollToBottom(force = false): void {
  void nextTick(() => {
    const el = bodyRef.value
    if (!el) return
    if (!force && !followBottom.value) return
    el.scrollTop = el.scrollHeight
    followBottom.value = true
  })
}

/** 与样式断点保持一致 */
function isNarrowScreen(): boolean {
  return window.matchMedia('(max-width: 860px)').matches
}

/**
 * 在途回答现在放在组件外面（见 `composables/useChatStreamStore.ts`）：
 * 切页不再 abort，回来能接上。这里只保留「界面怎么挂」的几个小状态。
 */
let detachLive: (() => void) | null = null
/** 在途回答气泡在上面的 messages 里排第几（-1 = 当前没有） */
let liveIndex = -1

/** 等待文案轮换（与首页挂件共用同一份策略） */
const waiting = useWaitingLines()

/** 把暂存里的当前内容写进第 idx 个气泡 */
function paintLive(live: LiveAnswer, idx: number): void {
  const msg = messages.value[idx]
  if (!msg) return
  msg.text = live.text
  if (!live.noAnswer && live.sources.length > 0) msg.sources = live.sources
  if (live.failed) msg.failed = true
  if (live.noAnswer) msg.noAnswer = true
}

/** 服务端已有同一条回答（已落库）时，暂存就是多余的 */
function hasServerAnswer(text: string): boolean {
  const target = text.trim()
  if (!target) return false
  return messages.value.some((m) => m.role === 'assistant' && m.text.trim() === target)
}

/** 只取消订阅，不中止流（切会话/离开页面都用它） */
function detachLiveAnswer(): void {
  if (detachLive) {
    detachLive()
    detachLive = null
  }
  liveIndex = -1
  streamingIdx.value = -1
}

/** 收到暂存更新：进行中就边收边画，结束就收尾一次 */
function onLiveUpdate(conversationId: string, live: LiveAnswer): void {
  if (conversationId !== activeId.value) return

  if (live.streaming) {
    busy.value = true
    if (liveIndex >= 0) {
      streamingIdx.value = liveIndex
      paintLive(live, liveIndex)
    }
    if (live.text) waiting.stop()
    scrollToBottom()
    return
  }

  // 结束（正常 / 报错 / 被中止）：画最后一份，然后复位界面
  if (liveIndex >= 0) paintLive(live, liveIndex)
  waiting.stop()
  busy.value = false
  scrollToBottom()
  // 失败/取消都要把会话摘要对上（标题取首问前 20 字，公众才分得清哪个会话问了什么）；
  // 只有「用户主动取消」不改摘要（那一轮没问成）
  if (!live.failed.includes('取消')) syncActiveSummary(live.question)
  detachLiveAnswer()

  // 问题 1 修复：每轮问答结束后，未登录则刷新游客剩余次数
  if (!isLoggedIn.value) {
    void loadGuestUsage()
  }
}

/** 把某个会话的在途回答接到界面上（没有就什么都不做） */
function attachLiveAnswer(conversationId: string, idx: number): void {
  detachLiveAnswer()
  liveIndex = idx
  detachLive = subscribeLiveAnswer(conversationId, (live) => onLiveUpdate(conversationId, live))
  const live = getLiveAnswer(conversationId)
  if (!live) return
  paintLive(live, idx)
  if (live.streaming) {
    busy.value = true
    streamingIdx.value = idx
    if (!live.text) waiting.start()
    scrollToBottom()
  }
}

/**
 * 会话加载完，看这个会话有没有在途/刚落定的回答需要接回来。
 *
 * 判定顺序：① 服务端已有同一条回答 → 用服务端的，暂存清掉
 *          ② 服务端列表最后一条就是这轮提问 → 只补回答气泡
 *          ③ 都没有（例如刚建会话没刷新）→ 提问 + 回答两个气泡都补上
 */
function adoptLiveAnswer(conversationId: string): void {
  const live = getLiveAnswer(conversationId)
  if (!live) {
    detachLiveAnswer()
    busy.value = false
    return
  }

  if (!live.streaming && hasServerAnswer(live.text)) {
    clearLiveAnswer(conversationId)
    detachLiveAnswer()
    busy.value = false
    return
  }

  const last = messages.value[messages.value.length - 1]
  if (last?.role === 'assistant' && last.text.trim() === live.text.trim()) {
    detachLiveAnswer()
    busy.value = false
    return
  }

  if (last?.role === 'user' && last.text.trim() === live.question.trim()) {
    // 服务端已经存了这轮提问，只补回答气泡
    messages.value.push({ role: 'assistant', text: '' })
  } else {
    messages.value.push({ role: 'user', text: live.question })
    messages.value.push({ role: 'assistant', text: '' })
  }
  attachLiveAnswer(conversationId, messages.value.length - 1)
}

async function newConversation(options: { silent?: boolean } = {}): Promise<void> {
  try {
    const conv = await createConversation()
    conversations.value = [conv, ...conversations.value]
    // 只是换界面看哪一栏；旧会话里没跑完的流不掐，留在暂存里，切回去还能接上
    detachLiveAnswer()
    busy.value = false
    waiting.stop()
    activeId.value = conv.id
    messages.value = []
    citeOpen.value = false
    stopPolling()
    followBottom.value = true
    syncUrlWithConversation(conv.id)
    if (isNarrowScreen()) railOpen.value = false
    if (!options.silent) ElMessage.success('已新建对话')
  } catch (err) {
    if (!options.silent) ElMessage.error(errorText(err, '新建对话失败，请稍后再试'))
  }
}

async function selectConversation(id: string): Promise<void> {
  if (isNarrowScreen()) railOpen.value = false
  if (id === activeId.value) return
  // 切换只换「看的会话」，不掐断在途流：流在 store 里继续跑，回来能接上
  detachLiveAnswer()
  busy.value = false
  waiting.stop()
  activeId.value = id
  loading.value = true
  messages.value = []
  citeOpen.value = false
  // 换会话是「看另一条对话」，跟随状态跟着重置（否则上一会话滚上去过就再也不跟了）
  followBottom.value = true
  try {
    const { conversation, messages: stored } = await fetchMessages(id)
    messages.value = toBubbleMessages(stored)
    conversations.value = conversations.value.map((c) => (c.id === id ? conversation : c))
    adoptLiveAnswer(id)
    syncUrlWithConversation(id)
    // 最后一条只有提问、没有回答 → 服务端那一轮还在跑（或刚断），轮询把它捞回来
    maybePollPendingReply(id)
    scrollToBottom()
  } catch (err) {
    ElMessage.error(errorText(err, '加载对话失败'))
  } finally {
    loading.value = false
  }
}

async function removeConversation(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm('删除后这个对话及其全部问答都会消失，无法恢复。确定删除？', '删除对话', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }

  // 删掉的会话不该再在后台跑：中止它的流并把暂存清干净
  if (hasLiveAnswer(id)) abortLiveAnswer(id)
  clearLiveAnswer(id)
  // 服务端那一轮也掐掉（服务端不再因「客户端断开」而中止，必须显式说一声）
  void cancelAskTurn(id)
  if (activeId.value === id) detachLiveAnswer()
  try {
    await deleteConversation(id)
  } catch (err) {
    ElMessage.error(errorText(err, '删除失败，请稍后再试'))
    return
  }

  const rest = conversations.value.filter((c) => c.id !== id)
  conversations.value = rest
  if (activeId.value === id) {
    activeId.value = ''
    messages.value = []
    busy.value = false
    waiting.stop()
    if (rest.length > 0) await selectConversation(rest[0]?.id ?? '')
    else await newConversation({ silent: true })
  }
}

/**
 * 会话相关的失败提示。
 *
 * ⚠️ 2026-10-21（task-20）：后端原文**不再**直接弹给用户 —— 原文里可能带
 *    内部引擎地址、英文堆栈。原文只进 console.warn；弹给用户的一律是
 *    前端本地固定中文（publicErrorText：错误码 → 状态码 → 兜底）。
 */
function errorText(err: unknown, fallback: string): string {
  const axiosErr = err as { response?: { data?: { error?: { message?: string } } } }
  const raw = axiosErr?.response?.data?.error?.message
  if (typeof raw === 'string' && raw.trim()) console.warn('[chat] 会话请求失败：', raw)
  return publicErrorText(err, fallback)
}

/**
 * 中止当前会话的在途回答（换会话/删会话**不再**调它；只留给「重新生成」这类
 * 明确要作废本轮的操作）。
 */
function abortStream(): void {
  const id = activeId.value
  if (id && hasLiveAnswer(id)) abortLiveAnswer(id)
  waiting.stop()
  busy.value = false
  detachLiveAnswer()
}

/**
 * 「停止生成」：用户不要这一轮了。
 *
 * 🔴 2026-10-21（task-21 · T2-7）：后端早就有 POST /api/ask/cancel，
 *    界面上却没有入口 —— 用户只能看着半截正文干等，或干等超时。
 *    现在给一个中文按钮：点了先通知服务端（那一轮别再写正文，
 *    服务端会落一条【已取消】），再本地停流，并让气泡里明确写出「本次提问已取消」。
 */
async function stopGenerating(): Promise<void> {
  const convId = activeId.value
  if (!convId || stopping.value) return
  stopping.value = true
  try {
    await cancelAskTurn(convId)
    const stopped = cancelLiveAnswer(convId, ASK_ERROR_TEXT.aborted)
    if (stopped) {
      ElMessage.info(ASK_ERROR_TEXT.aborted)
    } else {
      ElMessage.info('这一轮刚好已经答完了')
    }
  } finally {
    stopping.value = false
  }
}

/**
 * 发一轮提问。
 *
 * @returns true = 真的发出去了；false = 被拦下了（界面上已经给过提示）
 *
 * 🔴 2026-10-21（task-21 · D1）：门禁原来用 `hasLiveAnswer`（内存里有这条暂存就算），
 *    而暂存在回答**结束后还要留 5 分钟**（切页回来能接上）——
 *    于是「同一会话 5 分钟内问第二句」被当成「还有一条在流」而**静默丢弃**。
 *    现在只拦「真的正在输出」的那一条（isAnswerStreaming），
 *    并且拦下来时必须给用户一句提示，不能悄悄吞掉。
 */
async function send(question: string): Promise<boolean> {
  const q = question.trim()
  if (!q) return false
  if (busy.value) {
    ElMessage.info('这一轮还在回答中，等它说完再发下一句')
    return false
  }
  // 游客额度检查：未登录且（关闭 / 次数用完）时拦住
  if (!guestCanAsk.value) {
    ElMessage.warning('游客今日提问次数已用完，登录后不受限制')
    return false
  }
  // 超长在前端就拦下来（后端也会 400，但让用户白等一轮才知道不合适）
  if (q.length > MAX_QUESTION_LENGTH) {
    ElMessage.warning(`问题太长了，最多 ${MAX_QUESTION_LENGTH} 字，请精简一下再发送`)
    return false
  }
  if (!activeId.value) {
    await newConversation({ silent: true })
    if (!activeId.value) return false
  }

  const conversationId = activeId.value
  // 同一个会话同一时间只允许一条**正在输出**的流（否则两条回答会写进同一串气泡里）。
  // ⚠️ 这里不能用 hasLiveAnswer —— 它对「已结束但还缓存着」的那条也算 true。
  if (isAnswerStreaming(conversationId)) {
    ElMessage.info('这一轮还在回答中，等它说完再发下一句')
    return false
  }

  draft.value = ''
  messages.value.push({ role: 'user', text: q })
  messages.value.push({ role: 'assistant', text: '' })
  const idx = messages.value.length - 1
  streamingIdx.value = idx
  busy.value = true
  waiting.start()
  // 发新问题一定回到底部并恢复跟随（哪怕上一轮用户曾往上滚过）
  followBottom.value = true
  scrollToBottom(true)

  startLiveAnswer({ conversationId, question: q })
  attachLiveAnswer(conversationId, idx)
  return true
}

function syncActiveSummary(question: string): void {
  const id = activeId.value
  if (!id) return
  conversations.value = conversations.value.map((c) => {
    if (c.id !== id) return c
    const isFirstQuestion = c.messageCount === 0
    return {
      ...c,
      title: isFirstQuestion ? question.slice(0, 20) : c.title,
      lastMessage: question.slice(0, 40),
      messageCount: c.messageCount + 2
    }
  })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    // 未登录且游客不可问时，拦住回车并给提示
    if (!guestCanAsk.value) {
      ElMessage.warning('游客今日提问次数已用完，登录后不受限制')
      return
    }
    void send(draft.value)
  }
}

function openSource(url: string): void {
  void router.push(url)
}

/** 打开引用抽屉；给了下标就滚到那一条并高亮 */
function openCitations(msgIndex: number, hit = -1): void {
  citeMsg.value = msgIndex
  citeHit.value = hit
  citeOpen.value = true
  void nextTick(() => {
    const el = document.getElementById(`cite-${hit >= 0 ? hit : 0}`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

/** 正文里的 `<kb doc=… />` 标记不是给人看的，复制前要剥掉 */
function plainAnswer(text: string): string {
  return text
    .replace(/<kb\s+doc="([^"]*)"[^>]*?\/?>/g, '')
    .replace(/【\s*资料名[：:]\s*[^】]+?】/g, '')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

async function copyAnswer(m: BubbleMessage): Promise<void> {
  try {
    await navigator.clipboard.writeText(plainAnswer(m.text))
    ElMessage.success('已复制回答')
  } catch {
    ElMessage.warning('这个浏览器不让自动复制，请手动选中复制')
  }
}

/**
 * 重新生成：把这条回答连同它的提问一起撤掉，用同一个问题再发一次。
 *
 * 🔴 2026-10-21（task-21 · D2）：原来这里是「先截断气泡，再 send」，
 *    而 send 会被「同一会话只允许一条流」的门禁拦下 ——
 *    结果：气泡没了、请求也没发出去（用户只看到一个空会话）。
 *    现在改成**原子**操作：先作废旧的一轮（中止 + 清掉那条 5 分钟缓存），
 *    再撤气泡，再发新一轮；发不出去就把旧气泡放回去，并明确告诉用户。
 */
async function regenerate(index: number): Promise<void> {
  const convId = activeId.value
  const question = messages.value
    .slice(0, index)
    .reverse()
    .find((m) => m.role === 'user')
  if (!question) return
  const q = question.text

  // 重来就是把这一轮作废：先中止仍在跑的那条流，免得两条回答写进同一串气泡
  // ⚠️ 服务端不再因「客户端断开」而中止上游，所以这里要显式调取消接口
  // 🔴 2026-10-21（task-21 复验修正）：取消请求必须**等它回来**再发新一轮。
  //    原来这里是 `void cancelAskTurn(convId)`（不等）——
  //    取消请求与新一轮的提问请求同时在路上，取消请求后到，
  //    就把**刚发出的新一轮自己取消掉**（实测：点「重试」后新回答只吐了半句就变成失败态）。
  //    另外只有「真的还在流」的那一轮才需要取消，已结束的轮次发取消过去纯属添乱。
  if (convId && isAnswerStreaming(convId)) await cancelAskTurn(convId)
  abortStream()
  // 🔴 关键：把「已结束但还留在内存 5 分钟」的那条暂存也清掉，
  //    否则新的一轮会被门禁当成「还有一条在流」而被拦下（D1 的另一半）。
  if (convId) clearLiveAnswer(convId)

  // 撤掉旧气泡 —— 先留个备份，发不出去要能放回去
  const backup = messages.value.slice()
  messages.value = messages.value.slice(0, Math.max(0, index - 1))
  rated.value = {}

  const sent = await send(q)
  if (!sent) {
    messages.value = backup
    ElMessage.error('没能重新发起这次提问，请点「重试」再试一次')
  }
}

/** 相对时间：会话列表要一眼看出「刚聊过」还是「三天前」 */
function relativeTime(iso: string): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const diffSec = Math.floor((Date.now() - then) / 1000)
  if (diffSec < 60) return '刚刚'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)} 天前`
  const d = new Date(then)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function rate(index: number, kind: 'up' | 'down'): void {
  // 只在本页记状态：不写后端，也不弹「已上报」这种不诚实的提示
  const next = { ...rated.value }
  if (next[index] === kind) {
    delete next[index]
    rated.value = next
    ElMessage.info('已取消标记')
    return
  }
  next[index] = kind
  rated.value = next
  ElMessage.success(kind === 'up' ? '已记为有帮助（只在本机记录）' : '已记为没帮助（只在本机记录）')
}

async function shareConversation(): Promise<void> {
  const id = activeId.value
  if (!id) {
    ElMessage.warning('还没有可分享的对话')
    return
  }
  const url = `${window.location.origin}/chat?c=${encodeURIComponent(id)}`
  try {
    await navigator.clipboard.writeText(url)
    ElMessage.success('已复制本机对话链接（仅本机可打开）')
  } catch {
    ElMessage.warning('复制失败，请从地址栏复制链接')
  }
}

/** 引用来源副行：机构 · 年份（字段来自后端，读不到就不显示，不拼「undefined · 年」） */
function sourceMeta(source: AskSource): string {
  const org = (source.org ?? '').trim()
  const year = (source.year ?? '').trim()
  const type = (source.type ?? '').trim()
  return [type, org, year ? `${year} 年` : ''].filter(Boolean).join(' · ')
}

onMounted(async () => {
  window.addEventListener('keydown', onGlobalKeydown)
  void loadGuestLimit()
  void loadGuestUsage()
  void loadAiStatus()

  const incoming = typeof route.query.q === 'string' ? route.query.q.trim() : ''
  if (incoming) {
    pulledKeyword.value = incoming
    draft.value = incoming
  }

  // 分享链接 ?c=<会话 id> → 直接落到那一条对话（别人点开就能看到那条回答）
  const wanted = typeof route.query.c === 'string' ? route.query.c.trim() : ''

  try {
    const items = await listConversations()
    conversations.value = items
    // 有会话还在后台跑（用户是切页回来的）→ 直接回到那一个，接上在途回答
    const liveId = items.find((c) => hasLiveAnswer(c.id))?.id
    if (wanted && items.some((c) => c.id === wanted)) await selectConversation(wanted)
    else if (liveId) await selectConversation(liveId)
    else if (items.length > 0) {
      const first = items[0]
      if (first) await selectConversation(first.id)
    } else {
      await newConversation({ silent: true })
    }
  } catch (err) {
    ElMessage.error(errorText(err, '加载对话列表失败'))
  } finally {
    loading.value = false
  }
})

/** 引用抽屉的 Esc 关闭（QA-CHAT-06）：抽屉是自绘浮层，Esc 是标准退出方式 */
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && citeOpen.value) citeOpen.value = false
}

/**
 * 离开问答页只「摘掉订阅」，不断流也不清暂存：
 * 回答继续在 store 里跑，切回来会由 adoptLiveAnswer 接上。
 */
onUnmounted(() => {
  detachLiveAnswer()
  waiting.stop()
  stopPolling()
  window.removeEventListener('keydown', onGlobalKeydown)
})
</script>

<template>
  <div class="chat-view" :class="{ 'drawer-open': citeOpen }">
    <!-- 左：会话栏（窄屏时是覆盖层抽屉，选中会话/新建后自动收起） -->
    <aside class="rail" :class="{ 'rail-open': railOpen }">
      <div class="rail-head">
        <button type="button" class="newbtn" @click="newConversation()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建对话
        </button>
        <button type="button" class="rail-close" @click="railOpen = false">关闭</button>
      </div>

      <div class="rail-list">
        <p v-if="loading" class="rail-hint">正在加载…</p>
        <template v-else>
          <p v-if="!hasConversation" class="rail-hint">还没有对话，点「新建对话」开始。</p>
          <template v-for="g in convGroups" :key="g.label">
            <p class="rail-grp">{{ g.label }}</p>
            <div v-for="c in g.items" :key="c.id" class="sess" :class="{ on: c.id === activeId }">
              <button type="button" class="sess-btn" @click="selectConversation(c.id)">
                <span class="sess-t">{{ c.title }}</span>
                <span class="sess-time">{{ relativeTime(c.updatedAt) }}</span>
              </button>
              <button
                type="button"
                class="sess-del"
                :aria-label="`删除对话：${c.title}`"
                title="删除对话"
                @click.stop="removeConversation(c.id)"
              >
                ×
              </button>
            </div>
          </template>
        </template>
      </div>
    </aside>

    <!-- 中：对话流 -->
    <section class="main">
      <header class="main-head">
        <button type="button" class="rail-toggle" @click="railOpen = true">会话</button>
        <span class="main-title">{{ activeTitle }}</span>
        <span class="main-tip">引用可点开原文核对</span>
      </header>

      <div ref="bodyRef" class="stream" @scroll.passive="onStreamScroll">
        <!-- 空态：问候 + 示例问题胶囊（照参考产品：居中、留白大） -->
        <div v-if="showHero" class="hello">
          <h2 class="hello-h">Hi，我是零废弃助手</h2>
          <p class="hello-sub">
            关于零废弃、垃圾分类、化学品与健康的问题，都可以问我。<br />
            回答只来自库内资料，每条结论都能点开原文。
          </p>
          <div class="pills">
            <button v-for="q in EXAMPLES" :key="q" type="button" class="pill" @click="send(q)">
              {{ q }}
            </button>
          </div>
          <p v-if="pulledKeyword" class="pulled">
            已把你在资料库里搜的「<strong>{{ pulledKeyword }}</strong>」带过来，可以直接发送，也可以改一改再问。
          </p>
        </div>

        <template v-else>
          <p v-if="loading" class="empty">正在加载对话…</p>

          <div v-for="(m, i) in messages" :key="i" class="turn" :class="m.role">
            <!-- 提问 -->
            <div v-if="m.role === 'user'" class="ask">
              <ChatBubble :message="m" flat />
            </div>

            <!-- 回答：头像 + 平铺正文 + 引用胶囊 + 操作行 -->
            <div v-else class="reply">
              <span class="ava" aria-hidden="true">零</span>
              <div class="rbody">
                <ChatBubble
                  :message="m"
                  flat
                  cite-style="sup"
                  :show-sources="false"
                  :streaming="i === streamingIdx"
                  :waiting="i === streamingIdx && !m.text && !m.failed"
                  :waiting-text="waiting.text.value"
                  @open-cite="(n: number) => openCitations(i, n)"
                  @open-source="openSource"
                />

                <button
                  v-if="!m.failed && !m.noAnswer && m.sources && m.sources.length > 0"
                  type="button"
                  class="citebar"
                  @click="openCitations(i)"
                >
                  <span class="stk" aria-hidden="true"><i></i><i></i><i></i></span>
                  <b>{{ m.sources.length }} 份资料</b>
                  <span class="cv" aria-hidden="true">▾</span>
                </button>

                <div class="acts" :class="{ 'acts-failed': m.failed }">
                  <button v-if="!m.failed" type="button" title="复制回答" @click="copyAnswer(m)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path d="M5 15V5a2 2 0 012-2h10" />
                    </svg>
                  </button>
                  <button type="button" class="retry" title="重新生成" @click="regenerate(i)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M20 11a8 8 0 10-2.6 5.9" />
                      <path d="M20 5v6h-6" />
                    </svg>
                    <span v-if="m.failed" class="retry-t">重试</span>
                  </button>
                  <span v-if="!m.failed" class="sep" aria-hidden="true"></span>
                  <button
                    v-if="!m.failed"
                    type="button"
                    :class="{ on: rated[i] === 'up' }"
                    title="有帮助"
                    @click="rate(i, 'up')"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M7 21V10l5-7 1 1v5h5.2a2 2 0 011.9 2.6l-2 6A2 2 0 0116.2 21H7z" />
                      <path d="M7 10H3v11h4" />
                    </svg>
                  </button>
                  <button
                    v-if="!m.failed"
                    type="button"
                    :class="{ on: rated[i] === 'down' }"
                    title="没帮助"
                    @click="rate(i, 'down')"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M17 3v11l-5 7-1-1v-5H5.8a2 2 0 01-1.9-2.6l2-6A2 2 0 017.8 3H17z" />
                      <path d="M17 14h4V3h-4" />
                    </svg>
                  </button>
                  <button v-if="!m.failed" type="button" title="复制本机对话链接（仅本机可打开）" @click="shareConversation">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <circle cx="18" cy="5" r="2.5" />
                      <circle cx="6" cy="12" r="2.5" />
                      <circle cx="18" cy="19" r="2.5" />
                      <path d="M8.2 10.8l7.6-4.3M8.2 13.2l7.6 4.3" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
          <p v-if="pendingReply" class="pending-note">回答还在生成中…（可以先去别的页面，回来这条还在）</p>
        </template>
      </div>

      <!-- 输入区：常驻底部。2026-10-22 视觉改版：对齐 DeepSeek 输入卡 ——
           无占位说明括号、计数器平时隐藏、右侧圆形发送/停止 -->
      <div class="composer-wrap">
        <div class="composer">
          <textarea
            v-model="draft"
            class="ta"
            rows="1"
            placeholder="发送消息"
            :disabled="busy || !activeId"
            @keydown="onKeydown"
          ></textarea>
          <div class="composer-bar">
            <span v-if="overLimit || nearLimit" class="counter" :class="{ over: overLimit }">{{ draftLength }}/{{ MAX_QUESTION_LENGTH }}</span>
            <div class="composer-actions">
              <!-- 只有一颗按钮：平时 ↑ 发送；生成中原地变成 ■ 停止（DeepSeek 口径） -->
              <button
                v-if="canStop"
                type="button"
                class="send send--stop"
                :disabled="stopping"
                title="停止生成"
                @click="stopGenerating"
              >
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                </svg>
              </button>
              <button
                v-else
                type="button"
                class="send"
                :disabled="!draft.trim() || busy || !activeId || overLimit || !guestCanAsk"
                title="发送"
                @click="send(draft)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <path d="M12 19V5M6 11l6-6 6 6" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <p v-if="aiStatusText" class="ai-warn">{{ aiStatusText }}</p>
        <p v-if="overLimit" class="finep over-tip">问题太长了，最多 {{ MAX_QUESTION_LENGTH }} 字，请精简一下再发送</p>
        <p v-if="guestLimitText" class="finep">{{ guestLimitText }}</p>
        <p class="finep">{{ ASK_SCOPE_NOTE }}；{{ ASK_DISCLAIMER }}</p>
      </div>
    </section>

    <!-- 右：引用来源抽屉（点正文上标或「N 份资料」时打开） -->
    <aside class="drawer" :class="{ open: citeOpen }">
      <div class="drawer-hd">
        <span class="dh-t">引用来源</span>
        <span class="dh-n">{{ citeSources.length }} 份 · 按引用顺序</span>
        <button type="button" class="dh-x" title="关闭" @click="citeOpen = false">×</button>
      </div>
      <div class="drawer-list">
        <p v-if="citeSources.length === 0" class="empty">这份回答没有关联到库内资料。</p>
        <div
          v-for="(s, si) in citeSources"
          :id="`cite-${si}`"
          :key="s.url"
          class="src"
          :class="{ hit: si === citeHit }"
        >
          <div class="src-top">
            <span class="src-no">{{ si + 1 }}</span>
            <div class="src-info">
              <div class="src-t">{{ s.name }}</div>
              <div v-if="sourceMeta(s)" class="src-m">{{ sourceMeta(s) }}</div>
            </div>
          </div>
          <div class="src-ops">
            <button type="button" class="btn" @click="openSource(s.url)">查看详情</button>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* ---- 整页三栏：会话栏 / 对话流 / 引用抽屉（抽屉默认 0 宽，打开时展开） ----
   2026-10-19：改成**全屏工作区**。高度不再自己算 100vh-132px，而是填满
   `.app-main.is-flush`（= 100vh 减顶部导航 64px）；边框、圆角、投影全部去掉，
   否则外层容器留白 + 这张卡片会再叠出一圈「框中之框」。 */
.chat-view {
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr) 0;
  /* 高度由外层全屏容器给（.app-main.is-flush 的确定高度），这里填满它 */
  height: 100%;
  min-height: 0;
  background: var(--zw-surface);
  border: 0;
  border-radius: 0;
  box-shadow: none;
  overflow: hidden;
  transition: grid-template-columns 0.24s ease;
}
.chat-view.drawer-open {
  grid-template-columns: 236px minmax(0, 1fr) 360px;
}

/* ---- 左：会话栏 ---- */
.rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--zw-mint-2);
  border-right: 1px solid var(--zw-line);
}
.rail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 12px 8px;
}
.newbtn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 12px;
  border: 1px solid var(--zw-line-strong);
  border-radius: 999px;
  background: var(--zw-surface);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--zw-green-deep);
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;
}
.newbtn svg {
  width: 14px;
  height: 14px;
}
.newbtn:hover {
  background: var(--zw-mint);
  border-color: var(--zw-green-soft);
}
/* 抽屉的「关闭」只在窄屏出现 */
.rail-close {
  display: none;
  padding: 6px 8px;
  border: 0;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--zw-muted);
  cursor: pointer;
}
.rail-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 8px 12px;
}
.rail-hint {
  margin: 10px 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--zw-muted);
}
.rail-grp {
  margin: 12px 6px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--zw-faint);
}
.sess {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  border-radius: 9px;
  margin-bottom: 1px;
}
.sess:hover {
  background: #eaf2ea;
}
.sess.on {
  background: var(--zw-mint);
}
.sess-btn {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.sess-t {
  font-size: 13px;
  line-height: 1.5;
  color: var(--zw-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sess.on .sess-t {
  font-weight: 600;
  color: var(--zw-green-deep);
}
.sess-time {
  font-size: 11px;
  color: var(--zw-faint);
}
.sess-del {
  flex: 0 0 auto;
  width: 26px;
  align-self: stretch;
  border: 0;
  background: none;
  font-size: 15px;
  line-height: 1;
  color: var(--zw-faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.16s ease, color 0.16s ease;
}
.sess:hover .sess-del,
.sess-del:focus-visible {
  opacity: 1;
}
.sess-del:hover {
  color: var(--zw-danger);
}
/* QA-CHAT-11：触屏上永远看不到 hover —— 移动端把删除钮永久可见已做（1690 处 opacity:1），
   桌面端给触屏指针也补一个替代表示（不依赖 hover） */
@media (pointer: coarse) and (min-width: 861px) {
  .sess-del {
    opacity: 1;
  }
}

/* ---- 中：对话流 ---- */
.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.main-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 13px 20px;
  border-bottom: 1px solid var(--zw-line);
}
.main-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--zw-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.main-tip {
  font-size: 12px;
  color: var(--zw-faint);
  white-space: nowrap;
}
/* 窄屏才出现的会话入口 */
.rail-toggle {
  display: none;
  padding: 4px 10px;
  border: 1px solid var(--zw-line);
  border-radius: 999px;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--zw-green-deep);
  cursor: pointer;
}
.stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 22px 24px 8px;
}
.empty {
  margin: 24px 0;
  text-align: center;
  font-size: 13px;
  color: var(--zw-muted);
}

/* ---- 空态 ---- */
.hello {
  max-width: 720px;
  margin: 8vh auto 0;
  text-align: center;
}
.hello-h {
  margin: 0 0 10px;
  font-size: 26px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--zw-ink);
}
/* 用品牌绿压住重点词，别整句变色 */
.hello-sub {
  margin: 0 0 26px;
  font-size: 14px;
  line-height: 1.9;
  color: var(--zw-muted);
}
.pills {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}
.pill {
  padding: 9px 16px;
  border: 1px solid var(--zw-line);
  border-radius: 999px;
  background: var(--zw-mint-2);
  font: inherit;
  font-size: 13px;
  color: var(--zw-ink);
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease, transform 0.16s ease;
}
.pill:hover {
  background: var(--zw-mint);
  border-color: var(--zw-green-soft);
  transform: translateY(-1px);
}
.pulled {
  margin: 18px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--zw-muted);
}
.pulled strong {
  color: var(--zw-green-deep);
}

/* ---- 一轮对话 ---- */
.turn {
  max-width: 780px;
  margin: 0 auto 26px;
}
.turn.user {
  display: flex;
  justify-content: flex-end;
}
.ask {
  max-width: min(74%, 620px);
}
.reply {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.ava {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  margin-top: 2px;
  border-radius: 9px;
  background: var(--zw-mint);
  color: var(--zw-green-deep);
  font-size: 13px;
  font-weight: 700;
  line-height: 28px;
  text-align: center;
}
.rbody {
  flex: 1;
  min-width: 0;
}
/* 正文排版：对话页比首页挂件大一档 */
.rbody :deep(.bubble) {
  font-size: 14.5px;
  line-height: 1.85;
  color: var(--zw-text);
}
.rbody :deep(.md h1),
.rbody :deep(.md h2) {
  font-size: 16px;
}
.rbody :deep(.md h3) {
  font-size: 15px;
}
/* 「N 份资料」胶囊 */
.citebar {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 14px;
  padding: 6px 12px 6px 9px;
  border: 1px solid var(--zw-line-strong);
  border-radius: 999px;
  background: var(--zw-surface);
  font: inherit;
  font-size: 12.5px;
  color: var(--zw-muted);
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}
.citebar b {
  font-weight: 600;
  color: var(--zw-green-deep);
}
.citebar:hover {
  background: var(--zw-mint-2);
  border-color: var(--zw-green-soft);
}
/* 三张叠起来的小纸片，示意「多份」 */
.stk {
  display: inline-flex;
}
.stk i {
  width: 11px;
  height: 14px;
  border: 1px solid var(--zw-green-soft);
  border-radius: 3px;
  background: var(--zw-mint);
}
.stk i + i {
  margin-left: -5px;
}
.cv {
  font-size: 10px;
  color: var(--zw-faint);
}
/* 操作行 */
.acts {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 8px;
}
.acts button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: none;
  color: var(--zw-faint);
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}
.acts button svg {
  width: 15px;
  height: 15px;
}
.acts button:hover {
  background: var(--zw-mint-2);
  color: var(--zw-green-deep);
}
.acts button.on {
  background: var(--zw-mint);
  color: var(--zw-green-deep);
}
.acts .sep {
  width: 1px;
  height: 14px;
  margin: 0 5px;
  background: var(--zw-line);
}

/* ---- 输入区（2026-10-22 DeepSeek 版）：大圆角白卡、无边内框、按钮全收在右侧 ---- */
.composer-wrap {
  padding: 4px 24px 10px;
}
.composer {
  max-width: 860px;
  margin: 0 auto;
  padding: 12px 14px 10px;
  border: 1px solid var(--zw-line-strong);
  border-radius: 24px;
  background: var(--zw-surface);
  box-shadow: var(--zw-shadow-sm);
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}
.composer:focus-within {
  border-color: var(--zw-green-soft);
  box-shadow: 0 0 0 3px rgba(46, 125, 50, 0.08);
}
.ta {
  display: block;
  width: 100%;
  max-height: 168px;
  min-height: 52px;
  padding: 4px 6px;
  border: 0;
  background: none;
  font: inherit;
  font-size: 15px;
  line-height: 1.7;
  color: var(--zw-ink);
  resize: none;
  outline: none;
}
.ta::placeholder {
  color: var(--zw-faint);
}
.composer-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 6px;
}
/* 计数器平时藏起来，接近上限才出现（DeepSeek 口径） */
.counter {
  margin-right: auto;
  font-size: 11.5px;
  color: var(--zw-muted);
  font-variant-numeric: tabular-nums;
}
.counter.over {
  color: var(--zw-danger, #c0392b);
  font-weight: 600;
}
.composer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}
.send {
  margin-left: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px; /* QA-ALL-03 热区：32→36，触屏仍与 composer-bar 行高匹配 */
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--zw-green);
  color: #fff;
  cursor: pointer;
  transition: background 0.16s ease, opacity 0.16s ease;
}
.send svg {
  width: 17px;
  height: 17px;
}
.send:hover:not(:disabled) {
  background: var(--zw-green-deep);
}
.send:disabled {
  background: var(--zw-line-strong);
  color: #fff;
  cursor: not-allowed;
}
/* QA-ALL-01：键盘可达 —— 按钮补焦点态（textarea 不描边，见下） */
.send:focus-visible {
  outline: 2px solid var(--zw-green);
  outline-offset: 2px;
}
.ta:focus-visible {
  outline: none; /* DeepSeek 口径：textarea 自身不描边，聚焦只亮外卡 */
}
/* 生成中的同一颗按钮原地变「停止」：深底白方块，尺寸位置与发送完全一致 */
.send--stop {
  background: var(--zw-green-deep);
}
.send--stop svg {
  width: 15px;
  height: 15px;
}
.finep {
  max-width: 780px;
  margin: 6px auto 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--zw-muted); /* QA-CHAT-01：faint #93a396 on 白 ≈2.6:1 不达标，muted ≈4.9:1 */
  text-align: center;
}

/* ---- 右：引用来源抽屉 ---- */
.drawer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--zw-line);
  background: var(--zw-mint-2);
  overflow: hidden;
  visibility: hidden;
}
.drawer.open {
  visibility: visible;
}
.drawer-hd {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 14px 12px 16px;
}
.dh-t {
  font-size: 13px;
  font-weight: 600;
  color: var(--zw-ink);
}
.dh-n {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--zw-faint);
}
.dh-x {
  align-self: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 7px;
  background: none;
  font-size: 16px;
  line-height: 1;
  color: var(--zw-muted);
  cursor: pointer;
}
.dh-x:hover {
  background: var(--zw-mint);
  color: var(--zw-ink);
}
.dh-x:focus-visible {
  outline: 2px solid var(--zw-green);
  outline-offset: 2px;
}
.drawer-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px 14px;
}
.src {
  padding: 11px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--zw-line);
  border-radius: 12px;
  background: var(--zw-surface);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
/* 从上标点开的那一条：描边提亮，眼睛能立刻找到 */
.src.hit {
  border-color: var(--zw-green-soft);
  box-shadow: 0 0 0 3px rgba(46, 125, 50, 0.08);
}
.src-top {
  display: flex;
  gap: 9px;
  align-items: flex-start;
}
.src-no {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 5px;
  background: var(--zw-mint);
  color: var(--zw-green-deep);
  font-size: 10.5px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
}
.src-info {
  min-width: 0;
}
.src-t {
  font-size: 13px;
  line-height: 1.55;
  color: var(--zw-ink);
  word-break: break-word;
}
.src-m {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--zw-faint);
}
.src-ops {
  display: flex;
  gap: 8px;
  margin-top: 9px;
}
.btn {
  padding: 4px 11px;
  border: 1px solid var(--zw-line-strong);
  border-radius: 999px;
  background: var(--zw-surface);
  font: inherit;
  font-size: 12px;
  color: var(--zw-green-deep);
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;
}
.btn:hover {
  background: var(--zw-mint);
  border-color: var(--zw-green-soft);
}

/* ---- 窄屏（≤860px）：会话栏变覆盖层，引用抽屉改右侧浮层 ---- */
@media (max-width: 860px) {
  .chat-view,
  .chat-view.drawer-open {
    grid-template-columns: minmax(0, 1fr);
    /* 手机：高度同样由外层全屏容器给，对话流内部滚动 —— 否则输入框被挤到
       页面最底下，还得先滚到页尾才能打字。本页底部那条常驻导航已隐藏
       （见 SiteNav 的 atFullBleed），外层也不用再扣它的高度。 */
    height: 100%;
    min-height: 0;
  }
  .rail {
    position: fixed;
    inset: 0;
    z-index: 150;
    border-right: 0;
    transform: translateX(-100%);
    visibility: hidden;
    transition: transform 0.2s ease, visibility 0.2s ease;
  }
  .rail.rail-open {
    transform: translateX(0);
    visibility: visible;
  }
  .rail-close {
    display: block;
  }
  .sess-del {
    opacity: 1;
  }
  .rail-toggle {
    display: inline-flex;
  }
  .main-tip {
    display: none;
  }
  .stream {
    padding: 16px 14px 6px;
  }
  .hello {
    margin-top: 4vh;
  }
  .hello-h {
    font-size: 22px;
  }
  .turn {
    margin-bottom: 22px;
  }
  .ask {
    max-width: 86%;
  }
  .composer-wrap {
    padding: 4px 14px 10px;
  }
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(88vw, 360px);
    z-index: 160;
    border-left: 1px solid var(--zw-line);
    box-shadow: -12px 0 32px rgba(22, 36, 26, 0.14);
    transform: translateX(100%);
    transition: transform 0.22s ease;
  }
  .drawer.open {
    transform: translateX(0);
  }
  .drawer-hd {
    padding-top: 14px;
  }
}

/* ---- 2026-10-21 新增：字数计数已并入输入区样式；此处保留超长提示/公告/失败重试 ---- */
.over-tip {
  color: var(--zw-danger, #c0392b);
}
.ai-warn {
  max-width: 780px;
  margin: 0 auto 6px;
  padding: 7px 12px;
  border-radius: 10px;
  background: rgba(192, 57, 43, 0.08);
  color: var(--zw-danger, #c0392b);
  font-size: 12.5px;
  line-height: 1.6;
}
.pending-note {
  margin: 8px auto 0;
  font-size: 12.5px;
  color: var(--zw-faint);
  text-align: center;
}
.acts-failed .retry-t {
  margin-left: 4px;
  font-size: 12px;
  color: var(--zw-green);
  white-space: nowrap; /* 「重试」不许被压成竖排 */
}
.acts-failed .retry {
  display: inline-flex;
  align-items: center;
}
</style>
