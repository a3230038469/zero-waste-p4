<script setup lang="ts">
/**
 * AI 问答独立页 —— T5
 *
 * 布局：左会话列表 / 右对话流。会话**存数据库**（后端 /api/chat），刷新页面画面原样回来。
 * 渲染与来源卡片复用 T4 的实现（ChatBubble.vue），等待文案轮换复用 useWaitingLines，
 * 与首页右下角气泡共用同一份 —— 复制两份必然漂移。
 *
 * 关键约束：
 *   - 前端只调自建后端（localhost:4000），引擎密钥永不进前端（铁律 2）
 *   - 提问带 conversationId = 接着聊；不带 = 一次性（本页没有不带的情况）
 *   - 删会话 = 真删数据库记录，不是本地隐藏（刷新后不会再冒出来）
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import ChatBubble, { type BubbleMessage } from '../components/ChatBubble.vue'
import { useWaitingLines } from '../composables/useWaitingLines'
import { askStream } from '../api/ask'
import {
  createConversation,
  deleteConversation,
  fetchMessages,
  listConversations,
  type ConversationSummary
} from '../api/chat'

const router = useRouter()

/** 会话列表（后端已按最近活动倒序） */
const conversations = ref<ConversationSummary[]>([])
/** 当前选中会话的 id；null = 还没建/还没选中 */
const activeId = ref<string>('')
/** 当前会话的对话流（消息结构复用气泡组件的 BubbleMessage） */
const messages = ref<BubbleMessage[]>([])
const draft = ref('')
const busy = ref(false)
const loading = ref(true)
/** 正在流式输出的那条消息的下标：只有它 display streaming，结束后段落动画才触发 */
const streamingIdx = ref(-1)
const bodyRef = ref<HTMLElement | null>(null)
const inputRef = ref<{ focus: () => void } | null>(null)

/** 顶栏显示的会话名（没选中时给个中性的说法，不显示 undefined） */
const activeTitle = computed(
  () => conversations.value.find((c) => c.id === activeId.value)?.title ?? 'AI 问答'
)

/** 新建/切换后把焦点交给输入框：省一次鼠标点击，是这类页面最值钱的小细节 */
function focusInput(): void {
  void nextTick(() => inputRef.value?.focus())
}

let controller: AbortController | null = null

/** 等待文案轮换（与首页气泡共用同一份策略，各自独立计时） */
const waiting = useWaitingLines()

/** 空面板时的快捷问题 */
const EXAMPLES = ['厨余垃圾怎么处理？', '什么是零废弃？', '社区堆肥需要注意什么？']

/** 有会话才显示对话框；一个都没有时给引导（别摆一个空输入框让人不知从哪下手） */
const hasConversation = computed(() => conversations.value.length > 0)

