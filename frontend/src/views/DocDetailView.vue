<script setup lang="ts">
/**
 * 资料详情页 —— 对外展示站版（2026-10-10 改版）
 *
 * 对外化改动：
 *   1. 年份为 0（台账未填）时显示「年份不详」，不再出现「0」。
 *   2. 内容相同的重复件在页面上**如实说明**（「本条目与另一份内容完全相同」），
 *      并给出对方的链接 —— 与其让用户自己撞见两个一样的条目，不如直接讲清楚。
 *   3. 新增「相关推荐」：按本文主题标签拉同主题资料，给「看完这份还想看什么」一个出口。
 *   4. 新增「复制分享链接」：对外站点的资料页是要发给人看的。
 *   5. 补引用提示（著作权归原发布机构），与「关于项目」页的口径一致。
 *
 * B09 追加（公众互动模块）：
 *   6. 新增「反馈这份资料」入口（2026-10-12）：访客发现标题/机构/年份有误、
 *      文件打不开时，得有地方说话；反馈走 FeedbackDialog → POST /api/track。
 *   7. 新增「分享二维码」（2026-10-13）：线下活动/PPT/打印物料没有链接可发，需要能扫的码。
 *      弹窗里同时给「复制链接」和「保存二维码 PNG」，实现见 components/ShareDialog.vue。
 *   8. 进详情页时把浏览器标签标题换成资料标题（原来一直是「零废弃知识库」）——
 *      对外站点转发出去时，标签页标题就是读者看到的第一行字。离开页面时还原。
 *
 * 埋点说明：预览/下载的权威计数由**服务端**在 `/api/docs/:id/preview|download`
 * 里各记一条（见 backend/src/routes/docs.ts），前端不必重复上报。
 * 反馈复用别人的 `feedback_submit` 事件（已在白名单里）；分享动作**不新增埋点**，
 * 避免动到别人的事件白名单。
 *
 * 🔴 T11（2026-10-14）：本页的预览 / 下载 / 分享 / 反馈四个入口改为**按游客权限联动**。
 *    原来这里是「一律先登录才能用」，现在改成「登录用户一律放行；游客看后台那排开关」。
 *    ⚠️ 置灰只是体验：后端（routes/docs.ts、routes/track.ts）也按同一份配置真拦，
 *    绕过本页直接调接口照样被拒。
 *
 * 合并说明（2026-10-14）：数据导出那批改动原本在本页也加了一个「这条信息有问题？」的
 * 折叠纠错表单（走 POST /api/feedback）。合并时发现本页已有 B09 的「反馈这份资料」
 * （资料级，走 FeedbackDialog），两者是同一个动作的重复出口，且**新加的那个绕过了 T11
 * 的游客权限开关**（关掉游客反馈后旧入口置灰、新入口照常可用）—— 这是个真缺陷，
 * 所以撤掉了新加的那个，本页只保留 B09 的权限联动入口。
 * 反馈的可读化（落库 + 后台列表 + 导出）仍保留在「关于项目」页那个表单与后台页上。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { LARGE_FILE_LIMIT, downloadDoc, getDocDetail, getDocs, getPreviewUrl, type DocDetail } from '../api/docs'
import type { DocItem } from '../api/types'
import { useAuth } from '../composables/useAuth'
import { useGuestPermissions } from '../composables/useGuestPermissions'
import type { GuestFeature } from '../api/guest'
import DocCard from '../components/DocCard.vue'
import FeedbackDialog from '../components/FeedbackDialog.vue'
import ShareDialog from '../components/ShareDialog.vue'
import { formatBytes, formatYear } from '../utils/format'

const route = useRoute()
const router = useRouter()
const { user, isLoggedIn, fetchMe } = useAuth()
const { ensure: ensureGuestPermissions, guestAllowed } = useGuestPermissions()

/** 某一项当前是否被锁（游客且该功能已关闭）—— 置灰用它 */
function locked(feature: GuestFeature): boolean {
  return !guestAllowed(feature)
}

