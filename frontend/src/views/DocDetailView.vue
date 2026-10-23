<script setup lang="ts">
/**
 * 资料详情页 —— 对外展示站版
 *
 * 对外化改动（2026-10-10）：
 *   1. 年份为 0（台账未填）时显示「年份不详」，不再出现「0」。
 *   2. 内容相同的重复件在页面上**如实说明**（「本条目与另一份内容完全相同」），
 *      并给出对方的链接 —— 与其让用户自己撞见两个一样的条目，不如直接讲清楚。
 *   3. 新增「相关推荐」：按本文主题标签拉同主题资料，给「看完这份还想看什么」一个出口。
 *   4. 新增「复制分享链接」：对外站点的资料页是要发给人看的。
 *   5. 补引用提示（著作权归原发布机构），与「关于项目」页的口径一致。
 *
 * B09 追加（公众互动模块）：
 *   6. 新增「反馈这份资料」入口（2026-10-12）。
 *   7. 新增「分享二维码」（2026-10-13），实现见 components/ShareDialog.vue。
 *   8. 进详情页时把浏览器标签标题换成资料标题，离开时还原。
 *
 * 埋点说明：预览/下载的权威计数由**服务端**在 `/api/docs/:id/preview|download`
 * 里各记一条；反馈复用别人的 `feedback_submit` 事件；分享动作**不新增埋点**。
 *
 * 🔴 T11（2026-10-14）：预览 / 下载 / 分享 / 反馈四个入口按**游客权限联动**。
 *    ⚠️ 置灰只是体验：后端也按同一份配置真拦。
 *
 * 合并说明（2026-10-14）：撤掉了数据导出那批加进来的第二个纠错表单
 * （绕过 T11 权限开关），本页只保留 B09 的权限联动入口。
 *
 * 2026-10-18（前端改版第 3 批）：
 *   9. ~~预览面板换成共用的 DocPreviewDialog~~ → 已作废，见第 12 条。
 *  10. 分享 / 反馈不再各调一次 requireAccess，判断收进 useDocActions 一处。
 *  11. 文件型资料（无正文）补一个出口：带着这份资料去问 AI。
 *
 * 2026-10-18 深夜（用户拍板一）：
 *  12. 「在线预览」不再弹层：在本页正文上方展开一块 `.preview-pane`，文件在框内滚动读。
 *  13. 资料库卡片的「预览」跳到本页并带 `?preview=1`，全站只剩这一套预览实现。
 *  14. 超 20 MB 的文件：按钮提前置灰，且**在页面上写明规则**。
 *
 * 2026-10-18 深夜（用户拍板二 · 本页视觉重做）：
 *  15. **进页即预览**：`onMounted` 拉到资料后直接开渲染，不再等读者点按钮
 *      （`?preview=1` 之类的入口参数因此变成单纯的历史兼容）。按钮改为
 *      「收起预览 / 展开预览」的折叠开关，只服务「我只想看资料信息」的读者。
 *  16. **阅读器换掉**：浏览器自带的 PDF 阅读器（深灰工具栏 + 缩略图栏）没有任何
 *      样式入口，换成 components/PdfViewer.vue（pdf.js 自己画页面、自己画工具栏）。
 *      预览区原来是「页面头部一条 + 阅读器一条」两条横栏，现在合成**一条**：
 *      文件名 + 翻页 + 缩放 + 全屏/收起，全在阅读器那条工具栏里（用 slot 塞进去）。
 *  17. **视觉重做**：去掉「徽标/年份/体积」与下面四格信息表的重复字段（年份、类型、
 *      体积原来各出现两次，是这一页最显眼的乱源）；改成「类型徽标 + 年份·体积在右」
 *      → 大标题 → 一行「发布机构 / 原始出处」→ 主题标签 → 操作条（用发丝线隔开）。
 *      信息块整体收紧，让**预览在首屏下半部就露头**（这才是「点开就是预览界面」）。
 *      阴影、圆角、字号、间距统一到一套节奏：纸面 18px 圆角 + 一层柔影，
 *      内部分区一律发丝线，不再用 el-divider 的灰粗线。
 *
 * 2026-10-18 深夜（用户第二次删减）：
 *  18. 删掉「置灰按钮需要登录后使用」那条提示（按钮点下去自己会跳登录页，不必再解释）。
 *  19. 删掉「这是一份文件型资料」整块兜底说明：没解析出正文的资料不再单独占一区。
 *  20. 删掉「展开预览 / 收起预览」这个开关：**这一页本身就是预览页**，进来就渲染，
 *      读者只有「下载原件 / 复制链接 / 二维码」三件事可点。`previewVisible` 随之退场。
 *  21. 阅读器补两处修正：按「纸面舞台」的真实内容宽铺满（原来算宽 26px，
 *      每页右边多一条横向滚动条）；窗口缩放时重新铺满。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  describeDocDetailError,
  docFileExtension,
  getDocDetail,
  getDocs,
  isPdfTitle,
  LARGE_FILE_LIMIT,
  type DocDetail,
  type DocDetailError
} from '../api/docs'
import type { DocItem } from '../api/types'
import { useDocActions } from '../composables/useDocActions'
import { useGuestPermissions } from '../composables/useGuestPermissions'
import DocCard from '../components/DocCard.vue'
import PdfViewer from '../components/PdfViewer.vue'
import FeedbackDialog from '../components/FeedbackDialog.vue'
import ShareDialog from '../components/ShareDialog.vue'
import { formatBytes, formatYear } from '../utils/format'

const route = useRoute()
const router = useRouter()

/* 预览 / 下载走全站唯一实现（useDocActions）：登录判断、游客权限开关、大文件限制、
   失败文案都只有一处 —— 首页与资料库卡片上的那两个按钮用的是同一份。 */
