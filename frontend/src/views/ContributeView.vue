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
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import { getFacets } from '../api/docs'
import {
  CONTRIBUTION_ACCEPT,
  CONTRIBUTION_PARSE_LABEL,
  CONTRIBUTION_STATUS_LABEL,
  MAX_CONTRIBUTION_BYTES,
  fetchMyContributions,
  submitContribution,
  type ContributionParseState,
  type ContributionStatus,
  type MyContribution
} from '../api/contributions'
import { FEEDBACK_TEXT_MAX, SITE_FEEDBACK_HINT, SITE_KINDS, submitFeedback } from '../constants/feedback'
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
const options = reactive({ orgs: [] as FacetsLike[], years: [] as FacetsLike[], types: [] as FacetsLike[], tags: [] as FacetsLike[] })

const mine = ref<MyContribution[]>([])
const mineLoading = ref(false)
/** 【T3 · 操作员-6】「我的投稿」读不出来 ≠ 没有投过稿：两个状态必须分得开 */
const mineError = ref('')
const mineSection = ref<HTMLElement | null>(null)

/**
 * 【T3 · P3-2 / 公众-7】窄屏（≤720px）下「我的投稿」改用卡片流。
 *
 * 原来是一张四列表格（标题 / 状态 / 提交时间 / 审核说明），最少要 650px 宽，
 * 390px 的手机上只能横向拖 —— 看标题就得先把表拖到最右。改成卡片：一份一卡。
 */
const narrowScreen = ref(false)
let narrowMq: MediaQueryList | null = null
function syncNarrow(): void {
  narrowScreen.value = narrowMq?.matches ?? false
}

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
  mineError.value = ''
  try {
    const data = await fetchMyContributions()
    mine.value = data.items ?? []
  } catch {
    // 【T3 · 操作员-6】之前这里把列表清空就完事，页面显示「还没有投过稿」——
    // 接口挂了会被当成「你没投过」，用户白等一场。改成显式的加载失败。
    mine.value = []
    mineError.value = '投稿记录没能加载出来，请稍后再试。'
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
    ElMessage.error(`文件不能超过 ${Math.round(MAX_CONTRIBUTION_BYTES / 1024 / 1024)}MB，请压缩后再投稿`)
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

/**
 * 状态标签（2026-10-21 起「通过」再细分解析进度）
 *
 * 审核通过 ≠ 已经能被问答引用：引擎还要解析（实测 PDF 约 1 分钟）。
 * 这里把这段中间态如实说出来，避免用户以为「已通过」就等于「已经入库了」。
 * unknown 时只写「已通过」（数据源不是引擎，不编进度）。
 */
function statusTag(row: {
  status: ContributionStatus
  parseState?: ContributionParseState
}): { type: 'success' | 'warning' | 'danger' | 'info'; text: string } {
  // 【T3 · P2-9】文案统一用 api/contributions.ts 里那份共享枚举
  // （管理台「投稿审核」用的是同一份，两边不该各写一套对不上）。
  const base = CONTRIBUTION_STATUS_LABEL[row.status]
  if (row.status !== 'approved') {
    return { type: row.status === 'rejected' ? 'danger' : 'warning', text: base }
  }
  // 已通过之后还要看引擎解析进度：通过了不等于已经能被问答引用
  const state = row.parseState ?? 'unknown'
  if (state === 'completed') return { type: 'success', text: `${base} · ${CONTRIBUTION_PARSE_LABEL.completed}` }
  if (state === 'failed') return { type: 'danger', text: `${base} · ${CONTRIBUTION_PARSE_LABEL.failed}` }
  if (state === 'pending' || state === 'processing' || state === 'finalizing') {
    return { type: 'warning', text: `${base} · ${CONTRIBUTION_PARSE_LABEL[state]}` }
  }
  // unknown = 数据源不是引擎（本地资料包 / 演示快照），不编进度，只说「已通过」
  return { type: 'success', text: base }
}

/**
 * 【T3 · 公-3】时间显示改成本地时区。
 *
 * 后端给的是 UTC 的 ISO 串，之前直接截字符串（'2026-10-20T08:47:00' → '2026-10-20 08:47'），
 * 显示的其实是 UTC 时间，比本地时间少 8 小时 —— 用户会以为稿子投了 8 小时才被处理。
 */
function fmtTime(value: string): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value.replace('T', ' ').slice(0, 16)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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
  } catch (err) {
    // 失败时保留用户填的内容，只报错 —— 反馈是工单，不能悄悄丢
    ElMessage.error(err instanceof Error ? err.message : '提交失败，请稍后再试')
  } finally {
    fbSubmitting.value = false
  }
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

onMounted(() => {
  narrowMq = window.matchMedia('(max-width: 720px)')
  syncNarrow()
  narrowMq.addEventListener('change', syncNarrow)
  void loadFacets()
  void loadMine()
})