const loading = ref(false)
const doc = ref<DocDetail | null>(null)
const previewLoading = ref(false)
const previewUrl = ref('')
const previewVisible = ref(false)
/** 反馈弹窗（资料级） */
const feedbackVisible = ref(false)

/** 同主题推荐（排除自己） */
const related = ref<DocItem[]>([])
const relatedLoading = ref(false)
/** 分享弹窗（B09）：地址在打开弹窗的瞬间取，避免用列表页 URL 或历史 URL 分享错 */
const shareVisible = ref(false)
const shareUrl = ref('')

/** 站点默认标题（index.html 里的），离开详情页时还原 */
const SITE_TITLE = '零废弃知识库'

function openShare(): void {
  void requireAccess('share').then((ok) => {
    if (!ok) return
    shareUrl.value = window.location.href
    shareVisible.value = true
  })
}

/** 打开资料级反馈弹窗（游客反馈被关时引导去登录） */
function openFeedback(): void {
  void requireAccess('feedback').then((ok) => {
    if (ok) feedbackVisible.value = true
  })
}

async function fetchDetail(): Promise<void> {
  const id = route.params.id
  if (typeof id !== 'string' || !id) {
    doc.value = null
    return
  }
  loading.value = true
  doc.value = null
  related.value = []
  try {
    doc.value = await getDocDetail(id)
    // 标签标题换成资料名：转发出去时读者第一眼看到的就是它
    if (doc.value) {
      document.title = `${doc.value.title} · ${SITE_TITLE}`
      void fetchRelated(doc.value)
    }
  } finally {
    loading.value = false
  }
}

/** 按首个主题标签找同主题资料；没有标签就不找（不猜） */
async function fetchRelated(target: DocDetail): Promise<void> {
  const topic = target.tags[0]
  if (!topic) return
  relatedLoading.value = true
  try {
    const res = await getDocs({ tags: [topic], page: 1, pageSize: 7, sort: 'year_desc' })
    related.value = res.items.filter((item) => item.id !== target.id).slice(0, 3)
  } catch {
    related.value = []
  } finally {
    relatedLoading.value = false
  }
}

function goShelf(): void {
  void router.push('/shelf')
}

function goTopic(tag: string): void {
  void router.push({ path: '/shelf', query: { tag } })
}

/** 正文按段落渲染。本地资料模式下详情接口不返回 content，必须兜底，否则整页崩 */
function contentParagraphs(content: string | null | undefined): string[] {
  return (content ?? '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/** 登录校验：未登录跳登录页并带回跳地址。
 *  门槛只看 isLoggedIn（本地有 token 即算登录），不看 user：
 *  云端 /me 可能取不回用户信息，若卡 user 会让已登录用户点不动下载/预览。
 *
 *  🔴 T11：多带一个功能键 —— 游客能不能用这一项，看后台的「游客权限」开关。
 *    开关开着 → 直接放行（以前这里是「一律先登录」，与开关就矛盾了）；
 *    开关关了 → 说一句人话并引导去登录页。
 *    已登录用户不看任何开关。 */
async function requireAccess(feature: GuestFeature): Promise<boolean> {
  if (isLoggedIn.value) {
    if (!user.value) await fetchMe()
    return true
  }
  if (guestAllowed(feature)) return true
  ElMessage.warning('该功能需要登录后使用，已为你跳到登录页')
  void router.push({ path: '/auth', query: { redirect: route.fullPath } })
  return false
}

/** 在线预览：先取回文件，失败给出中文原因（iframe 自己拿不到状态码） */
async function onPreview(): Promise<void> {
  if (!doc.value || !(await requireAccess('preview'))) return
  if (doc.value.size > LARGE_FILE_LIMIT) {
    ElMessage.warning(`文件较大（${formatBytes(doc.value.size)}），建议下载后查看`)
    return
  }
  previewLoading.value = true
  try {
    revokePreview()
    previewUrl.value = await getPreviewUrl(doc.value)
    previewVisible.value = true
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '预览失败，请稍后再试')
  } finally {
    previewLoading.value = false
  }
}

/** 下载原件：超 20MB 先确认。成功才提示成功，失败把原因说清楚 */
async function onDownload(): Promise<void> {
  if (!doc.value || !(await requireAccess('download'))) return
  if (doc.value.size > LARGE_FILE_LIMIT) {
    try {
      await ElMessageBox.confirm(
        `文件较大（${formatBytes(doc.value.size)}），下载可能需要一些时间，确定下载吗？`,
        '大文件下载',
        { confirmButtonText: '继续下载', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return // 用户取消
    }
  }
  try {
    await downloadDoc(doc.value)
    ElMessage.success('已开始下载')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '下载失败，请稍后再试')
  }
}

/** 复制本页链接（对外站点的主要分享动作） */
async function onCopyLink(): Promise<void> {
  if (!(await requireAccess('share'))) return
  const url = window.location.href
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
    } else {
      // 非安全上下文（http 局域网访问）没有 clipboard API，退回旧办法
      const input = document.createElement('input')
      input.value = url
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      input.remove()
    }
    ElMessage.success('链接已复制')
  } catch {
    ElMessage.warning('复制失败，请手动复制地址栏链接')
  }
}