const {
  previewUrl,
  previewLoading,
  locked,
  initGuestPermissions,
  requireAccess,
  revokePreview,
  preview,
  download
} = useDocActions()

const loading = ref(false)
const doc = ref<DocDetail | null>(null)

/**
 * 详情读取失败的分类（404 资料不存在 / 5xx 服务器故障 / 网络不通…）。
 * 2026-10-21（T3 · P1-11）：之前这里只有一个 `doc = null`，页面一律显示
 * 「资料不存在」—— 服务器 502 也被说成资料不存在，读者会以为链接错了。
 */
const detailError = ref<DocDetailError | null>(null)

/** 游客开关是不是兜底值（接口没读通）—— P1-14：读不到要让页面知道 */
const { degraded: guestSwitchDegraded } = useGuestPermissions()

/* 页面内预览区：预览在本页展开、文件可上下滚动读；不分栏。
   「全屏」= 预览区占满视口（替代原来弹窗里那个全屏），手机上看 PDF 才读得动。 */
const previewPane = ref<HTMLElement | null>(null)
const previewFull = ref(false)

/** 超过在线预览上限的文件：按钮提前置灰，规则写在页面上 */
const tooLarge = computed(() => (doc.value?.size ?? 0) > LARGE_FILE_LIMIT)

/**
 * 这份资料是不是 PDF（公-4）。
 * 后端公开接口不吐 MIME，只能看标题里的扩展名；非 PDF（.docx/.txt/…）
 * 在浏览器里根本渲染不了，所以不给预览入口，直接说清楚怎么办。
 */
const isPdf = computed(() => (doc.value ? isPdfTitle(doc.value.title) : true))

/** 能不能在线预览：既没超体积，也是 PDF */
const canPreview = computed(() => !tooLarge.value && isPdf.value)

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
  detailError.value = null
  related.value = []
  try {
    doc.value = await getDocDetail(id)
    // 标签标题换成资料名：转发出去时读者第一眼看到的就是它
    if (doc.value) {
      document.title = `${doc.value.title} · ${SITE_TITLE}`
      void fetchRelated(doc.value)
    }
  } catch (err) {
    // 2026-10-21（T3 · P1-11）：失败要分清楚是「资料不存在」还是「服务器坏了」
    detailError.value = describeDocDetailError(err)
  } finally {
    loading.value = false
  }
}

