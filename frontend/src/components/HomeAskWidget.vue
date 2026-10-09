<script setup lang="ts">
/**
 * 右下角 AI 问答窗口 —— 负责人：瑞泽（B07）
 *
 * 本地演示版（2026-10-08）改造说明：
 *   原实现走 WeKnora 官方嵌入挂件，但挂件依赖的换钥匙接口 POST /api/embed/token
 *   尚未实现（B08 空壳），导致窗口点开是空的。
 *   现改为直连自建后端 POST /api/ask（SSE 流式逐字回吐），复用 api/ask.ts。
 *   对外接口不变（askWith / v-model:open），父组件（首页）无需改动。
 * 访客免注册可问。
 */
import { nextTick, ref, watch } from 'vue'

import { askStream } from '../api/ask'

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  /** 出错的气泡（额度/网络/引擎不可用），文案用警示色 */
  failed?: boolean
}

const emit = defineEmits<{
  /** 状态变化，便于父组件联动（如禁用示例问题按钮） */
  (e: 'status-change', status: string): void
}>()

const panelOpen = defineModel<boolean>('open', { default: false })

const messages = ref<ChatMessage[]>([])
const draft = ref('')
const busy = ref(false)
const bodyRef = ref<HTMLElement | null>(null)
let controller: AbortController | null = null

/** 空面板时的快捷问题（点了直接问） */
const EXAMPLES = ['厨余垃圾怎么处理？', '什么是零废弃？', '社区堆肥需要注意什么？']

/**
 * 知识库引用标签（<kb doc="…" chunk_id="…" kb_id="…" />）对读者太吵，
 * 渲染时去掉；顺带压掉替换后留下的多余空行。
 */
const SOURCE_TAG = /<kb\s+doc="[^"]*"[^>]*\/?>/g
function renderAnswer(text: string): string {
  return text
    .replace(SOURCE_TAG, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
}

function scrollToBottom(): void {
  void nextTick(() => {
    const el = bodyRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

/** 发一问：先落两个气泡，再把流里的 answer 逐字填进回复气泡 */
async function send(question: string): Promise<void> {
  const q = question.trim()
  if (!q || busy.value) return

  panelOpen.value = true
  draft.value = ''
  messages.value.push({ role: 'user', text: q })
  messages.value.push({ role: 'assistant', text: '' })
  const idx = messages.value.length - 1
  busy.value = true
  scrollToBottom()

  controller = new AbortController()
  try {
    await askStream({
      query: q,
      signal: controller.signal,
      onEvent: (evt) => {
        const msg = messages.value[idx]
        if (!msg) return
        if (evt.type === 'answer') {
          msg.text += evt.content
          scrollToBottom()
        } else if (evt.type === 'error') {
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
      msg.text = err instanceof Error ? err.message : '请求失败，请稍后再试'
    }
  } finally {
    busy.value = false
    controller = null
    scrollToBottom()
  }
}

/** 供父组件调用：首页示例问题点击后直接提问 */
async function askWith(question: string): Promise<void> {
  await send(question)
}

function togglePanel(): void {
  panelOpen.value = !panelOpen.value
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send(draft.value)
  }
}

defineExpose({ askWith })

watch(busy, (b) => emit('status-change', b ? 'loading' : 'ready'), { immediate: true })
</script>

<template>
  <div class="ask-widget">
    <!-- 展开面板 -->
    <transition name="pop">
      <section v-show="panelOpen" class="ask-panel" role="dialog" aria-label="AI 问答">
        <header class="ask-head">
          <span class="ask-title">AI 助手</span>
          <el-button link size="small" @click="panelOpen = false">收起</el-button>
        </header>

        <div ref="bodyRef" class="ask-body">
          <p v-if="messages.length === 0" class="ask-hint">
            问一句试试，比如「厨余垃圾怎么处理？」答案会从零废弃知识库里找。
          </p>

          <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
            <div class="bubble" :class="{ failed: m.failed }">
              <span v-if="m.role === 'assistant' && busy && !m.text" class="typing">正在查资料…</span>
              <template v-else>{{ renderAnswer(m.text) }}</template>
            </div>
          </div>
        </div>

        <div v-if="messages.length === 0" class="ask-examples">
          <el-button v-for="q in EXAMPLES" :key="q" link size="small" @click="send(q)">
            {{ q }}
          </el-button>
        </div>

        <div class="ask-foot">
          <el-input
            v-model="draft"
            placeholder="输入问题，回车发送"
            :disabled="busy"
            @keydown="onKeydown"
          />
          <el-button type="primary" :loading="busy" :disabled="!draft.trim()" @click="send(draft)">
            发送
          </el-button>
        </div>
      </section>
    </transition>

    <!-- 右下角气泡 -->
    <el-button
      class="ask-bubble"
      type="primary"
      circle
      size="large"
      :aria-label="panelOpen ? '收起 AI 助手' : '打开 AI 助手'"
      @click="togglePanel"
    >
      <span v-if="panelOpen" class="bubble-glyph" aria-hidden="true">×</span>
      <span v-else class="bubble-glyph">AI</span>
    </el-button>
  </div>
</template>

<style scoped>
.ask-widget {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 2000;
}
.ask-bubble {
  width: 56px;
  height: 56px;
  box-shadow: 0 6px 18px rgba(46, 125, 50, 0.35);
}
.bubble-glyph {
  font-size: 16px;
  font-weight: 600;
}
.ask-panel {
  position: absolute;
  right: 0;
  bottom: 72px;
  width: min(380px, calc(100vw - 48px));
  height: min(560px, calc(100vh - 120px));
  background: #fff;
  border: 1px solid #e3ece3;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(31, 45, 31, 0.18);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ask-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #eef4ee;
}
.ask-title {
  font-weight: 600;
  color: var(--zw-green);
}
.ask-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px;
}
.ask-hint {
  margin: 4px 2px 10px;
  font-size: 13px;
  line-height: 1.6;
  color: #7b8b7b;
}
.msg {
  display: flex;
  margin-bottom: 8px;
}
.msg.user {
  justify-content: flex-end;
}
.bubble {
  max-width: 86%;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  background: #f3f8f3;
  color: #24352a;
}
.msg.user .bubble {
  background: var(--zw-green, #2e7d32);
  color: #fff;
}
.bubble.failed {
  background: #fff7e6;
  color: #b26a00;
}
.typing {
  color: #6b7d6b;
}
.ask-examples {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  padding: 0 12px 8px;
  border-top: 1px solid #f4f8f4;
}
.ask-foot {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid #eef4ee;
}
.pop-enter-active,
.pop-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
