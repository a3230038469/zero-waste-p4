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
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import ChatBubble, { type BubbleMessage } from '../components/ChatBubble.vue'
import { useWaitingLines } from '../composables/useWaitingLines'
import { useAuth } from '../composables/useAuth'
import { askStream } from '../api/ask'
import type { AskSource } from '../api/ask'
import { fetchGuestPermissions } from '../api/guest'
import { ASK_DISCLAIMER, ASK_SCOPE_NOTE, NO_ANSWER_TEXT } from '../utils/askCopy'
import {
  createConversation,
  deleteConversation,
  fetchMessages,
  listConversations,
  type ConversationSummary
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

/** 访客每日可提问次数的提示（数字只有一个来源：后端真实返回） */
const guestLimitText = computed(() => {
  if (isLoggedIn.value || !guestAiOpen.value) return ''
  const limit = guestDailyLimit.value
  if (limit === null || limit <= 0) return ''
  return `游客每天可提问 ${limit} 次，登录后不受此限制`
})

async function loadGuestLimit(): Promise<void> {
  if (isLoggedIn.value) return
  const payload = await fetchGuestPermissions()
  if (!payload.success) return
  guestAiOpen.value = payload.values.aiAsk
  guestDailyLimit.value = payload.values.aiAskDailyLimit
}

function scrollToBottom(): void {
  void nextTick(() => {
    const el = bodyRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

/** 与样式断点保持一致 */
function isNarrowScreen(): boolean {
  return window.matchMedia('(max-width: 860px)').matches
}

let controller: AbortController | null = null

/** 等待文案轮换（与首页挂件共用同一份策略） */
const waiting = useWaitingLines()

async function newConversation(options: { silent?: boolean } = {}): Promise<void> {
  try {
    const conv = await createConversation()
    conversations.value = [conv, ...conversations.value]
    activeId.value = conv.id
    messages.value = []
    citeOpen.value = false
    if (isNarrowScreen()) railOpen.value = false
    if (!options.silent) ElMessage.success('已新建对话')
  } catch (err) {
    if (!options.silent) ElMessage.error(errorText(err, '新建对话失败，请稍后再试'))
  }
}

async function selectConversation(id: string): Promise<void> {
  if (isNarrowScreen()) railOpen.value = false
  if (id === activeId.value) return
  // 切换时把上一轮还没跑完的流掐掉，否则答案会写进**新**会话的气泡里
  abortStream()
  activeId.value = id
  loading.value = true
  messages.value = []
  citeOpen.value = false
  try {
    const { conversation, messages: stored } = await fetchMessages(id)
    messages.value = stored.map((m) => ({
      role: m.role,
      text: m.content,
      ...(m.sources.length > 0 ? { sources: m.sources } : {})
    }))
    conversations.value = conversations.value.map((c) => (c.id === id ? conversation : c))
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

  abortStream()
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
    if (rest.length > 0) await selectConversation(rest[0]?.id ?? '')
    else await newConversation({ silent: true })
  }
}

function errorText(err: unknown, fallback: string): string {
  const axiosErr = err as { response?: { data?: { error?: { message?: string } } } }
  const message = axiosErr?.response?.data?.error?.message
  return typeof message === 'string' && message.trim() ? message : fallback
}

function abortStream(): void {
  controller?.abort()
  controller = null
  busy.value = false
  streamingIdx.value = -1
  waiting.stop()
}

async function send(question: string): Promise<void> {
  const q = question.trim()
  if (!q || busy.value) return
  if (!activeId.value) {
    await newConversation({ silent: true })
    if (!activeId.value) return
  }

  draft.value = ''
  messages.value.push({ role: 'user', text: q })
  messages.value.push({ role: 'assistant', text: '' })
  const idx = messages.value.length - 1
  streamingIdx.value = idx
  busy.value = true
  waiting.start()
  scrollToBottom()

  controller = new AbortController()
  try {
    await askStream({
      query: q,
      conversationId: activeId.value,
      signal: controller.signal,
      onEvent: (evt) => {
        const msg = messages.value[idx]
        if (!msg) return
        if (evt.type === 'answer') {
          waiting.stop()
          msg.text += evt.content
          scrollToBottom()
        } else if (evt.type === 'sources') {
          msg.sources = evt.items
        } else if (evt.type === 'error') {
          waiting.stop()
          msg.failed = true
          msg.text = msg.text || evt.content || 'AI 暂时不可用'
        }
      }
    })
    const msg = messages.value[idx]
    if (msg && !msg.text) {
      msg.noAnswer = true
      msg.text = NO_ANSWER_TEXT
    }
  } catch (err) {
    const msg = messages.value[idx]
    if (msg) {
      msg.failed = true
      msg.text = errorText(err, '请求失败，请稍后再试')
    }
  } finally {
    waiting.stop()
    busy.value = false
    controller = null
    streamingIdx.value = -1
    scrollToBottom()
    syncActiveSummary(q)
  }
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

/** 重新生成：把这条回答连同它的提问一起撤掉，用同一个问题再发一次 */
async function regenerate(index: number): Promise<void> {
  if (busy.value) return
  const question = messages.value
    .slice(0, index)
    .reverse()
    .find((m) => m.role === 'user')
  if (!question) return
  const q = question.text
  messages.value = messages.value.slice(0, Math.max(0, index - 1))
  rated.value = {}
  await send(q)
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
  if (next[index] === kind) delete next[index]
  else next[index] = kind
  rated.value = next
}

async function shareConversation(): Promise<void> {
  try {
    await navigator.clipboard.writeText(window.location.href)
    ElMessage.success('对话链接已复制')
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
  void loadGuestLimit()

  const incoming = typeof route.query.q === 'string' ? route.query.q.trim() : ''
  if (incoming) {
    pulledKeyword.value = incoming
    draft.value = incoming
  }

  try {
    const items = await listConversations()
    conversations.value = items
    if (items.length > 0) {
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

      <div ref="bodyRef" class="stream">
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
                  v-if="m.sources && m.sources.length > 0"
                  type="button"
                  class="citebar"
                  @click="openCitations(i)"
                >
                  <span class="stk" aria-hidden="true"><i></i><i></i><i></i></span>
                  <b>{{ m.sources.length }} 份资料</b>
                  <span class="cv" aria-hidden="true">▾</span>
                </button>

                <div v-if="!m.failed" class="acts">
                  <button type="button" title="复制回答" @click="copyAnswer(m)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path d="M5 15V5a2 2 0 012-2h10" />
                    </svg>
                  </button>
                  <button type="button" title="重新生成" @click="regenerate(i)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M20 11a8 8 0 10-2.6 5.9" />
                      <path d="M20 5v6h-6" />
                    </svg>
                  </button>
                  <span class="sep" aria-hidden="true"></span>
                  <button
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
                  <button type="button" title="分享（复制对话链接）" @click="shareConversation">
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
        </template>
      </div>

      <!-- 输入区：常驻底部 -->
      <div class="composer-wrap">
        <div class="composer">
          <textarea
            v-model="draft"
            class="ta"
            rows="2"
            placeholder="发送消息（回车发送，Shift + 回车换行）"
            :disabled="busy || !activeId"
            @keydown="onKeydown"
          ></textarea>
          <div class="composer-bar">
            <span class="scope">检索范围：全部资料</span>
            <button
              type="button"
              class="send"
              :disabled="!draft.trim() || busy || !activeId"
              title="发送"
              @click="send(draft)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M12 19V5M6 11l6-6 6 6" />
              </svg>
            </button>
          </div>
        </div>
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

/* ---- 输入区 ---- */
.composer-wrap {
  padding: 4px 24px 10px;
}
.composer {
  max-width: 780px;
  margin: 0 auto;
  padding: 10px 12px 8px;
  border: 1px solid var(--zw-line-strong);
  border-radius: 16px;
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
  min-height: 48px;
  padding: 2px 4px;
  border: 0;
  background: none;
  font: inherit;
  font-size: 14.5px;
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
  padding-top: 4px;
}
.scope {
  font-size: 12px;
  color: var(--zw-muted);
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--zw-mint-2);
}
.send {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--zw-green);
  color: #fff;
  cursor: pointer;
  transition: background 0.16s ease, opacity 0.16s ease;
}
.send svg {
  width: 16px;
  height: 16px;
}
.send:hover:not(:disabled) {
  background: var(--zw-green-deep);
}
.send:disabled {
  background: var(--zw-line-strong);
  color: #fff;
  cursor: not-allowed;
}
.finep {
  max-width: 780px;
  margin: 6px auto 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--zw-faint);
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
</style>