/** 重新读一次详情（服务器故障时的「重试」按钮） */
async function retryDetail(): Promise<void> {
  await fetchDetail()
  if (doc.value && canPreview.value) void preview(doc.value)
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

function goToLogin(): void {
  void router.push({ path: '/auth', query: { redirect: route.fullPath } })
}

/** 正文按段落渲染。本地资料模式下详情接口不返回 content，必须兜底，否则整页崩 */
function contentParagraphs(content: string | null | undefined): string[] {
  return (content ?? '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

function onDownload(): void {
  if (!doc.value) return
  void download(doc.value)
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

onMounted(async () => {
  // T02（2026-10-23）：进详情页时先 await initGuestPermissions，再决定是否自动预览。
  // 自动预览条件：文件可预览（PDF、未超限）**且**当前身份有预览权限。
  // 没有权限时：不自动加载，页面正常显示元数据，预览区显示登录提示。
  await initGuestPermissions()
  await fetchDetail()
  if (doc.value && canPreview.value && !locked('preview')) {
    void preview(doc.value)
  }
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
      previewFull.value = false
      shareVisible.value = false
      feedbackVisible.value = false
      revokePreview()
      void fetchDetail().then(() => {
        if (doc.value && canPreview.value) void preview(doc.value)
      })
    }
  }
)
</script>

<template>
  <div class="doc-detail">
    <button type="button" class="back-btn" @click="goShelf">
      <span class="back-arrow" aria-hidden="true">←</span> 返回资料库
    </button>

    <div v-if="loading" class="doc-sheet zw-card">
      <el-skeleton :rows="6" animated />
    </div>

    <!-- T3 · P1-11：404 与 5xx 必须说不同的话。以前 502 也显示「资料不存在」，
         读者以为是自己链接错了，其实服务器那边出了事。 -->
    <div v-else-if="!doc" class="doc-sheet zw-card">
      <el-result
        :icon="detailError && detailError.kind !== 'not-found' ? 'error' : 'warning'"
        :title="detailError && detailError.kind !== 'not-found' ? '资料没能加载出来' : '资料不存在'"
        :sub-title="
          detailError
            ? detailError.message
            : '这份资料可能已下架，或者链接有误。'
        "
      >
        <template #extra>
          <el-button
            v-if="detailError && detailError.kind !== 'not-found'"
            type="primary"
            @click="retryDetail"
          >
            重新加载
          </el-button>
          <el-button type="primary" @click="goShelf">返回资料库</el-button>
        </template>
      </el-result>
    </div>

    <template v-else>
      <article class="doc-sheet zw-card">
        <!-- ① 标题区：类型徽标 + 年份·体积 → 标题 → 机构/出处 → 主题 -->
        <header class="doc-head">
          <div class="head-top">
            <span class="type-badge">{{ doc.type }}</span>
            <span class="head-facts zw-num">
              {{ formatYear(doc.year) }}
              <i class="dot" aria-hidden="true" />
              {{ formatBytes(doc.size) }}
            </span>
          </div>

          <h1 class="doc-title">{{ doc.title }}</h1>

          <dl class="byline">
            <div class="byline-item">
              <dt>发布机构</dt>
              <dd>{{ doc.org }}</dd>
            </div>
            <div v-if="doc.sourceUrl" class="byline-item byline-source">
              <dt>原始出处</dt>
              <dd>
                <a
                  :href="doc.sourceUrl"
                  :title="doc.sourceUrl"
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  {{ doc.sourceUrl }}
                </a>
              </dd>
            </div>
          </dl>

          <div v-if="doc.tags.length" class="doc-tags">
            <span class="tags-label">主题</span>
            <button v-for="t in doc.tags" :key="t" type="button" class="tag-chip" @click="goTopic(t)">
              {{ t }}
            </button>
          </div>
        </header>

        <!-- 重复副本提示：如实说明，并给出另一份的入口 -->
        <p v-if="doc.duplicateOf" class="notice notice--amber">
          本条目与库中另一份资料<strong>内容完全相同</strong>（逐字节比对判定），属重复收录。
          <RouterLink :to="`/doc/${doc.duplicateOf}`">查看另一份</RouterLink>
        </p>

        <!-- ② 操作条：这一页本身就是预览页，所以没有「展开/收起预览」这个开关 -->
        <div class="doc-actions">
          <el-button
            type="primary"
            plain
            class="act-main"
            :class="{ 'need-login': locked('download') }"
            @click="onDownload"
          >
            下载原件
          </el-button>

          <span class="act-spacer" />

          <button
            type="button"
            class="act-minor"
            :class="{ 'need-login': locked('share') }"
            @click="onCopyLink"
          >
            复制链接
          </button>
          <button
            type="button"
            class="act-minor"
            :class="{ 'need-login': locked('share') }"
            @click="openShare"
          >
            二维码
          </button>
        </div>

        <!-- 大文件：规则提前写在页面上，不让读者点一下才知道为什么不能预览 -->
        <p v-if="tooLarge" class="notice notice--amber">
          这份文件 {{ formatBytes(doc.size) }}，超过在线预览上限（20 MB）。文件大的资料在浏览器里打开容易卡住，
          所以这里不提供在线预览 —— 请用「下载原件」保存后查看。
        </p>

        <!-- T3 · 公-4：非 PDF 不给预览入口（.docx/.txt 在浏览器里渲染不了），
             之前只按体积判断，点了预览只出来一片空白或英文报错。 -->
        <p v-else-if="!isPdf" class="notice notice--amber">
          这份资料是 {{ docFileExtension(doc.title).toUpperCase() || '非 PDF' }} 文件，
          浏览器里没法直接预览 —— 请用「下载原件」保存后用本地阅读器打开。
        </p>

        <!-- T3 · P1-14：游客开关读不到时如实说明（按默认开放走，后端仍会真拦） -->
        <p v-if="guestSwitchDegraded" class="notice notice--amber">
          游客功能开关暂时读不到，页面按默认开放处理；如果某项操作被拦，请登录后再试。
        </p>

        <!-- ③ 预览区：一条工具栏（文件名 / 翻页 / 缩放 / 全屁）+ 纸面。进页就展开，没有开关 -->
        <section
          v-if="canPreview"
          ref="previewPane"
          class="preview-pane"
          :class="{ 'is-full': previewFull }"
        >
          <div class="pv-body">
            <!-- 游客且无预览权限：显示登录提示 -->
            <p v-if="locked('preview')" class="pv-login-prompt">
              登录后可在线预览这份资料
              <el-button size="small" type="primary" @click="goToLogin">
                去登录
              </el-button>
            </p>
            <!-- 已登录或有权限：正常预览逻辑
                 ⚠️ 必须用 template 而不是 div：多套一层没有高度的 div 会把
                 PdfViewer 的 height:100% 高度链打断，预览区会塌成一条缝（2026-10-23 实测）。 -->
            <template v-else>
              <div v-if="previewLoading" class="pv-mask">
                <span class="pv-spinner" aria-hidden="true" />
                <p>正在打开文件…</p>
              </div>
              <PdfViewer v-else-if="previewUrl" :src="previewUrl" :title="doc.title">
                <template #actions>
                  <button type="button" class="pv-mini" @click="previewFull = !previewFull">
                    {{ previewFull ? '退出全屏' : '全屏' }}
                  </button>
                </template>
              </PdfViewer>
              <p v-else class="pv-empty">
                文件没能在这里打开，可以用上方「下载原件」保存后用本地阅读器查看。
              </p>
            </template>
          </div>
          <p class="pane-foot">这里显示的是原件本身；下载或引用请遵循资料自身的授权。</p>
        </section>

        <!-- ④ 正文（只有解析出正文的资料才有这一区；文件型资料不再另起说明栏） -->
        <section v-if="contentParagraphs(doc.content).length" class="doc-body">
          <p v-for="(p, i) in contentParagraphs(doc.content)" :key="i">{{ p }}</p>
        </section>

        <!-- ⑤ 页脚：引用口径 + 纠错入口 -->
        <footer class="doc-foot">
          <p class="cite-note">
            著作权归原发布机构所有，本站仅作收录与索引；引用请注明原始出处，详见
            <RouterLink to="/#cite">引用与转载说明</RouterLink>。
          </p>
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
        </footer>

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
        <h2 class="related-title">同主题资料</h2>
        <div class="related-grid">
          <template v-if="relatedLoading">
            <div v-for="n in 3" :key="n" class="related-skeleton zw-card">
              <el-skeleton :rows="3" animated />
            </div>
          </template>
          <template v-else>
            <DocCard v-for="item in related" :key="item.id" :doc="item" />
          </template>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* ===== 页面骨架 =====
   一层浅绿纸感底 + 一张白纸（.doc-sheet）。整页只用「纸面 + 发丝线」分区，
   不再叠一层层带底色的方块 —— 详情页的主角是那份文件，界面得往后退。 */
.doc-detail {
  position: relative;
  max-width: 960px;
  margin: 0 auto;
  /* 顶端一层极淡的绿光，让白纸「浮」起来。
     用背景渐变而不是伪元素：伪元素往外撑 80px 会把手机视口撑宽（实测 390 被撑到 457，
     整页被缩放、字全变小），这是踩过的坑。 */
  background: radial-gradient(58% 300px at 50% 0%, rgba(46, 125, 50, 0.09), transparent 72%) no-repeat;
}

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: none;
  font: inherit;
  font-size: 13.5px;
  color: var(--zw-muted);
  cursor: pointer;
  padding: 8px 12px 8px 0; /* QA-ALL-03 热区：6px 纵向不足 44 标准，留 8 上下假设含行高 */
  min-height: 36px;
  margin-bottom: 12px;
  transition: color 0.16s ease;
}

.back-btn:hover {
  color: var(--zw-green-deep);
}

.back-btn:focus-visible {
  outline: 2px solid var(--zw-green);
  outline-offset: 2px;
}

.back-arrow {
  font-size: 15px;
  line-height: 1;
}

/* 白纸：18px 圆角 + 一层柔和投影（两层阴影叠出「厚度」，比单层灰边耐看） */
.doc-sheet {
  padding: 30px 34px 26px;
  border: 1px solid var(--zw-line);
  border-radius: 18px;
  background: var(--zw-surface);
  box-shadow:
    0 1px 2px rgba(22, 36, 26, 0.04),
    0 14px 36px -18px rgba(22, 36, 26, 0.18);
}

/* ===== ① 标题区 ===== */
.head-top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.type-badge {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--zw-green-deep);
  background: var(--zw-mint);
  border-radius: 999px;
  padding: 4px 12px;
}

.head-facts {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--zw-faint);
}

.dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--zw-line-strong);
}

.doc-title {
  margin: 0 0 16px;
  font-size: 26px;
  font-weight: 600;
  line-height: 1.45;
  letter-spacing: 0.01em;
  color: var(--zw-ink);
}

/* 机构 / 原始出处：一行到底，标签小、内容正；出处单行省略（完整地址在悬浮里） */
.byline {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 24px;
  margin: 0 0 14px;
}

.byline-item {
  display: flex;
  gap: 8px;
  min-width: 0;
}

.byline dt {
  flex-shrink: 0;
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--zw-faint);
}

.byline dd {
  margin: 0;
  font-size: 13.5px;
  color: var(--zw-text);
  overflow-wrap: anywhere;
}

.byline-source {
  width: 100%;
}

.byline-source dd {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.byline-source a {
  color: var(--zw-green);
  text-decoration: none;
  border-bottom: 1px dotted var(--zw-line-strong);
}

.byline-source a:hover {
  color: var(--zw-green-deep);
  border-bottom-color: var(--zw-green-soft);
}

.doc-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.tags-label {
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--zw-faint);
}

.tag-chip {
  border: 1px solid var(--zw-line-strong);
  background: #fff;
  color: var(--zw-teal);
  font: inherit;
  font-size: 12.5px;
  padding: 3px 12px;
  border-radius: 999px;
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    background 0.16s ease;
}

