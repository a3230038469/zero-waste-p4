<script setup lang="ts">
/**
 * 资料详情页 —— 负责人：丁梓柔（B06）
 *
 * 本期实现：
 *  1. 按路由参数 :id 拉取详情（当前假数据，结构对齐 GET /api/docs/:id）
 *  2. 展示：标题 / 机构 / 年份 / 类型 / 标签 / 正文
 *  3. 返回书架按钮
 *  4. loading 状态；文档不存在 → 404 提示
 *
 * 待后续任务：在线预览 PDF、下载（需登录）、预览/下载统计
 * （超 20MB 提示、微信内提示、文件名「年份-机构-标题」）
 */
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getDocDetail, type DocDetail } from '../api/docs'

const route = useRoute()
const router = useRouter()

const loading = ref(false)
const doc = ref<DocDetail | null>(null)

async function fetchDetail(): Promise<void> {
  const id = route.params.id
  if (typeof id !== 'string' || !id) {
    doc.value = null
    return
  }
  loading.value = true
  try {
    doc.value = await getDocDetail(id)
  } finally {
    loading.value = false
  }
}

function goShelf(): void {
  router.push('/shelf')
}

/** 正文按段落渲染 */
function contentParagraphs(content: string): string[] {
  return content
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

onMounted(() => {
  void fetchDetail()
})

// 同组件复用（如从详情跳详情）时按新 id 重新拉取
watch(
  () => route.params.id,
  () => {
    if (route.name === 'doc') {
      void fetchDetail()
    }
  }
)
</script>

<template>
  <section class="doc-detail">
    <!-- 返回按钮 -->
    <el-button text class="back-btn" @click="goShelf">← 返回书架</el-button>

    <!-- 加载中 -->
    <div v-if="loading" v-loading="true" element-loading-text="资料加载中……" class="detail-card loading-card">
      <el-skeleton :rows="6" animated />
    </div>

    <!-- 文档不存在 → 404 -->
    <div v-else-if="!doc" class="detail-card not-found">
      <el-result icon="warning" title="404" sub-title="文档不存在或已下架">
        <template #extra>
          <el-button type="primary" @click="goShelf">返回书架</el-button>
        </template>
      </el-result>
    </div>

    <!-- 详情内容 -->
    <article v-else class="detail-card">
      <h1 class="doc-title">{{ doc.title }}</h1>
      <div class="doc-meta">
        <span>{{ doc.org }}</span>
        <span class="meta-dot">·</span>
        <span>{{ doc.year }}</span>
        <el-tag size="small" effect="plain">{{ doc.type }}</el-tag>
      </div>
      <div class="doc-tags">
        <el-tag v-for="t in doc.tags" :key="t" size="small" type="success" effect="light">{{ t }}</el-tag>
      </div>
      <el-divider />
      <div class="doc-content">
        <p v-for="(p, i) in contentParagraphs(doc.content)" :key="i">{{ p }}</p>
      </div>
      <!-- TODO(B06 后续): 在线预览 / 下载（需登录）/ 统计 -->
    </article>
  </section>
</template>

<style scoped>
.doc-detail {
  max-width: 860px;
  margin: 0 auto;
}
.back-btn {
  margin-bottom: 12px;
  color: var(--zw-green);
  font-size: 14px;
}
.detail-card {
  background: #fff;
  border: 1px solid #e3ece3;
  border-radius: 8px;
  padding: 28px;
  min-height: 240px;
}
.loading-card {
  padding-top: 48px;
}
.doc-title {
  margin: 0 0 14px;
  font-size: 26px;
  line-height: 1.4;
  color: var(--zw-text);
}
.doc-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 14px;
  color: #6b7a6b;
}
.meta-dot {
  color: #b3c2b3;
}
.doc-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.doc-content {
  font-size: 15px;
  line-height: 1.9;
  color: #2d3b2d;
}
.doc-content p {
  margin: 0 0 14px;
  text-indent: 2em;
}

/* 手机窄屏 */
@media (max-width: 480px) {
  .detail-card {
    padding: 18px 14px;
  }
  .doc-title {
    font-size: 20px;
  }
  .doc-meta {
    font-size: 13px;
  }
  .doc-content {
    font-size: 14px;
  }
}
</style>
