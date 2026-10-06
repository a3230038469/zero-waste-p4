<script setup lang="ts">
/**
 * 首页 —— 负责人：瑞泽（B07）
 *
 * 要做：
 *  1. 一句话说明 + "能问什么"引导
 *  2. 搜索框（回车跳 /shelf?q=xxx）
 *  3. 已收录数量（从接口动态取，不写死）
 *  4. 示例问题 3–6 条，点击自动填进问答窗口
 *  5. 右下角嵌入官方 AI 问答窗口（访客免注册可问）
 *  6. 问答窗口连不上时显示降级提示
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const keyword = ref('')

/** 搜索：跳书架并带关键词 */
function onSearch(): void {
  const q = keyword.value.trim()
  router.push(q ? { path: '/shelf', query: { q } } : { path: '/shelf' })
}
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

    <!-- TODO(瑞泽): 示例问题（点击后自动填进问答窗口） -->
    <!-- TODO(瑞泽): 已收录资料数量（动态取） -->
    <!-- TODO(瑞泽): 右下角嵌入 AI 问答窗口 + 降级提示 -->
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
@media (max-width: 480px) {
  h1 {
    font-size: 24px;
  }
  .search-row {
    flex-direction: column;
  }
}
</style>