function revokePreview(): void {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''
  }
}

/** 预览提示：Word / Excel 等格式在浏览器里通常不能内联预览，提前讲清楚 */
const previewHint = computed(() =>
  '在线预览对 PDF 效果最好；Word、Excel 等格式若预览空白，请直接下载原件。'
)

onMounted(() => {
  void fetchDetail()
  // T11：读一次游客权限，用来决定预览/下载/分享/反馈要不要置灰
  void ensureGuestPermissions()
})

onUnmounted(() => {
  revokePreview()
  // 离开详情页把标签标题还给站点默认，否则从详情跳到别的页面标题会一直停在资料名
  document.title = SITE_TITLE
})

// 同组件复用（如从详情跳详情）时按新 id 重新拉取
watch(
  () => route.params.id,
  () => {
    if (route.name === 'doc') {
      previewVisible.value = false
      shareVisible.value = false
      feedbackVisible.value = false
      revokePreview()
      void fetchDetail()
    }
  }
)
</script>

<template>
  <div class="doc-detail">
    <button type="button" class="back-btn" @click="goShelf">← 返回资料库</button>

    <div v-if="loading" class="detail-card zw-card">
      <el-skeleton :rows="6" animated />
    </div>

    <div v-else-if="!doc" class="detail-card zw-card">
      <el-result icon="warning" title="404" sub-title="这份资料不存在或已下架">
        <template #extra>
          <el-button type="primary" @click="goShelf">返回资料库</el-button>
        </template>
      </el-result>
    </div>

    <template v-else>
      <article class="detail-card zw-card">
        <div class="top-row">
          <span class="type-badge">{{ doc.type }}</span>
          <span class="year zw-num">{{ formatYear(doc.year) }}</span>
          <span class="size zw-num">{{ formatBytes(doc.size) }}</span>
        </div>

        <h1 class="doc-title">{{ doc.title }}</h1>

        <dl class="meta-grid">
          <div>
            <dt>发布机构</dt>
            <dd>{{ doc.org }}</dd>
          </div>
          <div>
            <dt>发布年份</dt>
            <dd>{{ formatYear(doc.year) }}</dd>
          </div>
          <div>
            <dt>资料类型</dt>
            <dd>{{ doc.type }}</dd>
          </div>
          <div>
            <dt>文件体积</dt>
            <dd class="zw-num">{{ formatBytes(doc.size) }}</dd>
          </div>
          <div v-if="doc.sourceUrl" class="span-2">
            <dt>原始出处</dt>
            <dd>
              <a :href="doc.sourceUrl" target="_blank" rel="noopener noreferrer nofollow">{{ doc.sourceUrl }}</a>
            </dd>
          </div>
        </dl>

        <div v-if="doc.tags.length" class="doc-tags">
          <span class="tags-label">主题：</span>
          <button v-for="t in doc.tags" :key="t" type="button" class="tag-chip" @click="goTopic(t)">
            {{ t }}
          </button>
        </div>

        <!-- 重复副本提示：如实说明，并给出另一份的入口 -->
        <p v-if="doc.duplicateOf" class="dup-notice">
          本条目与库中另一份资料<strong>内容完全相同</strong>（逐字节比对判定），属重复收录。
          <RouterLink :to="`/doc/${doc.duplicateOf}`">查看另一份</RouterLink>
        </p>

        <div class="doc-actions">
          <el-button
            type="primary"
            :loading="previewLoading"
            :class="{ 'need-login': locked('preview') }"
            @click="onPreview"
          >
            在线预览
          </el-button>
          <el-button
            type="primary"
            plain
            :class="{ 'need-login': locked('download') }"
            @click="onDownload"
          >
            下载原件
          </el-button>
          <el-button text :class="{ 'need-login': locked('share') }" @click="onCopyLink">
            复制分享链接
          </el-button>
          <el-button text :class="{ 'need-login': locked('share') }" @click="openShare">
            分享二维码
          </el-button>
        </div>

        <!-- T11：被关掉的功能，在这里说清「为什么点不动」 -->
        <p v-if="locked('preview') || locked('download') || locked('share')" class="action-hint need-login-hint">
          置灰的按钮需要登录后使用（站点当前对游客关闭了这些功能），点一下会跳到登录页。
        </p>

        <p class="action-hint">{{ previewHint }}</p>

        <el-divider />

        <div class="doc-content">
          <p v-for="(p, i) in contentParagraphs(doc.content)" :key="i">{{ p }}</p>
          <div v-if="contentParagraphs(doc.content).length === 0" class="no-content">
            <p class="no-content-title">这是一份文件型资料</p>
            <p class="no-content-text">
              知识库以原件为准，本页不转载正文。请用上方「在线预览」直接阅读，或「下载原件」保存后查看。
            </p>
          </div>
        </div>

        <!-- 预览面板 -->
        <div v-if="previewVisible" class="preview-panel">
          <div class="preview-head">
            <span>在线预览</span>
            <el-button text size="small" class="preview-close" @click="previewVisible = false">收起 ×</el-button>
          </div>
          <iframe :src="previewUrl" class="pdf-frame" title="资料在线预览" />
        </div>

        <p class="cite-note">
          著作权归原发布机构所有，本站仅作收录与索引；引用请注明原始出处，详见
          <RouterLink to="/about#cite">引用与转载说明</RouterLink>。
        </p>

        <!-- 反馈入口：访客发现条目有误 / 文件打不开时的出口（B09） -->
        <p class="feedback-entry">
          标题、机构、年份有误，或文件打不开？
          <button
            type="button"
            class="feedback-link"
            :class="{ 'need-login': locked('feedback') }"
            @click="openFeedback"
          >
            反馈这份资料
          </button>
          <span v-if="locked('feedback')" class="feedback-hint">（当前需登录后提交）</span>
        </p>

        <FeedbackDialog
          v-model="feedbackVisible"
          scope="doc"
          :doc-id="doc.id"
          :doc-title="doc.title"
        />
      </article>

      <!-- 分享弹窗（B09）：二维码 + 复制链接 + 导出 PNG -->
      <ShareDialog v-model="shareVisible" :title="doc.title" :url="shareUrl" />

      <!-- 相关推荐 -->
      <section v-if="relatedLoading || related.length" class="related">
        <h2 class="zw-h2">同主题资料</h2>
        <div v-if="relatedLoading" class="related-grid">
          <div v-for="n in 3" :key="n" class="related-skeleton zw-card"><el-skeleton :rows="3" animated /></div>
        </div>
        <div v-else class="related-grid">
          <DocCard v-for="item in related" :key="item.id" :doc="item" />
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.doc-detail {
  max-width: 900px;
  margin: 0 auto;
}

