<script setup lang="ts">
/**
 * 资料详情页 —— 负责人：丁梓柔（B06）
 *
 *  1. 按路由参数 :id 拉取详情（当前假数据，结构对齐 GET /api/docs/:id）
 *  2. 展示：标题 / 机构 / 年份 / 类型 / 标签 / 正文
 *  3. 返回书架按钮；loading；文档不存在 → 404
 *  4. 在线预览 PDF（超过 20MB 提示「文件较大，建议下载后查看」）
 *  5. 下载：文件名「年份-机构-标题」，超过 20MB 弹确认
 *  6. 未登录点预览/下载 → 跳 /auth?redirect=当前页地址
 *
 * TODO(后续)：预览/下载动作的后端统计上报（接口待定义）
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { LARGE_FILE_LIMIT, downloadDoc, getDocDetail, getPreviewUrl, type DocDetail } from '../api/docs'
import { useAuth } from '../composables/useAuth'

const route = useRoute()
const router = useRouter()
const { user, fetchMe } = useAuth()

const loading = ref(false)
const doc = ref<DocDetail | null>(null)
const previewLoading = ref(false)
const previewUrl = ref('')
const previewVisible = ref(false)

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

/** 登录校验：未登录跳登录页并带回跳地址 */
async function requireLogin(): Promise<boolean> {
  if (!user.value) {
    // token 在但用户信息尚未拉取完成的情况，先补一次
    await fetchMe()
  }
  if (user.value) {
    return true
  }
  router.push({ path: '/auth', query: { redirect: route.fullPath } })
  return false
}

function formatSize(size: number): string {
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}

/** 在线预览 */
async function onPreview(): Promise<void> {
  if (!doc.value || !(await requireLogin())) {
    return
  }
  if (doc.value.size > LARGE_FILE_LIMIT) {
    ElMessage.warning(`文件较大（${formatSize(doc.value.size)}），建议下载后查看`)
    return
  }
  previewLoading.value = true
  try {
    revokePreview()
    previewUrl.value = await getPreviewUrl(doc.value)
    previewVisible.value = true
  } finally {
    previewLoading.value = false
  }
}

/** 下载原件：超 20MB 先确认 */
async function onDownload(): Promise<void> {
  if (!doc.value || !(await requireLogin())) {
    return
  }
  if (doc.value.size > LARGE_FILE_LIMIT) {
    try {
      await ElMessageBox.confirm(
        `文件较大（${formatSize(doc.value.size)}），下载可能需要一些时间，确定下载吗？`,
        '大文件下载',
        { confirmButtonText: '继续下载', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return // 用户取消
    }
  }
  await downloadDoc(doc.value)
  ElMessage.success('已开始下载')
}

function revokePreview(): void {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''
  }
}

onMounted(() => {
  void fetchDetail()
})

onUnmounted(() => {
  revokePreview()
})

// 同组件复用（如从详情跳详情）时按新 id 重新拉取
watch(
  () => route.params.id,
  () => {
    if (route.name === 'doc') {
      previewVisible.value = false
      revokePreview()
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
        <span class="meta-size">{{ formatSize(doc.size) }}</span>
      </div>
      <div class="doc-tags">
        <el-tag v-for="t in doc.tags" :key="t" size="small" type="success" effect="light">{{ t }}</el-tag>
      </div>

      <!-- 预览 / 下载 -->
      <div class="doc-actions">
        <el-button type="primary" :loading="previewLoading" @click="onPreview">在线预览</el-button>
        <el-button type="primary" plain @click="onDownload">下载原件</el-button>
      </div>

      <el-divider />

      <div class="doc-content">
        <p v-for="(p, i) in contentParagraphs(doc.content)" :key="i">{{ p }}</p>
      </div>

      <!-- PDF 在线预览 -->
      <div v-if="previewVisible" class="preview-panel">
        <div class="preview-head">
          <span>在线预览</span>
          <el-button text size="small" class="preview-close" @click="previewVisible = false">收起 ×</el-button>
        </div>
        <iframe :src="previewUrl" class="pdf-frame" title="PDF 在线预览" />
      </div>
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
.meta-size {
  margin-left: auto;
  color: #8a998a;
  font-size: 13px;
}
.doc-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.doc-actions {
  display: flex;
  gap: 12px;
  margin-top: 18px;
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
.preview-panel {
  margin-top: 24px;
  border: 1px solid #d8e8d8;
  border-radius: 8px;
  overflow: hidden;
}
.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: var(--zw-green-light);
  color: #fff;
  font-size: 14px;
}
.preview-close {
  color: #fff;
}
.pdf-frame {
  display: block;
  width: 100%;
  height: 640px;
  border: 0;
  background: #525659;
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
  .meta-size {
    margin-left: 0;
  }
  .doc-content {
    font-size: 14px;
  }
  .pdf-frame {
    height: 420px;
  }
}
</style>
