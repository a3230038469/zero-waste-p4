<script setup lang="ts">
/**
 * 首页 —— 负责人：瑞泽（B07）
 *
 * 要做：
 *  1. 一句话说明 + "能问什么"引导
 *  2. 搜索框（回车跳 /shelf?q=xxx）
 *  3. 已收录数量（从接口动态取，不写死）
 *  4. 示例问题 3–6 条，点击自动填进问答窗口
 *  5. 右下角 AI 问答窗口（直连后端流式问答，访客免注册可问）
 *  6. 问答窗口连不上时显示降级提示
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { getDocs } from '../api/docs'
import HomeAskWidget from '../components/HomeAskWidget.vue'

const router = useRouter()
const keyword = ref('')

/** 搜索：跳书架并带关键词 */
function onSearch(): void {
  const q = keyword.value.trim()
  router.push(q ? { path: '/shelf', query: { q } } : { path: '/shelf' })
}

/* ---------- 3. 已收录资料数量（动态取，禁止写死） ---------- */

/** 取不到时为 null，界面显示占位「—」，不报错、不弹红字 */
const docTotal = ref<number | null>(null)

async function loadDocTotal(): Promise<void> {
  try {
    const { total } = await getDocs({ page: 1, pageSize: 1 })
    docTotal.value = typeof total === 'number' ? total : null
  } catch {
    // 后端未就绪 / 接口失败：静默降级为「—」
    docTotal.value = null
  }
}

const totalText = computed(() => (docTotal.value === null ? '—' : String(docTotal.value)))

/* ---------- 4. 示例问题（零废弃主题，本地文案常量） ---------- */

const SAMPLE_QUESTIONS = [
  '厨余垃圾怎么就地处理？',
  '社区堆肥需要注意什么？',
  '垃圾分类有哪些常见误区？',
  '可回收物怎么分才准确？'
]

const widgetRef = ref<InstanceType<typeof HomeAskWidget> | null>(null)
const widgetOpen = ref(false)
/** 在途提问计数（并发时不能用布尔量，否则先完成的会误置为「不忙」） */
const pendingCount = ref(0)
const asking = computed(() => pendingCount.value > 0)

/**
 * 点击示例问题：送进问答窗口并自动发送。
 * ⚠️ 这里**不做丢弃式加锁**——连点是用户预期行为，必须每条都送达。
 *    串行与防丢由问答窗口自己负责（同一时刻只放一条在飞，见 HomeAskWidget）。
 *    此处的计数仅用于按钮的忙碌态提示。
 */
async function onAskSample(question: string): Promise<void> {
  pendingCount.value += 1
  try {
    await widgetRef.value?.askWith(question)
  } catch {
    // 降级提示由挂件面板内部统一呈现，这里不重复弹错
  } finally {
    pendingCount.value = Math.max(0, pendingCount.value - 1)
  }
}

onMounted(() => {
  void loadDocTotal()
})
</script>

<template>
  <section class="home">
    <h1>零废弃知识库</h1>
    <p class="lead">
      汇集零废弃领域的政策法规、研究报告与案例工具，<br />
      可按分类浏览查找，也可以直接向 AI 助手提问。
    </p>

    <div class="search-row">
      <el-input
        v-model="keyword"
        placeholder="搜索资料名称、政策文件、机构……"
        size="large"
        clearable
        @keyup.enter="onSearch"
      />
      <el-button type="primary" size="large" @click="onSearch">搜索</el-button>
    </div>

    <!-- 3. 已收录资料数量（动态取，取不到显示「—」） -->
    <p class="total-line">
      已收录 <strong>{{ totalText }}</strong> 份资料
    </p>

    <!-- 4. 示例问题（点击后自动填进问答窗口并发送） -->
    <div class="samples">
      <span class="samples-label">可以这样问：</span>
      <div class="samples-list">
        <el-button
          v-for="q in SAMPLE_QUESTIONS"
          :key="q"
          class="sample-chip"
          plain
          round
          :disabled="asking"
          @click="onAskSample(q)"
        >
          {{ q }}
        </el-button>
      </div>
    </div>

    <!-- 5 + 6. 右下角嵌入 AI 问答窗口 + 降级提示 -->
    <HomeAskWidget ref="widgetRef" v-model:open="widgetOpen" />
  </section>
</template>

<style scoped>
.home {
  padding: 40px 0;
}
h1 {
  font-size: 32px;
  margin: 0 0 12px;
  color: var(--zw-green);
}
.lead {
  line-height: 1.8;
  color: #4a5a4a;
  margin-bottom: 28px;
}
.search-row {
  display: flex;
  gap: 12px;
  max-width: 640px;
}
.total-line {
  margin: 16px 0 0;
  color: #4a5a4a;
  font-size: 14px;
}
.total-line strong {
  color: var(--zw-green);
  font-size: 18px;
  margin: 0 2px;
}
.samples {
  margin-top: 28px;
}
.samples-label {
  display: block;
  color: #6b7a6b;
  font-size: 14px;
  margin-bottom: 10px;
}
.samples-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.sample-chip {
  white-space: normal;
  height: auto;
  padding: 8px 16px;
  line-height: 1.5;
}
@media (max-width: 480px) {
  h1 {
    font-size: 24px;
  }
  .search-row {
    flex-direction: column;
  }
}
</style>