.tag-chip:hover {
  border-color: var(--zw-teal);
  background: var(--zw-teal-soft);
}

/* ===== ② 操作条 ===== */
.doc-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid var(--zw-line);
}

.doc-actions :deep(.el-button) {
  height: 38px;
  padding: 0 18px;
  border-radius: 10px;
  font-size: 13.5px;
}

.act-spacer {
  flex: 1;
}

/* 次要动作：无边框文字按钮，hover 才出现浅绿底 —— 不跟主操作抢视线 */
.act-minor {
  font: inherit;
  font-size: 13px;
  color: var(--zw-muted);
  background: none;
  border: 0;
  padding: 7px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition:
    color 0.16s ease,
    background 0.16s ease;
}

.act-minor:hover {
  color: var(--zw-green-deep);
  background: var(--zw-mint-2);
}

/* ===== 提示条：琥珀（规则/警示）与灰绿（说明）两种，共用一套形状 ===== */
.notice {
  margin: 14px 0 0;
  padding: 10px 14px;
  font-size: 12.5px;
  line-height: 1.85;
  border-left: 3px solid;
  border-radius: 0 10px 10px 0;
}

.notice--amber {
  color: var(--zw-amber-ink);
  background: var(--zw-amber-soft);
  border-color: var(--zw-amber);
}