.back-btn {
  border: 0;
  background: none;
  font: inherit;
  font-size: 14px;
  color: var(--zw-green);
  cursor: pointer;
  padding: 4px 0;
  margin-bottom: 14px;
}

.back-btn:hover {
  text-decoration: underline;
}

.detail-card {
  padding: 28px 30px 24px;
}

.top-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.type-badge {
  font-size: 12px;
  font-weight: 600;
  color: var(--zw-green-deep);
  background: var(--zw-mint);
  border-radius: 999px;
  padding: 4px 12px;
}

.year,
.size {
  font-size: 13px;
  color: var(--zw-faint);
}

.size {
  margin-left: auto;
}

.doc-title {
  margin: 0 0 20px;
  font-size: 27px;
  line-height: 1.42;
  color: var(--zw-ink);
}

/* 关键字段用定义列表：语义正确，也便于窄屏改成单列 */
.meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 28px;
  margin: 0 0 18px;
  padding: 16px 18px;
  background: var(--zw-mint-2);
  border-radius: var(--zw-radius-sm);
}

.meta-grid > div {
  display: flex;
  gap: 10px;
  min-width: 0;
}

.meta-grid .span-2 {
  grid-column: 1 / -1;
}

.meta-grid dt {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--zw-muted);
}

.meta-grid dd {
  margin: 0;
  font-size: 14px;
  color: var(--zw-ink);
  overflow-wrap: anywhere;
}

