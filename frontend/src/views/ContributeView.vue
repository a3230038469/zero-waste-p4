<script setup lang="ts">
/**
 * 我要投稿 / 意见反馈 —— B09 公众互动（2026-10-13 新增）
 *
 * 路由：/contribute
 * 为什么两个功能一页：2026-10-11 三件拍板之一 —— 组长建议「上传 + 反馈做成一个页面」，
 *   确认是**一个页面两个标签页**。这里就是那个页面：
 *     Tab1「我要投稿」：访客投稿入口（**需登录**、**只收 PDF**，另两件拍板）
 *     Tab2「意见反馈」：站点级反馈，与页脚/详情页的弹窗共用 constants/feedback.ts 的口径
 *
 * 投稿闭环：提交 → 状态「待审核」→ **不进书架、不可检索、不可下载** → 管理员在
 *   /admin/contributions 审核 → 通过才真进知识库 / 退回要写理由。本页下方的
 *   「我的投稿」就是投稿人看自己稿件状态与退回理由的地方。
 *
 * 四维下拉（机构/年份/类型/主题）的选项来自 GET /api/docs/facets —— **不写死**，
 *   库里有什么就能选什么；同时开着 allow-create，遇到新机构/新主题可以自己输，
 *   否则会把「库里还没有的机构」这类合法投稿挡在门外。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import { getFacets } from '../api/docs'
import {
  CONTRIBUTION_ACCEPT,
  MAX_CONTRIBUTION_BYTES,
  fetchMyContributions,
  submitContribution,
  type ContributionStatus,
  type MyContribution
} from '../api/contributions'
import {
  FEEDBACK_TEXT_MAX,
  SITE_FEEDBACK_HINT,
  SITE_KINDS,
  submitFeedback
} from '../constants/feedback'
import { useAuth } from '../composables/useAuth'
import { formatBytes } from '../utils/format'

const route = useRoute()
const router = useRouter()
const { user, isLoggedIn } = useAuth()

const activeTab = ref<'contribute' | 'feedback'>('contribute')

/* ------------------------------------------------------------------ *
 * Tab1 · 我要投稿
 * ------------------------------------------------------------------ */

const form = reactive({ title: '', org: '', year: '', type: '', tags: '', note: '' })
const pickedFile = ref<File | null>(null)
const submitting = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

/** 下拉选项（el-select 用的形状，从 facets 的 { value, count } 转来） */
interface FacetsLike {
  value: string
  label: string
}

/** 四维下拉的选项（来自 /api/docs/facets；取不到就只留 allow-create 的自由输入） */
const options = reactive({
  orgs: [] as FacetsLike[],
  years: [] as FacetsLike[],
  types: [] as FacetsLike[],
  tags: [] as FacetsLike[]
})

const mine = ref<MyContribution[]>([])
const mineLoading = ref(false)
const mineSection = ref<HTMLElement | null>(null)

const NOTE_MAX = 200

function facetsToOptions(items: { value: string }[]): FacetsLike[] {
  return items.map((x) => ({ value: x.value, label: x.value }))
}

async function loadFacets(): Promise<void> {
  try {
    const data = await getFacets({})
    options.orgs = facetsToOptions(data.orgs)
    options.years = facetsToOptions(data.years)
    options.types = facetsToOptions(data.types)
    options.tags = facetsToOptions(data.tags)
  } catch {
    // 下拉选项拉不到不该把整个投稿页卡住：用户还能自己输（allow-create）
    ElMessage.warning('现有资料的筛选项没拉取成功，四维可以直接手输')
  }
}

async function loadMine(): Promise<void> {
  if (!isLoggedIn.value) {
    mine.value = []
    return
  }
  mineLoading.value = true
  try {
    const data = await fetchMyContributions()
    mine.value = data.items ?? []
  } catch {
    mine.value = []
  } finally {
    mineLoading.value = false
  }
}

/** 选文件：客户端先挡一道（类型 / 大小），别等传完才告诉用户不行 */
function onPickFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    ElMessage.error('目前只接收 PDF 文件，请先把其他格式导出成 PDF')
    input.value = ''
    return
  }
  if (file.size > MAX_CONTRIBUTION_BYTES) {
    ElMessage.error(
      `文件不能超过 ${Math.round(MAX_CONTRIBUTION_BYTES / 1024 / 1024)}MB，请压缩后再投稿`
    )
    input.value = ''
    return
  }
  pickedFile.value = file
}

function clearFile(): void {
  pickedFile.value = null
  if (fileInput.value) fileInput.value.value = ''
}