.notice--amber a,
.notice--amber strong {
  color: var(--zw-amber-ink);
}

/* T11：游客权限关闭后的「置灰」（只影响这几个入口，不动别的按钮）。
   QA-ALL-04：全站禁用到此统一 —— opacity 0.55 单看是「坏掉了」，
   现在改整 button 组合语义：降低一档透明度 + cursor 提示 + amber 提示在按钮内。 */
.need-login {
  opacity: 0.72;
  cursor: not-allowed;
}

.feedback-hint {
  color: var(--zw-amber-ink); /* 对比度同上，amber 或 amber-ink 二选一，这里用深琥珀 */
  margin-left: 4px;
}

/* ===== ③ 预览区 =====
   投影比纸面重一档：预览是「桌面上摊开的那份文件」，得比纸面更靠前一点。
   工具栏在 PdfViewer 里（文件名 / 翻页 / 缩放 / 全屏 / 收起），这里只管外框与纸面底色。 */
.preview-pane {
  margin-top: 18px;
  border: 1px solid var(--zw-line-strong);
  border-radius: 14px;
  background: #fff;
  overflow: hidden;
  box-shadow:
    0 1px 2px rgba(22, 36, 26, 0.05),
    0 18px 40px -22px rgba(22, 36, 26, 0.28);
  /* 展开后 scrollIntoView 会把顶栏藏到吸顶导航下面，留出导航的高度 */
  scroll-margin-top: 84px;
}

/* 全屏 = 预览区占满视口（替代弹窗里那个「全屏」） */
.preview-pane.is-full {
  position: fixed;
  inset: 0;
  z-index: 2500;
  margin: 0;
  border: 0;
  border-radius: 0;
  display: flex;
  flex-direction: column;
}

.pv-body {
  position: relative;
  height: 72vh;
  /* 大屏上 72vh 会高到离谱，封顶 780px；小屏仍按 72vh 撑开 */
  max-height: 780px;
  min-height: 340px;
  overflow: hidden;
  background: #eef3ee;
}

.preview-pane.is-full .pv-body {
  flex: 1;
  height: auto;
  max-height: none;
  min-height: 0;
}