onBeforeUnmount(() => {
  narrowMq?.removeEventListener('change', syncNarrow)
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
              提交后稿件状态为<b>待审核</b>。审核通过前，它不会出现在资料库里，
              也不会被检索到 —— 管理员通过后会由系统送入知识库。
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
              <div id="contribute-upload" class="file-row">
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
              <el-input v-model="form.title" maxlength="120" show-word-limit placeholder="例：城市生活垃圾分类制度实施方案" />
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
                  <el-option v-for="o in options.orgs" :key="o.value" :label="o.label" :value="o.value" />
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
                  <el-option v-for="o in options.years" :key="o.value" :label="o.label" :value="o.value" />
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
                  <el-option v-for="o in options.types" :key="o.value" :label="o.label" :value="o.value" />
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
                  <el-option v-for="o in options.tags" :key="o.value" :label="o.label" :value="o.value" />
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

            <!-- 【T3 · 操作员-6】「读不出来」和「没有投过稿」是两回事，必须分开显示 -->
            <el-result
              v-if="mineError"
              icon="error"
              title="投稿记录没能加载出来"
              :sub-title="mineError"
              class="mine-error"
            >
              <template #extra>
                <el-button type="primary" @click="loadMine">重新加载</el-button>
              </template>
            </el-result>

            <el-empty v-else-if="!mineLoading && mine.length === 0" description="还没有投过稿，上方提交后会在这里显示" />

            <!-- 宽屏：表格 -->
            <el-table v-else-if="!narrowScreen" v-loading="mineLoading" :data="mine" class="mine-table">
              <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag :type="statusTag(row).type" size="small">{{ statusTag(row).text }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="提交时间" width="150">
                <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="审核说明" min-width="200">
                <template #default="{ row }">
                  <span v-if="row.status === 'rejected'" class="reason">{{ row.reason || '（未填理由）' }}</span>
                  <span v-else-if="row.status === 'approved'" class="ok-note">
                    已收录进资料库{{ row.reviewedAt ? `（${fmtTime(row.reviewedAt)}）` : '' }}
                  </span>
                  <span v-else class="pending-note">等待管理员审核</span>
                </template>
              </el-table-column>
            </el-table>

            <!-- 【T3 · P3-2 / 公众-7】窄屏：一份一张卡。
                 原来那张四列表格最少要 650px 宽，390px 的手机上只能横着拖，
                 想看标题得先把表拖到最右边。 -->
            <ul v-else v-loading="mineLoading" class="mine-cards">
              <li v-for="row in mine" :key="row.id" class="mine-card">
                <p class="mc-title">{{ row.title }}</p>
                <p class="mc-meta">
                  <el-tag :type="statusTag(row).type" size="small">{{ statusTag(row).text }}</el-tag>
                  <span class="mc-time">{{ fmtTime(row.createdAt) }}</span>
                </p>
                <p class="mc-note">
                  <span v-if="row.status === 'rejected'" class="reason">{{ row.reason || '（未填理由）' }}</span>
                  <span v-else-if="row.status === 'approved'" class="ok-note">
                    已收录进资料库{{ row.reviewedAt ? `（${fmtTime(row.reviewedAt)}）` : '' }}
                  </span>
                  <span v-else class="pending-note">等待管理员审核</span>
                </p>
              </li>
            </ul>
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
              <el-radio v-for="opt in SITE_KINDS" :key="opt.value" :value="opt.value">{{ opt.label }}</el-radio>
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
            <label class="ct-label">联系方式<span class="opt">（选填，便于我们回复你）</span></label>
            <el-input v-model="fbForm.contact" maxlength="60" clearable placeholder="邮箱 / 微信等，选填" />
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
  font-size: 26px;
  color: var(--zw-green-deep);
}

.page-head p {
  margin: 0 0 18px;
  max-width: 46em;
  font-size: 14px;
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
  font-size: 17px;
  color: var(--zw-ink);
}

.login-gate p {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--zw-muted);
}

.ct-note {
  margin: 0 0 20px;
  padding: 12px 14px;
  border-radius: var(--zw-radius-sm);
  background: var(--zw-mint-2);
  font-size: 13px;
  line-height: 1.8;
  color: var(--zw-text);
}

.ct-field {
  margin-bottom: 18px;
}

.ct-label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--zw-ink);
}

.req {
  margin-left: 2px;
  color: #d9534f;
}

.opt {
  color: var(--zw-muted); /* QA-CTR-03：faint on mint-2 底不达标，muted 稳过 4.5:1 */
}

/* 上传锚点（QA-CTR-08）：上传控件在 11 屏长表单中间，直接告知位置。 */
.file-hint {
  font-size: 12px;
  color: var(--zw-muted);
}

.ct-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 20px;
}

/* 原生 file input 藏起来：样式无法统一，触发交给「选择 PDF 文件」按钮 */
.file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.file-row {
  scroll-margin-top: 84px; /* QA-CTR-08：与全站 scroll-margin 常数一致，锚点理值 */
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.file-name {
  font-size: 13px;
  color: var(--zw-text);
}

.file-name em {
  color: var(--zw-faint);
  font-style: normal;
}

.file-clear {
  min-width: 36px;
  min-height: 32px; /* QA-ALL-03：热区从「一行小字」拉到 36×32 可点 */
  margin-left: 6px;
  border: 0;
  background: none;
  padding: 4px 8px;
  font: inherit;
  font-size: 12px;
  color: var(--zw-muted);
  cursor: pointer;
  text-decoration: underline;
}

.file-hint {
  font-size: 12px;
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
  font-size: 12px;
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
  font-size: 16px;
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
  font-size: 12px;
  color: var(--zw-green-deep);
}

.mine-table {
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  overflow: hidden;
}

/* 【T3 · P3-2】窄屏卡片流 */
.mine-cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mine-card {
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  padding: 12px 14px;
  background: var(--zw-surface);
}

.mc-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--zw-ink);
  word-break: break-word;
}

.mc-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 6px;
  flex-wrap: wrap;
}

.mc-time {
  font-size: 12px;
  color: var(--zw-faint);
}

.mc-note {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}

.reason {
  color: #c0392b;
}

.ok-note {
  color: var(--zw-green);
  font-size: 13px;
}

.pending-note {
  color: var(--zw-muted);
  font-size: 13px;
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