.meta-grid a {
  color: var(--zw-green);
}

.doc-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 18px;
}

.tags-label {
  font-size: 13px;
  color: var(--zw-muted);
}

.tag-chip {
  border: 1px solid var(--zw-line-strong);
  background: #fff;
  color: var(--zw-teal);
  font: inherit;
  font-size: 13px;
  padding: 3px 12px;
  border-radius: 999px;
  cursor: pointer;
}

.tag-chip:hover {
  border-color: var(--zw-teal);
  background: var(--zw-teal-soft);
}

.dup-notice {
  margin: 0 0 18px;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--zw-amber-ink);
  background: var(--zw-amber-soft);
  border-left: 3px solid var(--zw-amber);
  border-radius: 0 var(--zw-radius-sm) var(--zw-radius-sm) 0;
}

.dup-notice a {
  color: var(--zw-amber-ink);
  font-weight: 600;
}

.doc-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.action-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--zw-faint);
}

/* T11：游客权限关闭后的「置灰 + 提示」样式（只影响这几个入口，不动别的按钮） */
.need-login {
  opacity: 0.55;
}
.need-login-hint {
  color: var(--zw-amber);
}
.feedback-hint {
  color: var(--zw-amber);
  margin-left: 4px;
}

.doc-content {
  font-size: 15px;
  line-height: 1.95;
  color: var(--zw-text);
}

.doc-content p {
  margin: 0 0 14px;
  text-indent: 2em;
}

.no-content {
  padding: 18px 20px;
  border: 1px dashed var(--zw-line-strong);
  border-radius: var(--zw-radius-sm);
  background: #fbfdfb;
}

.no-content-title {
  margin: 0 0 6px;
  font-weight: 600;
  color: var(--zw-ink);
  text-indent: 0;
}

.no-content-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--zw-muted);
  text-indent: 0;
}

.preview-panel {
  margin-top: 22px;
  border: 1px solid var(--zw-line-strong);
  border-radius: var(--zw-radius-sm);
  overflow: hidden;
}

.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: var(--zw-green);
  color: #fff;
  font-size: 14px;
}

.preview-close {
  color: #fff;
}

.pdf-frame {
  display: block;
  width: 100%;
  height: 660px;
  border: 0;
  background: #525659;
}

.cite-note {
  margin: 20px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--zw-faint);
}

.cite-note a {
  color: var(--zw-green);
}

/* 反馈入口——低调但找得到：不抢主操作，也不藏进角落 */
.feedback-entry {
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--zw-faint);
}

.feedback-link {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--zw-green);
  cursor: pointer;
  text-decoration: underline;
}

.feedback-link:hover {
  color: var(--zw-green-deep);
}

/* 相关推荐 */
.related {
  margin-top: 36px;
}

.related-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
  margin-top: 14px;
}

.related-skeleton {
  padding: 18px 20px;
}

@media (max-width: 640px) {
  .detail-card {
    padding: 20px 16px;
  }

  .doc-title {
    font-size: 21px;
  }

  .meta-grid {
    grid-template-columns: 1fr;
    gap: 10px;
  }

  .pdf-frame {
    height: 420px;
  }
}
</style>
