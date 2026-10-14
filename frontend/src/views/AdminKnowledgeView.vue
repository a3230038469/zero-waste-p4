<script setup lang="ts">
/**
 * 老师后台 · 资料管理 —— 2026-10-08 本地演示版新增
 *
 * 路由：/admin/knowledge
 * 数据源：GET /api/admin/knowledge（需请求头 X-Admin-Token）
 *
 * 已接：列出全部资料、上传（可一并填标签）、删除、下载、问答设置（T3，2026-10-10）、
 *   解析失败行的「重新上传」（T6，2026-10-12：后端取回原件→删旧→重传→补回标签）、
 *   智能体设置（T7，2026-10-13：网页问答的「大脑」= 引擎里那个智能体，配置在这里改）。
 *   上传后引擎在后台解析，状态先显示「处理中」。
 *   删除成功后延迟 3 秒再刷新 —— 引擎删除有几秒延迟，列表会短暂仍返回它。
 *
 * 2026-10-11 合并适配（第三方）：本站改造新增了全局设计令牌（src/styles/global.css），
 *   本页原先的硬编码色值（#1f3a24 / #6b7d6b / #8a9a8a …）与之是两套体系，
 *   会让 T3 新增的「问答设置」卡片看起来像另一个站拼进来的。
 *   已把色值统一收敛到 var(--zw-*)，视觉不变、以后调色只需改一处。
 *
 * 2026-10-13（T7）：「问答设置」卡片**升级为「智能体设置」**。
 *   原因：网站的提示词 / 模型 / 长度上限 / 兜底文案已经搬进引擎的智能体了，
 *   在这里再选「回答方式（风格）」只会和智能体的 system_prompt 打架 —— 风格项已下线。
 *   保存后把后端的「四项回读校验」逐项显示出来（哪一项没过就写哪一项）。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import {
  ADMIN_TOKEN_KEY,
  UPLOAD_ACCEPT,
  deleteKnowledge,
  fetchAgentConfig,
  fetchKnowledgeList,
  reuploadKnowledge,
  saveAgentConfig,
  uploadKnowledge,
  type AdminKnowledgeItem,
  type AgentCheck,
  type AgentConfigPayload
} from '../api/admin'

const PAGE_SIZE = 20

const token = ref('')
const items = ref<AdminKnowledgeItem[]>([])
const loading = ref(false)
const errorText = ref('')
const keyword = ref('')
const page = ref(1)

/** 关键词过滤（标题或所在文件夹） */
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return items.value
  return items.value.filter(
    (x) => x.title.toLowerCase().includes(kw) || x.folderPath.toLowerCase().includes(kw)
  )
})

/** 前端分页（600 条量级，够用） */
const pageItems = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return filtered.value.slice(start, start + PAGE_SIZE)
})

/** 已入库 / 解析失败 / 有标签 */
const storedCount = computed(() => items.value.filter((x) => x.parseStatus === 'completed').length)
const failedCount = computed(() => items.value.filter((x) => x.parseStatus === 'failed').length)
const taggedCount = computed(() => items.value.filter((x) => hasMeta(x)).length)

/** 一条资料有没有机构/年份/类型标签 */
function hasMeta(row: AdminKnowledgeItem): boolean {
  return Boolean(row.meta && (row.meta.org || row.meta.year || row.meta.type))
}

/**
 * 引擎解析状态 → 表格里显示的文字。
 *
 * ⚠️ 引擎「还在处理」不止一个值：实测有 pending / processing / finalizing 三种
 * （重新上传、新上传的资料都会经过它们）。别只认 `processing` —— 漏一个老师
 * 就会在表格里看到一串英文（2026-10-12 实测踩中）。
 */
function statusTag(status: string): { type: 'success' | 'warning' | 'danger' | 'info'; text: string } {
  if (status === 'completed') return { type: 'success', text: '已入库' }
  if (status === 'failed') return { type: 'danger', text: '解析失败' }
  if (status === 'pending' || status === 'processing' || status === 'finalizing') {
    return { type: 'warning', text: '处理中' }
  }
  return { type: 'info', text: status || '未知' }
}

function formatSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function shortDate(value: string): string {
  return value ? value.slice(0, 10) : '—'
}

async function load(): Promise<void> {
  if (!token.value) {
    errorText.value = '请输入管理口令'
    return
  }
  loading.value = true
  try {
    const data = await fetchKnowledgeList(token.value)
    items.value = data.items ?? []
    errorText.value = ''
    page.value = 1
    localStorage.setItem(ADMIN_TOKEN_KEY, token.value)
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    errorText.value =
      response?.status === 403
        ? '口令不正确。'
        : (response?.data?.error?.message ?? '拉取失败，看看后端（:4000）在不在。')
    items.value = []
  } finally {
    loading.value = false
  }
}

/**
 * 下载原件：后端按「年份-机构-标题」命名并直接推文件流。
 * 用 fetch + blob 而不是直接开链接 —— 这样接口报错时能弹提示，
 * 而不是让浏览器把错误 JSON 当文件下载下来。
 */
async function download(row: AdminKnowledgeItem): Promise<void> {
  const base = import.meta.env.VITE_API_BASE ?? 'http://localhost:4000/api'
  try {
    const res = await fetch(`${base}/docs/${encodeURIComponent(row.id)}/download`)
    if (!res.ok) {
      ElMessage.error(`下载失败（${res.status}），这份资料可能已经被删掉了`)
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  } catch {
    ElMessage.error('下载失败，看看后端（:4000）在不在')
  }
}

/* ---------------- 删除资料 ---------------- */

const deletingId = ref('')

async function confirmDelete(row: AdminKnowledgeItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定要删除「${row.title}」吗？删掉之后，书架和 AI 问答里都不会再有它了。`,
      '删除资料',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return // 用户点了取消
  }

  deletingId.value = row.id
  try {
    await deleteKnowledge(token.value, row.id)
    ElMessage.success(`「${row.title}」已删除`)
    // 引擎删除有短暂延迟（列表接口会先返回它一会儿），等 3 秒再刷新，免得老师以为没删掉
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await load()
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    const message = response?.data?.error?.message ?? '删除失败，看看后端（:4000）在不在'
    if (response?.status === 404) {
      ElMessage.warning(message)
      await load()
    } else {
      ElMessage.error(message)
    }
  } finally {
    deletingId.value = ''
  }
}

/* ---------------- 重新上传（T6：解析失败 → 删旧重传） ---------------- */

/** 正在重新上传的那一行 id；空串 = 没有。用它做 loading，只转这一行不转全表 */
const reuploadingId = ref('')

async function confirmReupload(row: AdminKnowledgeItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `「${row.title}」上次解析失败了。要重新上传吗？` +
        '系统会从引擎里取回原件、删掉这份失败的、再原样传一遍，机构/年份/类型标签都会保留。',
      '重新上传',
      { type: 'warning', confirmButtonText: '重新上传', cancelButtonText: '取消' }
    )
  } catch {
    return // 用户点了取消
  }

  reuploadingId.value = row.id
  try {
    const result = await reuploadKnowledge(token.value, row.id)
    ElMessage.success('已重新上传，引擎正在解析')
    // 标签没带回来时**额外**说明一句，别让老师以为标签还在
    if (result.metaNote) ElMessage.warning(result.metaNote)
    // 链路上刚删过旧记录，而引擎删除有几秒延迟（列表会短暂仍返回它），
    // 等一下再刷新，免得表格里同时出现新旧两份、以为重传了两遍
    await new Promise((resolve) => setTimeout(resolve, 2000))
    await load()
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    const message = response?.data?.error?.message ?? '重新上传失败，看看后端（:4000）在不在'
    if (response?.status === 404) {
      ElMessage.warning(message)
      await load()
    } else {
      ElMessage.error(message)
    }
  } finally {
    reuploadingId.value = ''
  }
}

/* ---------------- 上传资料（带标签） ---------------- */

/** 类型下拉的预设值：直接取库里现有资料用过的分类，省得老师自己编 */
const TYPE_OPTIONS = [
  '国内政策法规',
  '研究实践报告',
  '科学认知',
  '国际公约',
  '研究报告',
  '各类标准',
  '政策法规',
  '案例工具'
]

const uploadDialog = ref(false)
const uploadFile = ref<File | null>(null)
const uploadForm = ref({ org: '', year: '', type: '', tags: [] as string[] })
const uploading = ref(false)
/** 「领域」多选的候选值：从库里现有主题现拉，避免手打导致主题词对不齐 */
const TAG_OPTIONS = ref<string[]>([])

/** 拉取库里已有的主题词，作为「领域」多选下拉的选项（拉不到就留空，仍可自己输入） */
async function loadTagOptions(): Promise<void> {
  try {
    const res = await fetch('/api/docs/facets')
    const data = (await res.json()) as { tags?: { value: string }[] }
    TAG_OPTIONS.value = (data.tags ?? []).map((t) => t.value)
  } catch {
    TAG_OPTIONS.value = []
  }
}

function openUpload(): void {
  if (!token.value) {
    errorText.value = '先输入口令、点「进入」，再上传'
    return
  }
  uploadFile.value = null
  uploadForm.value = { org: '', year: '', type: '', tags: [] }
  void loadTagOptions()
  uploadDialog.value = true
}

function onUploadFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement
  uploadFile.value = input.files?.[0] ?? null
}

async function submitUpload(): Promise<void> {
  if (!uploadFile.value) {
    ElMessage.warning('先选一个文件')
    return
  }
  uploading.value = true
  const name = uploadFile.value.name
  try {
    // 「领域」多选在界面上是数组，提交时拼成逗号分隔字符串（后端与引擎存的就是字符串）
    const payload = { ...uploadForm.value, tags: uploadForm.value.tags.join(',') }
    const result = await uploadKnowledge(token.value, uploadFile.value, payload)
    // 标签没写成功时如实说，不糊弄成「已完成」
    if (result.metaSaved) {
      ElMessage.success(`「${name}」已上传，机构/年份/类型标签也写好了`)
    } else if (result.metaNote) {
      ElMessage.warning(`「${name}」已上传。${result.metaNote}`)
    } else {
      ElMessage.success(`「${name}」已上传，引擎正在后台解析`)
    }
    uploadDialog.value = false
    await load()
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    ElMessage.error(response?.data?.error?.message ?? '上传失败，看看后端（:4000）在不在')
  } finally {
    uploading.value = false
  }
}

onMounted(() => {
  const saved = localStorage.getItem(ADMIN_TOKEN_KEY)
  if (saved) {
    token.value = saved
    void load()
    void loadAgent()
  }
})

/* ---------------- 智能体设置（T7：问答走智能体 + 设置上网页） ---------------- */

/**
 * 卡片形态：6 个可改字段 + 4 组只读字段。
 *
 * ⚠️ 与 T3 的「问答设置」有两处本质差别，界面上要说清楚：
 *   1. 这里改的是**引擎里那个智能体本体**，不是我们的设置文件 —— 改完问答立刻换一套脑子；
 *   2. 「回答方式（风格）」已下线 —— 提示词改由智能体的 system_prompt 统一提供，
 *      再拼一段风格前缀会和它打架（后端走智能体时也确实不再拼了）。
 */
const agentLoading = ref(false)
const agentSaving = ref(false)
const agentError = ref('')
const agentModels = ref<{ id: string; name: string; status: string }[]>([])
const agentModelsError = ref('')
const agentName = ref('')
const agentUpdatedAt = ref('')
/** 知识库范围红线：引擎里若被改成 all，这条链路会直接拒绝写入 */
const agentKbMode = ref('')
const agentKbIds = ref<string[]>([])
const agentIntentPrompts = ref<Array<{ key: string; length: number }>>([])
const agentMode = ref('')

/** 正在编辑的 6 个可改字段 */
const agentForm = ref({
  system_prompt: '',
  model_id: '',
  temperature: 0,
  max_completion_tokens: 0,
  fallback_strategy: 'fixed',
  fallback_response: ''
})
/** 已保存、但现在生效中的值（回显用，避免和正在编辑的值混为一谈） */
const agentSaved = ref({ ...agentForm.value })
/** 上一次保存后的回读校验结果（逐项显示「哪一项过 / 哪一项不过」） */
const agentChecks = ref<AgentCheck[]>([])

/** 当前模型在引擎列表里查不到 → 老师得重新选一个，别装作一切正常 */
const agentModelMissing = computed(
  () => Boolean(agentSaved.value.model_id) && !agentModels.value.some((m) => m.id === agentSaved.value.model_id)
)

/** 引擎里正在下载 / 下载失败的模型，选了大概率答不出来 */
function agentModelDisabled(status: string): boolean {
  return status !== 'active'
}

function agentModelLabel(name: string, status: string): string {
  return status === 'active' ? name : `${name}（${status === 'downloading' ? '下载中' : '不可用'}）`
}

/** 兜底口径的人话说明（fixed 与 model 的差别很大，写清楚比写英文 key 有用） */
function fallbackLabel(value: string): string {
  if (value === 'fixed') return '固定文案（答不上来就说「库内暂未收录」）'
  if (value === 'model') return '交给模型自己发挥'
  return value || '（未设置）'
}

/** 把接口返回的白名单视图铺到表单与只读区 */
function applyAgentView(d: AgentConfigPayload): void {
  agentName.value = d.name ?? ''
  agentUpdatedAt.value = d.updatedAt ?? ''
  agentModels.value = d.models ?? []
  agentModelsError.value = d.modelsError ?? ''
  agentKbMode.value = d.readonly?.kb_selection_mode ?? ''
  agentKbIds.value = d.readonly?.knowledge_bases ?? []
  agentIntentPrompts.value = d.readonly?.intent_prompts ?? []
  agentMode.value = d.readonly?.agent_mode ?? ''
  agentForm.value = {
    system_prompt: d.editable?.system_prompt ?? '',
    model_id: d.editable?.model_id ?? '',
    temperature: d.editable?.temperature ?? 0,
    max_completion_tokens: d.editable?.max_completion_tokens ?? 0,
    fallback_strategy: d.editable?.fallback_strategy ?? 'fixed',
    fallback_response: d.editable?.fallback_response ?? ''
  }
  agentSaved.value = { ...agentForm.value }
}

async function loadAgent(): Promise<void> {
  if (!token.value) return
  agentLoading.value = true
  agentError.value = ''
  try {
    applyAgentView(await fetchAgentConfig(token.value))
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    agentError.value =
      response?.data?.error?.message ?? '智能体设置拉取失败，看看后端（:4000）在不在。'
  } finally {
    agentLoading.value = false
  }
}

/**
 * 保存。
 *
 * ⚠️ 几个刻意为之的细节：
 *   - 传空串 = 「不改这一项」（后端已这样处理），所以这里不做「空值兜底成旧值」的加工，
 *     只把 6 个字段原样交出去，后端比对着改；
 *   - 存完以后端回显的为准 —— **不乐观更新**，否则校验没过界面还显示成功；
 *   - 回读校验结果原样显示（`agentChecks`），哪一项不过就写哪一项。
 */
async function submitAgent(): Promise<void> {
  agentSaving.value = true
  try {
    const d = await saveAgentConfig(token.value, {
      system_prompt: agentForm.value.system_prompt,
      model_id: agentForm.value.model_id,
      temperature: agentForm.value.temperature,
      max_completion_tokens: agentForm.value.max_completion_tokens,
      fallback_strategy: agentForm.value.fallback_strategy,
      fallback_response: agentForm.value.fallback_response
    })
    applyAgentView(d.after)
    agentChecks.value = d.checks ?? []
    const failed = agentChecks.value.filter((c) => !c.ok)
    if (failed.length > 0) {
      ElMessage.error('已写入，但回读校验没过，请看下面的逐项结果')
    } else {
      ElMessage.success(d.message || '已保存，问答立刻按新设置走')
    }
    // 被忽略的空字段要如实说一句，别让老师以为「清空」生效了
    if (d.ignored && d.ignored.length > 0) {
      ElMessage.warning(`这几项填的是空值，已保持原样没改：${d.ignored.join('、')}`)
    }
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    // 后端把「哪一项没过」写进了 message，如实展示，别压成一句「保存失败」
    ElMessage.error(response?.data?.error?.message ?? '保存失败，看看后端（:4000）在不在')
    // 保存失败也要让老师看到「现在是生效中的值」——重新拉一次，别让表单停在半改状态
    await loadAgent()
  } finally {
    agentSaving.value = false
  }
}

/** 「进入」按钮：口令对上了才去拉智能体设置 */
async function enterAdmin(): Promise<void> {
  await load()
  if (!errorText.value) await loadAgent()
}
</script>

<template>
  <section class="admin-kb">
    <header class="kb-head">
      <div>
        <h2 class="kb-title">资料管理</h2>
        <p class="kb-sub">
          这里管的是<b>知识库里的全部资料</b>——网页书架和 AI 问答用的都是它。
        </p>
      </div>
      <div class="kb-actions">
        <el-button type="primary" @click="openUpload">上传资料</el-button>
      </div>
    </header>

    <nav class="admin-nav">
      <router-link to="/admin/knowledge">资料管理</router-link>
      <router-link to="/admin/users">注册用户</router-link>
      <!-- B09（2026-10-13）：只加了一条导航链接指向新增的投稿审核页，未动本页任何逻辑 -->
      <router-link to="/admin/contributions">投稿审核</router-link>
      <router-link to="/admin/stats">数据看板</router-link>
    </nav>

    <el-card shadow="never" class="token-card">
      <div class="token-row">
        <el-input
          v-model="token"
          type="password"
          show-password
          placeholder="管理口令（backend/.env 里的 ADMIN_STATS_TOKEN）"
          @keyup.enter="enterAdmin"
        />
        <el-button type="primary" :loading="loading" @click="enterAdmin">进入</el-button>
      </div>
      <p v-if="errorText" class="err">{{ errorText }}</p>
    </el-card>

    <template v-if="items.length">
      <div class="kb-stat">
        <span>共 <b>{{ items.length }}</b> 份</span>
        <span class="dot">·</span>
        <span>已入库 <b class="ok">{{ storedCount }}</b></span>
        <span v-if="failedCount" class="dot">·</span>
        <span v-if="failedCount">解析失败 <b class="bad">{{ failedCount }}</b></span>
        <span class="dot">·</span>
        <span>已带标签 <b class="ok">{{ taggedCount }}</b></span>
      </div>

      <!-- 智能体设置（T7）：网站问答的「大脑」就是引擎里这个智能体，改这里问答立刻生效 -->
      <el-card shadow="never" class="qa-card">
        <div class="qa-head">
          <h3 class="qa-title">智能体设置</h3>
          <span class="qa-now">
            智能体：{{ agentName || '（未取到）' }} ·
            回答长度上限 {{ agentSaved.max_completion_tokens }} ·
            随机度 {{ agentSaved.temperature }} ·
            答不上来时{{ fallbackLabel(agentSaved.fallback_strategy) }}
          </span>
        </div>

        <p class="qa-lead">
          这里的修改会<b>直接写入引擎的智能体</b>，下次提问立刻生效；
          漏改的字段不会被清空（后端先读全量、只改你动过的那几项，再整份写回）。
        </p>

        <p v-if="agentError" class="qa-warn">{{ agentError }}</p>
        <p v-else-if="agentModelsError" class="qa-warn">{{ agentModelsError }}</p>
        <p v-else-if="agentModelMissing" class="qa-warn">
          当前生效的模型（{{ agentSaved.model_id }}）在引擎里已经找不到了，请重新选一个并保存。
        </p>
        <p v-else-if="agentKbMode && agentKbMode !== 'selected'" class="qa-warn">
          ⚠️ 智能体的知识库范围现在是「{{ agentKbMode }}」——这会把不相干的库（如 123 份
          「AI系统学习」）一起拉进检索。本页不会替你改这个口径，请到引擎里改回「按选择」再保存。
        </p>

        <div class="qa-grid">
          <div class="qa-field">
            <label>回答模型</label>
            <el-select
              v-model="agentForm.model_id"
              :loading="agentLoading"
              :disabled="agentLoading || Boolean(agentModelsError)"
              placeholder="跟随智能体配置"
              style="width: 100%"
            >
              <el-option
                v-for="m in agentModels"
                :key="m.id"
                :value="m.id"
                :label="agentModelLabel(m.name, m.status)"
                :disabled="agentModelDisabled(m.status)"
              />
            </el-select>
            <p class="qa-hint">
              这是智能体自己用的模型（不再是知识库那个「回答模型」）。换模型等于换脑子。
            </p>
          </div>

          <div class="qa-field">
            <label>回答随机度（temperature）</label>
            <el-input-number
              v-model="agentForm.temperature"
              :min="0"
              :max="1"
              :step="0.1"
              :precision="2"
              style="width: 100%"
            />
            <p class="qa-hint">0 最确定、1 最发散。资料问答建议 0 到 0.5。</p>
          </div>

          <div class="qa-field">
            <label>回答长度上限（max_completion_tokens）</label>
            <el-input-number
              v-model="agentForm.max_completion_tokens"
              :min="256"
              :max="65536"
              :step="512"
              style="width: 100%"
            />
            <p class="qa-hint">
              🔴 这一项千万别调小：调回 1024 会让宽泛问题的长回答被截断（以前修过的 bug）。
            </p>
          </div>

          <div class="qa-field">
            <label>答不上来时怎么办</label>
            <el-select v-model="agentForm.fallback_strategy" style="width: 100%">
              <el-option value="fixed" label="固定文案（说「库内暂未收录」，推荐）" />
              <el-option value="model" label="交给模型自己发挥（不建议）" />
            </el-select>
            <p class="qa-hint">
              🔴 改成「交给模型自己发挥」，「库内暂未收录」就不再是固定文案了，模型可能编。
            </p>
          </div>
        </div>

        <div class="qa-field qa-wide">
          <label>系统提示词（system_prompt）· {{ agentForm.system_prompt.length }} 字</label>
          <el-input
            v-model="agentForm.system_prompt"
            type="textarea"
            :rows="12"
            placeholder="智能体回答问题的总规则"
          />
          <p class="qa-hint">
            这是智能体的总规则（只用库内内容、逐条作答、结尾说依据）。
            🔴 清空会让它变成自由发挥 —— 本页按「空值 = 不改」处理，不会让它被抹掉。
          </p>
        </div>

        <div class="qa-field qa-wide">
          <label>答不上来时的固定文案（fallback_response）· {{ agentForm.fallback_response.length }} 字</label>
          <el-input v-model="agentForm.fallback_response" type="textarea" :rows="6" />
        </div>

        <!-- 只读展示的 4 组字段：看得见，但不提交（提交了后端也会丢掉） -->
        <div class="qa-readonly">
          <span class="qa-ro-label">只读（不在本页改）</span>
          <span>关联知识库：{{ agentKbIds.length ? agentKbIds.join('、') : '（未关联）' }}</span>
          <span>范围口径：{{ agentKbMode || '—' }}</span>
          <span>智能体模式：{{ agentMode || '—' }}</span>
          <span>意图提示词：{{ agentIntentPrompts.length }} 段（{{ agentIntentPrompts.map((p) => p.key).join('、') }}）</span>
        </div>
        <p class="qa-hint">
          「思考强度」原来在本卡片里，现在由智能体在引擎侧的配置决定，本页不提供开关 ——
          硬改它会和智能体自己的设置打架。
        </p>

        <div class="qa-foot">
          <el-button type="primary" :loading="agentSaving" @click="submitAgent">
            {{ agentSaving ? '保存中…' : '保存智能体设置' }}
          </el-button>
          <span v-if="agentUpdatedAt" class="qa-time">
            引擎侧最后更新：{{ agentUpdatedAt.slice(0, 16).replace('T', ' ') }}
          </span>
        </div>

        <!-- 回读校验结果：保存后逐项显示，失败项写清「期望 / 实际」 -->
        <div v-if="agentChecks.length" class="qa-checks">
          <div class="qa-checks-title">保存后回读校验（后端重新读了一遍引擎）</div>
          <div v-for="c in agentChecks" :key="c.key" class="qa-check" :class="c.ok ? 'ok' : 'bad'">
            <span class="mark">{{ c.ok ? '通过' : '未通过' }}</span>
            <span class="name">{{ c.label }}</span>
            <span class="val">期望 {{ c.expected }} ／ 实际 {{ c.actual }}</span>
          </div>
        </div>
      </el-card>

      <div class="kb-bar">
        <el-input v-model="keyword" placeholder="按标题或文件夹筛选" clearable />
        <span class="count">筛出 {{ filtered.length }} 份</span>
      </div>

      <el-table :data="pageItems" size="small" border class="kb-table">
        <el-table-column type="index" label="#" width="52" />
        <el-table-column prop="title" label="资料标题" min-width="250" show-overflow-tooltip />
        <el-table-column label="标签（机构 · 年份 · 类型）" min-width="250">
          <template #default="scope">
            <div v-if="hasMeta(scope.row)" class="meta-cell">
              <span class="meta-org" :title="scope.row.meta.org">
                {{ scope.row.meta.org || '机构未填' }}
              </span>
              <span class="meta-year">{{ scope.row.meta.year || '年份未填' }}</span>
              <el-tag size="small" type="info" effect="plain">
                {{ scope.row.meta.type || '未分类' }}
              </el-tag>
            </div>
            <span v-else class="no-meta">无标签</span>
          </template>
        </el-table-column>
        <el-table-column label="文件" width="70" align="center">
          <template #default="scope">{{ scope.row.fileType || '—' }}</template>
        </el-table-column>
        <el-table-column label="大小" width="86" align="right">
          <template #default="scope">{{ formatSize(scope.row.size) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="92" align="center">
          <template #default="scope">
            <el-tag size="small" :type="statusTag(scope.row.parseStatus).type">
              {{ statusTag(scope.row.parseStatus).text }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="入库时间" width="108" align="center">
          <template #default="scope">{{ shortDate(scope.row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="196" align="center" fixed="right">
          <template #default="scope">
            <el-button link type="primary" size="small" @click="download(scope.row)">下载</el-button>
            <el-button
              v-if="scope.row.parseStatus === 'failed'"
              link
              type="warning"
              size="small"
              :loading="reuploadingId === scope.row.id"
              @click="confirmReupload(scope.row)"
            >
              重新上传
            </el-button>
            <el-button
              link
              type="danger"
              size="small"
              :loading="deletingId === scope.row.id"
              @click="confirmDelete(scope.row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        :page-size="PAGE_SIZE"
        :total="filtered.length"
        layout="prev, pager, next, total"
        class="kb-pager"
      />
    </template>

    <el-dialog v-model="uploadDialog" title="上传资料" width="540px">
      <el-form label-width="76px" label-position="left">
        <el-form-item label="文件">
          <input
            ref="uploadInput"
            type="file"
            :accept="UPLOAD_ACCEPT"
            class="file-input"
            @change="onUploadFilePicked"
          />
          <span class="picked">{{ uploadFile ? uploadFile.name : '还没选文件' }}</span>
        </el-form-item>
        <el-form-item label="发布机构">
          <el-input v-model="uploadForm.org" placeholder="例如：生态环境部" clearable />
        </el-form-item>
        <el-form-item label="发布年份">
          <el-input v-model="uploadForm.year" maxlength="4" placeholder="四位数字，例如 2024" clearable />
        </el-form-item>
        <el-form-item label="类型">
          <el-select
            v-model="uploadForm.type"
            filterable
            allow-create
            default-first-option
            placeholder="选一个，或自己填"
            style="width: 100%"
          >
            <el-option v-for="t in TYPE_OPTIONS" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="领域">
          <el-select
            v-model="uploadForm.tags"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="可多选；没有想要的就直接输入新主题"
            style="width: 100%"
          >
            <el-option v-for="t in TAG_OPTIONS" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
      </el-form>
      <p class="dlg-hint">
        这四项不用都填。填了就会显示在资料的标签上，也会出现在书架的筛选项里。
      </p>
      <template #footer>
        <el-button @click="uploadDialog = false">取消</el-button>
        <el-button type="primary" :loading="uploading" @click="submitUpload">
          {{ uploading ? '上传中…' : '开始上传' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.admin-kb {
  max-width: 1100px;
  margin: 0 auto;
  padding: 20px 16px 60px;
}
.kb-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.kb-title {
  margin: 0 0 6px;
  font-size: 22px;
  color: var(--zw-green-ink);
}
.kb-sub {
  margin: 0;
  font-size: 13px;
  color: var(--zw-muted);
}
.kb-actions {
  padding-top: 4px;
}
.file-input {
  font-size: 13px;
  color: var(--zw-text);
}
.picked {
  margin-left: 10px;
  font-size: 13px;
  color: var(--zw-muted);
}
.token-card {
  margin: 14px 0;
  border-radius: 10px;
}
.token-row {
  display: flex;
  gap: 8px;
}
.err {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--zw-amber);
}
.admin-nav {
  display: flex;
  gap: 18px;
  margin: 12px 0 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--zw-line);
  font-size: 14px;
}
.admin-nav a {
  color: var(--zw-muted);
  text-decoration: none;
  padding: 2px 2px 6px;
  border-bottom: 2px solid transparent;
}
.admin-nav a:hover {
  color: var(--zw-green-ink);
}
.admin-nav a.router-link-active {
  color: var(--zw-green-ink);
  font-weight: 500;
  border-bottom-color: var(--zw-green);
}
.kb-stat {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 10px;
  font-size: 14px;
  color: var(--zw-text);
}
.kb-stat .ok {
  color: var(--zw-green);
}
.kb-stat .bad {
  color: #c45656;
}
.kb-stat .dot {
  color: var(--zw-line-strong);
}
.kb-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.qa-card {
  margin: 0 0 14px;
  border-radius: 10px;
}
.qa-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.qa-title {
  margin: 0;
  font-size: 15px;
  color: var(--zw-green-ink);
}
.qa-now {
  font-size: 12px;
  color: var(--zw-muted);
}
.qa-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}
.qa-field label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--zw-text);
}
.qa-hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--zw-faint);
}
.qa-warn {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--zw-amber);
}
.qa-lead {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--zw-text);
}
.qa-wide {
  margin-top: 16px;
}
.qa-readonly {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--zw-line);
  font-size: 12px;
  color: var(--zw-muted);
}
.qa-ro-label {
  color: var(--zw-faint);
}
.qa-checks {
  margin-top: 16px;
  padding: 12px;
  border-radius: 8px;
  background: #f7faf7;
}
.qa-checks-title {
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--zw-green-ink);
}
.qa-check {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 3px 0;
  font-size: 12px;
  color: var(--zw-muted);
}
.qa-check .mark {
  flex: 0 0 auto;
  min-width: 42px;
  font-weight: 600;
}
.qa-check.ok .mark {
  color: var(--zw-green);
}
.qa-check.bad .mark {
  color: #c45656;
}
.qa-check .name {
  flex: 0 0 auto;
  color: var(--zw-text);
}
.qa-check .val {
  font-variant-numeric: tabular-nums;
}
.qa-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}
.qa-time {
  font-size: 12px;
  color: var(--zw-faint);
  font-variant-numeric: tabular-nums;
}
.kb-bar .count {
  font-size: 13px;
  color: var(--zw-muted);
}
.kb-table {
  background: #fff;
}
.kb-pager {
  margin-top: 14px;
  justify-content: flex-end;
}
.meta-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.meta-org {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--zw-text);
}
.meta-year {
  color: var(--zw-muted);
  font-variant-numeric: tabular-nums;
}
.no-meta {
  color: var(--zw-line-strong);
}
.dlg-hint {
  margin: 0;
  font-size: 12px;
  color: var(--zw-faint);
}
</style>
