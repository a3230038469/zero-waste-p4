<script setup lang="ts">
/**
 * 右下角 AI 问答窗口 —— 负责人：瑞泽（B07，救急版由协作 AI 实现）
 *
 * 用官方嵌入挂件承载对话（不自己写问答界面）；访客免注册可问。
 * 未就绪 / 连不上时显示明确降级提示，绝不出现「已就绪却点不开」。
 *
 * 对外只暴露 askWith(question)：首页示例问题点击后送进挂件并发送。
 */
import { computed, onMounted, watch } from 'vue'
import { DEGRADED_MESSAGE, LOADING_MESSAGE, useWidget } from '../composables/useWidget'

const emit = defineEmits<{
  /** 状态变化，便于父组件联动（如禁用示例问题按钮） */
  (e: 'status-change', status: string): void
}>()

const { status, errorMessage, mount, ask } = useWidget()

const panelOpen = defineModel<boolean>('open', { default: false })

const statusText = computed(() => {
  if (status.value === 'degraded') {
    return errorMessage.value || DEGRADED_MESSAGE
  }
  if (status.value === 'loading') {
    return LOADING_MESSAGE
  }
  return ''
})

/** 面板可用（就绪）——loading 时给出行内提示，不做假的「已就绪」 */
const isBusy = computed(() => status.value === 'loading')

/** 打开面板：首次展开时启动挂件（换钥匙 → 载 loader；mount 内部单飞） */
async function openPanel(): Promise<void> {
  panelOpen.value = true
  if (status.value === 'idle') {
    await mount()
  }
}

function togglePanel(): void {
  if (panelOpen.value) {
    panelOpen.value = false
    return
  }
  void openPanel()
}

/** 供父组件调用：把问题送进挂件（挂件未就绪时先启动，失败则降级） */
async function askWith(question: string): Promise<void> {
  const q = question.trim()
  if (!q) {
    return
  }
  panelOpen.value = true
  await ask(q)
}

defineExpose({ askWith })

watch(status, (s) => emit('status-change', s), { immediate: true })

onMounted(() => {
  // 预热：提前换钥匙，减少用户点击后的等待；失败静默（点开时才提示）
  void mount()
})
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

        <p v-if="statusText" class="ask-status" :class="{ warn: status === 'degraded' }">
          {{ statusText }}
        </p>

        <!--
          官方挂件容器：loader 脚本会把跨源 iframe 渲染到 #zw-embed-mount。
          注意：iframe 是跨源的，前端**无法**监听其内部加载失败事件，
          因此降级判定只依据两个可观测信号：
            ① 换钥匙失败 / 超时（8s）
            ② loader 脚本 onerror 或 8s 未就绪
        -->
        <div class="ask-body">
          <div v-if="status === 'ready'" id="zw-embed-mount" class="ask-mount"></div>
          <div v-else class="ask-fallback">
            <el-empty :image-size="72" :description="statusText || LOADING_MESSAGE" />
            <el-button
              v-if="status === 'degraded'"
              type="primary"
              plain
              size="small"
              :loading="isBusy"
              @click="mount"
            >
              重试
            </el-button>
          </div>
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
.ask-status {
  margin: 0;
  padding: 8px 14px;
  font-size: 13px;
  color: #4a5a4a;
  background: #f3f8f3;
}
.ask-status.warn {
  color: #b26a00;
  background: #fff7e6;
}
.ask-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}
.ask-mount {
  width: 100%;
  height: 100%;
}
.ask-fallback {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
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