function scrollToBottom(): void {
  void nextTick(() => {
    const el = bodyRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

/** 建一个新会话并选中（列表为空时页面自动调一次，用户点「新建对话」也调） */
async function newConversation(options: { silent?: boolean } = {}): Promise<void> {
  try {
    const conv = await createConversation()
    conversations.value = [conv, ...conversations.value]
    activeId.value = conv.id
    messages.value = []
    // 引擎没就绪不提示：后端会在首次提问时懒建，提示了只会让人以为坏了
    if (!options.silent) ElMessage.success('已新建对话')
    focusInput()
  } catch (err) {
    if (!options.silent) ElMessage.error(errorText(err, '新建对话失败，请稍后再试'))
  }
}

/** 切换会话：拉历史消息把画面恢复出来 */
async function selectConversation(id: string): Promise<void> {
  if (id === activeId.value) return
  // 切换时把上一轮还没跑完的流掐掉，否则它会把答案写进**新**会话的气泡里
  abortStream()
  activeId.value = id
  loading.value = true
  messages.value = []
  try {
    const { conversation, messages: stored } = await fetchMessages(id)
    messages.value = stored.map((m) => ({
      role: m.role,
      text: m.content,
      ...(m.sources.length > 0 ? { sources: m.sources } : {})
    }))
    // 会话列表里这条的摘要/条数可能已被别的标签页更新过，用后端回来的覆盖
    conversations.value = conversations.value.map((c) => (c.id === id ? conversation : c))
    scrollToBottom()
  } catch (err) {
    ElMessage.error(errorText(err, '加载对话失败'))
  } finally {
    loading.value = false
  }
}

/** 删会话：确认弹窗 → 真删 → 刷新列表。删掉的是当前会话就自动落到相邻那个。 */
async function removeConversation(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '删除后这个对话及其全部问答都会消失，无法恢复。确定删除？',
      '删除对话',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    return // 用户点了取消
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
    if (rest.length > 0) {
      await selectConversation(rest[0]?.id ?? '')
    } else {
      // 删光了自动补一个空会话，页面不至于变成一块空白
      await newConversation({ silent: true })
    }
  }
}

/** 把后端/网络错误转成一句能给人看的中文 */
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

/** 发一问：先落两个气泡，再把流里的 answer 逐字填进回复气泡 */
async function send(question: string): Promise<void> {
  const q = question.trim()
  if (!q || busy.value) return

  // 没选中会话（理论不该发生：页面保证至少有一个）就先补一个
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
          waiting.stop() // 出第一个字就停，不闪
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
      msg.failed = true
      msg.text = 'AI 没有返回内容，请稍后再试'
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
    // 段落浮现动画在 streaming 归 false 的那一刻触发
    streamingIdx.value = -1
    scrollToBottom()
    // 本地摘要先更新，侧栏不用等下一次拉列表才刷新；后端权威值仍在下次 list 时覆盖
    syncActiveSummary(q)
  }
}

/** 用刚落库的这条提问更新侧栏摘要（标题也可能被后端改成了首问） */
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

onMounted(async () => {
  try {
    const items = await listConversations()
    conversations.value = items
    if (items.length > 0) {
      // 默认打开最近聊的那个：用户回来就想接着上次聊
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
  <div class="chat-view">
    <!-- 左：会话列表 -->
    <aside class="side">
      <div class="side-head">
        <span class="side-title">我的对话</span>
        <el-button type="primary" size="small" @click="newConversation()">新建</el-button>
      </div>

      <p v-if="loading" class="side-hint">正在加载…</p>
      <p v-else-if="!hasConversation" class="side-hint">还没有对话，点「新建」开始。</p>

      <ul v-else class="conv-list">
        <li
          v-for="c in conversations"
          :key="c.id"
          class="conv"
          :class="{ active: c.id === activeId }"
        >
          <button type="button" class="conv-main" @click="selectConversation(c.id)">
            <span class="conv-title">{{ c.title }}</span>
            <span class="conv-sub">
              <span class="conv-time">{{ relativeTime(c.updatedAt) }}</span>
              <span class="conv-count">{{ c.messageCount }} 条</span>
            </span>
            <span v-if="c.lastMessage" class="conv-preview">{{ c.lastMessage }}</span>
          </button>
          <button
            type="button"
            class="conv-del"
            :aria-label="`删除对话：${c.title}`"
            title="删除对话"
            @click="removeConversation(c.id)"
          >
            ×
          </button>
        </li>
      </ul>
    </aside>

    <!-- 右：对话流 -->
    <section class="main">
      <header class="main-head">
        <span class="main-title">{{ activeTitle }}</span>
        <span class="main-tip">答案只从零废弃知识库里找，引用可点开原文</span>
      </header>

      <div ref="bodyRef" class="stream">
        <p v-if="loading" class="empty">正在加载对话…</p>
        <p v-else-if="messages.length === 0" class="empty">
          问一句试试，比如「厨余垃圾怎么处理？」<br />
          <span class="empty-sub">在同一个对话里追问，AI 会记得你前面说过什么。</span>
        </p>

        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <ChatBubble
            :message="m"
            :streaming="i === streamingIdx"
            :waiting="i === streamingIdx && !m.text && !m.failed"
            :waiting-text="waiting.text.value"
            @open-source="openSource"
          />
        </div>
      </div>

      <div v-if="messages.length === 0 && !loading" class="examples">
        <el-button v-for="q in EXAMPLES" :key="q" link size="small" @click="send(q)">
          {{ q }}
        </el-button>
      </div>

      <div class="foot">
        <el-input
          ref="inputRef"
          v-model="draft"
          placeholder="输入问题，回车发送"
          :disabled="busy || !activeId"
          @keydown="onKeydown"
        />
        <el-button
          type="primary"
          :loading="busy"
          :disabled="!draft.trim() || !activeId"
          @click="send(draft)"
        >
          发送
        </el-button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.chat-view {
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr);
  gap: 16px;
  align-items: stretch;
  /* 撑满可用高度：对话流内部滚动，页面本身不滚 */
  height: calc(100vh - 132px);
  min-height: 480px;
}

/* ---- 左：会话列表 ---- */
.side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--zw-surface);
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  box-shadow: var(--zw-shadow-sm);
  overflow: hidden;
}
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--zw-line);
}
.side-title {
  font-weight: 600;
  color: var(--zw-green-deep);
  font-size: var(--zw-fs-sm);
}
.side-hint {
  margin: 0;
  padding: 14px;
  font-size: var(--zw-fs-sm);
  line-height: 1.7;
  color: var(--zw-muted);
}
.conv-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 6px;
  list-style: none;
}
.conv {
  position: relative;
  display: flex;
  align-items: stretch;
  border-radius: var(--zw-radius-sm);
  margin-bottom: 2px;
}
.conv:hover {
  background: var(--zw-mint-2);
}
.conv.active {
  background: var(--zw-mint);
}
.conv-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 10px;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: var(--zw-radius-sm);
}
.conv-title {
  font-size: var(--zw-fs-sm);
  font-weight: 600;
  color: var(--zw-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color var(--zw-dur-fast) var(--zw-ease);
}
/* 父级 .conv:hover 已给整行换底色，这里再让标题变主色，悬停指向更明确 */
.conv-main:hover .conv-title {
  color: var(--zw-green-deep);
}
.conv-sub {
  display: flex;
  gap: 8px;
  font-size: var(--zw-fs-xs);
  color: var(--zw-faint);
}
.conv-preview {
  font-size: var(--zw-fs-xs);
  line-height: 1.5;
  color: var(--zw-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 删除按钮平时隐去，hover 会话时才出现：侧栏默认只展示，不摆一列删除符号 */
.conv-del {
  flex: 0 0 auto;
  width: 28px;
  border: 0;
  background: none;
  font-size: var(--zw-fs-body);
  line-height: 1;
  color: var(--zw-faint);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.16s ease,
    color 0.16s ease;
}
.conv:hover .conv-del,
.conv-del:focus-visible {
  opacity: 1;
}
.conv-del:hover {
  color: var(--zw-danger);
}

/* ---- 右：对话流 ---- */
.main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--zw-surface);
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  box-shadow: var(--zw-shadow-sm);
  overflow: hidden;
}
.main-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--zw-line);
}
.main-title {
  font-weight: 600;
  color: var(--zw-ink);
}
.main-tip {
  font-size: var(--zw-fs-xs);
  color: var(--zw-faint);
}
.stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px;
}
.empty {
  margin: 32px 0;
  text-align: center;
  font-size: var(--zw-fs-sm);
  line-height: 1.9;
  color: var(--zw-muted);
}
.empty-sub {
  font-size: var(--zw-fs-sm);
  color: var(--zw-faint);
}
.msg {
  display: flex;
  margin-bottom: 10px;
}
.msg.user {
  justify-content: flex-end;
}
/* 气泡自身有 max-width:86%，这里再放宽一点：独立页比首页气泡宽得多，卡太窄反而难读 */
.msg :deep(.bubble) {
  max-width: min(92%, 760px);
  font-size: var(--zw-fs-sm);
  line-height: 1.8;
}
.msg.user :deep(.bubble) {
  max-width: min(78%, 640px);
}
.examples {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  padding: 0 18px 8px;
}
.foot {
  display: flex;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--zw-line);
}

/* ---- 窄屏：侧栏收到上方变成横向可滚条，对话流占满下方 ---- */
@media (max-width: 860px) {
  .chat-view {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    height: auto;
  }
  .side {
    max-height: 168px;
  }
  .conv-list {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .conv {
    flex: 0 0 200px;
    margin-bottom: 0;
  }
  .conv-del {
    opacity: 1; /* 触屏没有 hover，删除按钮必须常驻 */
  }
  .stream {
    min-height: 52vh;
  }
}
</style>