/* 预览区右上角两个小按钮（塞进阅读器工具栏的 slot 里） */
.pv-mini {
  font: inherit;
  font-size: 12px;
  padding: 5px 12px;
  border: 1px solid var(--zw-line-strong);
  border-radius: 8px;
  background: #fff;
  color: var(--zw-text);
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    color 0.16s ease,
    background 0.16s ease;
}

.pv-mini:hover {
  border-color: var(--zw-green-soft);
  color: var(--zw-green-deep);
  background: var(--zw-mint-2);
}

/* 预览没起来时的兜底一句话（正常情况下看不到） */
.pv-empty {
  margin: 0;
  padding: 56px 24px;
  font-size: 13px;
  line-height: 1.9;
  text-align: center;
  color: var(--zw-muted);
}

.pv-mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  font-size: 13px;
  color: var(--zw-muted);
  background: rgba(238, 243, 238, 0.9);
}

.pv-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--zw-line-strong);
  border-top-color: var(--zw-green);
  border-radius: 50%;
  animation: pv-spin 0.8s linear infinite;
}

@keyframes pv-spin {
  to {
    transform: rotate(360deg);
  }
}

.pane-foot {
  margin: 0;
  padding: 9px 18px 10px;
  border-top: 1px solid var(--zw-line);
  background: #fbfdfb;
  font-size: 12px;
  color: var(--zw-faint);
  text-align: right;
}

/* 全屏时让纸面吃满，这句说明收起 */
.preview-pane.is-full .pane-foot {
  display: none;
}

/* ===== ④ 正文（仅解析出正文的资料） ===== */
.doc-body {
  margin-top: 24px;
  padding-top: 22px;
  border-top: 1px solid var(--zw-line);
  font-size: 15px;
  line-height: 1.95;
  color: var(--zw-text);
  /* QA-DOC-01：长文正文列宽上限 —— 960 纸面上完全铺满会到 ~890px，
     一行 60+ 汉字读读起来太宽；收成 72ch 汉字舒适行宽并始终居中。 */
  max-width: 72ch;
  margin-inline: auto;
}

.doc-body p {
  margin: 0 0 14px;
}

.doc-body p:last-child {
  margin-bottom: 0;
}

/* ===== ⑤ 页脚 ===== */
.doc-foot {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--zw-line);
}

.cite-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--zw-faint);
}

.cite-note a {
  color: var(--zw-green);
}

/* 反馈入口——低调但找得到：不抢主操作，也不藏进角落 */
.feedback-entry {
  margin: 8px 0 0;
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

/* ===== 相关推荐 ===== */
.related {
  margin-top: 40px;
}

.related-title {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 16px;
  font-size: 15px;
  font-weight: 600;
  color: var(--zw-ink);
}

/* 标题右侧拉一条渐隐发丝线，把「相关推荐」和上面的正文分开 */
.related-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--zw-line-strong), transparent);
}

.related-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
}

.related-skeleton {
  padding: 18px 20px;
}

/* ===== 窄屏（手机） ===== */
@media (max-width: 720px) {
  .doc-sheet {
    padding: 20px 18px 18px;
    border-radius: 14px;
  }

  .doc-title {
    font-size: 20px;
    line-height: 1.5;
  }

  .head-facts {
    font-size: 12px;
  }

  .byline {
    gap: 4px 14px;
  }

  .byline-source dd {
    white-space: normal;
  }

  /* 手机上按钮排成 2×2：主操作（预览/下载）一行，次操作（链接/二维码）一行 */
  .doc-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .doc-actions :deep(.el-button) {
    width: 100%;
    min-width: 0;
    margin-left: 0;
  }

  .act-spacer {
    display: none;
  }

  .act-minor {
    border: 1px solid var(--zw-line);
    text-align: center;
    white-space: nowrap;
  }

  /* 主操作（下载原件）独占一行，两个次操作并排，刚好 2×2 不空位 */
  .doc-actions .act-main {
    grid-column: 1 / -1;
  }

  .pv-body {
    height: 60vh;
    min-height: 300px;
  }

  .pane-foot {
    text-align: left;
  }
}
</style>