/** 统一读后端错误信封里的 message（http.ts 是 silent，得自己弹） */
function errorMessage(err: unknown, fallback: string): string {
  const response = (err as { response?: { data?: { error?: { message?: string } } } }).response
  return response?.data?.error?.message ?? fallback
}

async function onSubmit(): Promise<void> {
  if (submitting.value) return
  if (!pickedFile.value) {
    ElMessage.warning('请先选择要投稿的 PDF 文件')
    return
  }
  if (!form.title.trim()) {
    ElMessage.warning('请填写资料标题')
    return
  }
  if (!form.org || !form.year || !form.type || !form.tags) {
    ElMessage.warning('机构 / 年份 / 类型 / 主题都要选')
    return
  }

  submitting.value = true
  try {
    const res = await submitContribution(pickedFile.value, {
      title: form.title.trim(),
      org: form.org,
      year: form.year,
      type: form.type,
      tags: form.tags,
      note: form.note.trim()
    })
    ElMessage.success(res.message || '投稿已提交，等待管理员审核')

    // 清表单，刷新「我的投稿」，并把视线带到列表 —— 用户要知道自己的稿子去哪了
    form.title = ''
    form.note = ''
    clearFile()
    await loadMine()
    mineSection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (err) {
    ElMessage.error(errorMessage(err, '投稿提交失败，请稍后再试'))
  } finally {
    submitting.value = false
  }
}

function statusTag(status: ContributionStatus): {
  type: 'success' | 'warning' | 'danger'
  text: string
} {
  if (status === 'approved') return { type: 'success', text: '已通过' }
  if (status === 'rejected') return { type: 'danger', text: '已退回' }
  return { type: 'warning', text: '待审核' }
}

function fmtTime(value: string): string {
  if (!value) return '—'
  return value.replace('T', ' ').slice(0, 16)
}

/* ------------------------------------------------------------------ *
 * Tab2 · 意见反馈（站点级）
 * ------------------------------------------------------------------ */

const fbForm = reactive({ reason: '', text: '', contact: '' })
const fbSubmitting = ref(false)

async function onSubmitFeedback(): Promise<void> {
  if (fbSubmitting.value) return
  if (!fbForm.reason) {
    ElMessage.warning('请选择反馈分类')
    return
  }
  if (!fbForm.text.trim()) {
    ElMessage.warning('请填写反馈内容')
    return
  }
  fbSubmitting.value = true
  try {
    await submitFeedback({
      scope: 'site',
      reason: fbForm.reason,
      text: fbForm.text,
      contact: fbForm.contact,
      path: route.fullPath,
      userId: user.value?.id ?? null
    })
    ElMessage.success('反馈已提交，感谢你的建议')
    fbForm.reason = ''
    fbForm.text = ''
    fbForm.contact = ''
  } finally {
    fbSubmitting.value = false
  }
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

onMounted(() => {
  void loadFacets()
  void loadMine()
})

const pendingCount = computed(() => mine.value.filter((x) => x.status === 'pending').length)

function goLogin(): void {
  void router.push({ path: '/auth', query: { redirect: '/contribute' } })
}
</script>

<template>
  <section class="contribute zw-container">
    <header class="page-head">
      <h1>我要投稿 · 意见反馈</h1>
      <p>
        手上有一份和零废弃有关的政策、报告、标准或实践工具？欢迎投稿进资料库；
        使用站点遇到问题，也在这里告诉我们。
      </p>
    </header>

    <el-tabs v-model="activeTab" class="ct-tabs">
      <!-- ============ Tab1：我要投稿 ============ -->
      <el-tab-pane label="我要投稿" name="contribute">
        <!-- 未登录：投稿要登录（拍板结论）。不放空表单，直接给出下一步 -->
        <el-card v-if="!isLoggedIn" shadow="never" class="login-gate">
          <h3>投稿需要先登录</h3>
          <p>
            登录后投稿才能和你的账号关联 —— 稿子被退回时你能在「我的投稿」里看到理由，
            我们也知道该找谁核实内容。
          </p>
          <el-button type="primary" @click="goLogin">去登录 / 注册</el-button>
        </el-card>

        <template v-else>
          <el-card shadow="never" class="ct-card">
            <p class="ct-note">
              提交后稿件状态为<b>待审核</b>。审核通过前，它不会出现在资料库里， 也不会被检索到 ——
              管理员通过后会由系统送入知识库。
            </p>

            <div class="ct-field">
              <label class="ct-label">投稿文件<span class="req">*</span></label>
              <input
                ref="fileInput"
                type="file"
                class="file-input"
                :accept="CONTRIBUTION_ACCEPT"
                @change="onPickFile"
              />
              <div class="file-row">
                <el-button @click="fileInput?.click()">选择 PDF 文件</el-button>
                <span v-if="pickedFile" class="file-name">
                  {{ pickedFile.name }}
                  <em>({{ formatBytes(pickedFile.size) }})</em>
                  <button type="button" class="file-clear" @click="clearFile">移除</button>
                </span>
                <span v-else class="file-hint">只接收 PDF，单份不超过 50MB</span>
              </div>
            </div>

            <div class="ct-field">
              <label class="ct-label">资料标题<span class="req">*</span></label>
              <el-input
                v-model="form.title"
                maxlength="120"
                show-word-limit
                placeholder="例：城市生活垃圾分类制度实施方案"
              />
            </div>

            <div class="ct-grid">
              <div class="ct-field">
                <label class="ct-label">发布机构<span class="req">*</span></label>
                <el-select
                  v-model="form.org"
                  filterable
                  allow-create
                  default-first-option
                  placeholder="选择或输入机构"
                  style="width: 100%"
                >
                  <el-option
                    v-for="o in options.orgs"
                    :key="o.value"
                    :label="o.label"
                    :value="o.value"
                  />
                </el-select>
              </div>

              <div class="ct-field">
                <label class="ct-label">年份<span class="req">*</span></label>
                <el-select
                  v-model="form.year"
                  filterable
                  allow-create
                  default-first-option
                  placeholder="选择或输入年份"
                  style="width: 100%"
                >
                  <el-option
                    v-for="o in options.years"
                    :key="o.value"
                    :label="o.label"
                    :value="o.value"
                  />
                </el-select>
              </div>

              <div class="ct-field">
                <label class="ct-label">资料类型<span class="req">*</span></label>
                <el-select
                  v-model="form.type"
                  filterable
                  allow-create
                  default-first-option
                  placeholder="选择或输入类型"
                  style="width: 100%"
                >
                  <el-option
                    v-for="o in options.types"
                    :key="o.value"
                    :label="o.label"
                    :value="o.value"
                  />
                </el-select>
              </div>

              <div class="ct-field">
                <label class="ct-label">主题<span class="req">*</span></label>
                <el-select
                  v-model="form.tags"
                  filterable
                  allow-create
                  default-first-option
                  placeholder="选择或输入主题"
                  style="width: 100%"
                >
                  <el-option
                    v-for="o in options.tags"
                    :key="o.value"
                    :label="o.label"
                    :value="o.value"
                  />
                </el-select>
              </div>
            </div>

            <div class="ct-field">
              <label class="ct-label">投稿说明<span class="opt">（选填，200 字内）</span></label>
              <el-input
                v-model="form.note"
                type="textarea"
                :rows="3"
                :maxlength="NOTE_MAX"
                show-word-limit
                placeholder="这份资料的来源、为什么值得收录，或需要说明的情况"
              />
            </div>

            <div class="ct-actions">
              <el-button type="primary" :loading="submitting" @click="onSubmit">
                {{ submitting ? '提交中…' : '提交投稿' }}
              </el-button>
              <span class="ct-actions-hint">提交后可在下方「我的投稿」跟踪审核结果</span>
            </div>
          </el-card>

          <!-- 我的投稿 -->
          <section ref="mineSection" class="mine">
            <h3 class="mine-title">
              我的投稿
              <span class="mine-count">{{ mine.length }}</span>
              <el-tag v-if="pendingCount" type="warning" size="small" effect="plain">
                {{ pendingCount }} 份待审核
              </el-tag>
            </h3>

            <el-empty
              v-if="!mineLoading && mine.length === 0"
              description="还没有投过稿，上方提交后会在这里显示"
            />

            <el-table v-else v-loading="mineLoading" :data="mine" class="mine-table">
              <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag :type="statusTag(row.status).type" size="small">{{
                    statusTag(row.status).text
                  }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="提交时间" width="150">
                <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="审核说明" min-width="200">
                <template #default="{ row }">
                  <span v-if="row.status === 'rejected'" class="reason">{{
                    row.reason || '（未填理由）'
                  }}</span>
                  <span v-else-if="row.status === 'approved'" class="ok-note">
                    已收录进资料库{{ row.reviewedAt ? `（${fmtTime(row.reviewedAt)}）` : '' }}
                  </span>
                  <span v-else class="pending-note">等待管理员审核</span>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </template>
      </el-tab-pane>

      <!-- ============ Tab2：意见反馈 ============ -->
      <el-tab-pane label="意见反馈" name="feedback">
        <el-card shadow="never" class="ct-card">
          <p class="ct-note">{{ SITE_FEEDBACK_HINT }}</p>

          <div class="ct-field">
            <label class="ct-label">反馈分类<span class="req">*</span></label>
            <el-radio-group v-model="fbForm.reason" class="fb-options">
              <el-radio v-for="opt in SITE_KINDS" :key="opt.value" :value="opt.value">{{
                opt.label
              }}</el-radio>
            </el-radio-group>
          </div>

          <div class="ct-field">
            <label class="ct-label">详细说明<span class="req">*</span></label>
            <el-input
              v-model="fbForm.text"
              type="textarea"
              :rows="4"
              :maxlength="FEEDBACK_TEXT_MAX"
              show-word-limit
              placeholder="请写下你的建议或遇到的问题"
            />
          </div>

          <div class="ct-field">
            <label class="ct-label"
              >联系方式<span class="opt">（选填，便于我们回复你）</span></label
            >
            <el-input
              v-model="fbForm.contact"
              maxlength="60"
              clearable
              placeholder="邮箱 / 微信等，选填"
            />
          </div>

          <div class="ct-actions">
            <el-button type="primary" :loading="fbSubmitting" @click="onSubmitFeedback">
              {{ fbSubmitting ? '提交中…' : '提交反馈' }}
            </el-button>
            <span class="ct-actions-hint">反馈匿名也能提，不用登录</span>
          </div>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </section>
</template>

<style scoped>
.contribute {
  padding: 32px 0 48px;
}

.page-head h1 {
  margin: 0 0 10px;
  font-size: var(--zw-fs-h2);
  color: var(--zw-green-deep);
}

.page-head p {
  margin: 0 0 18px;
  max-width: 46em;
  font-size: var(--zw-fs-sm);
  line-height: 1.9;
  color: var(--zw-muted);
}

.ct-card,
.login-gate {
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
}

.login-gate {
  max-width: 560px;
}

.login-gate h3 {
  margin: 0 0 10px;
  font-size: var(--zw-fs-lg);
  color: var(--zw-ink);
}

.login-gate p {
  margin: 0 0 16px;
  font-size: var(--zw-fs-sm);
  line-height: 1.9;
  color: var(--zw-muted);
}

.ct-note {
  margin: 0 0 20px;
  padding: 12px 14px;
  border-radius: var(--zw-radius-sm);
  background: var(--zw-mint-2);
  font-size: var(--zw-fs-sm);
  line-height: 1.8;
  color: var(--zw-text);
}

.ct-field {
  margin-bottom: 18px;
}

.ct-label {
  display: block;
  margin-bottom: 8px;
  font-size: var(--zw-fs-sm);
  color: var(--zw-ink);
}

.req {
  margin-left: 2px;
  color: #d9534f;
}

.opt {
  color: var(--zw-faint);
}

.ct-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 20px;
}

/* 原生 file input 藏起来：样式无法统一，触发交给「选择 PDF 文件」按钮 */
.file-input {
  display: none;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.file-name {
  font-size: var(--zw-fs-sm);
  color: var(--zw-text);
}

.file-name em {
  color: var(--zw-faint);
  font-style: normal;
}

.file-clear {
  margin-left: 6px;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: var(--zw-fs-xs);
  color: var(--zw-muted);
  cursor: pointer;
  text-decoration: underline;
  transition: color var(--zw-dur-fast) var(--zw-ease);
}

/* 交互态补齐：删除附件是不可逆操作，悬停要给出「会删」的信号（转语义红），
   而不是停留在中性的灰。焦点环保证键盘用户也能定位到它。 */
.file-clear:hover {
  color: var(--zw-danger);
}

.file-clear:focus-visible {
  outline: none;
  box-shadow: var(--zw-focus-ring);
}

.file-hint {
  font-size: var(--zw-fs-xs);
  color: var(--zw-faint);
}

.ct-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.ct-actions-hint {
  font-size: var(--zw-fs-xs);
  color: var(--zw-faint);
}

.mine {
  margin-top: 28px;
}

.mine-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 12px;
  font-size: var(--zw-fs-body);
  color: var(--zw-ink);
}

.mine-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--zw-mint);
  font-size: var(--zw-fs-xs);
  color: var(--zw-green-deep);
}

.mine-table {
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  overflow: hidden;
}

.reason {
  color: var(--zw-danger);
}

.ok-note {
  color: var(--zw-green);
  font-size: var(--zw-fs-sm);
}

.pending-note {
  color: var(--zw-muted);
  font-size: var(--zw-fs-sm);
}

.fb-options {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

@media (max-width: 720px) {
  .ct-grid {
    grid-template-columns: 1fr;
  }
}
</style>
