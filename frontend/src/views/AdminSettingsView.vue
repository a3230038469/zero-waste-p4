<script setup lang="ts">
/**
 * 老师后台 · 设置 —— 路由 /admin/settings
 *
 * 2026-10-20 改版（按老师意见重排分区、合并重复设置、精简文案）：
 *   ① 智能体设置：把「MinerU / 解析引擎设置」并进来，解析引擎只留 1 个 API Key。
 *      默认只露「回答模型 + 回答模式（快速 / 思考）+ API Key」，其余项收进「详细设置」，点开才展开。
 *   ② 回答模型：随机度 / 长度上限 / 答不上来时的策略 / 固定文案。
 *   ③ 游客权限：开关清单（服务端真拦，页面只负责显隐体验）。
 *   ④ 一键自检：放到最下面，按钮 + 四项结果。
 *
 * 删掉的：页头副标题、每块开头的大段说明、字段下方的小字提示、解析引擎可用状态列表、
 * 测试连接按钮、常驻的回读校验面板（改成只有「有项没过」时才出现）、各处「上次更新」时间。
 *
 * ⚠️ 密钥三铁律照旧（接口与保存链路一行没改）：
 *   - 输入框留空 = 不改（后端不提交这个字段，引擎保留原值）；
 *   - 页面从头到尾不显示、不缓存、不打印任何密钥明文；
 *   - 绝不把占位值当新密钥提交（填了 `***` 就等于把真密钥覆盖成 `***`）。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

import {
  fetchAgentConfig,
  fetchGuestPermissions,
  fetchParserConfig,
  runSelfcheck,
  saveAgentConfig,
  saveGuestPermissions,
  saveParserConfig,
  type AgentCheck,
  type AgentConfigPayload,
  type GuestPermissionCheck,
  type ParserFieldCheck,
  type SelfcheckItem
} from '../api/admin'
import { GUEST_FALLBACK_VALUES, type GuestPermissionValues, type GuestSwitchItem } from '../api/guest'

function errorMessage(err: unknown, fallback: string): string {
  const response = (err as { response?: { status?: number; data?: { error?: { message?: string } } } })
    .response
  if (response?.status === 403) return '当前账号不是管理员。'
  return response?.data?.error?.message ?? fallback
}

/** 回读校验：只把「没通过」的项留在页面上（全过就只弹一句成功，不占版面） */
function failedAgentChecks(checks: AgentCheck[] | undefined): AgentCheck[] {
  return (checks ?? []).filter((c) => !c.ok)
}
function failedParserChecks(checks: ParserFieldCheck[] | undefined): ParserFieldCheck[] {
  return (checks ?? []).filter((c) => !c.ok)
}
function failedGuestChecks(checks: GuestPermissionCheck[] | undefined): GuestPermissionCheck[] {
  return (checks ?? []).filter((c) => !c.ok)
}

/* ------------------------------------------------------------------ *
 * ① 智能体设置（含 MinerU 解析引擎的 API Key）
 * ------------------------------------------------------------------ */

const agentLoading = ref(false)
const agentSaving = ref(false)
const agentError = ref('')
const agentModels = ref<{ id: string; name: string; status: string }[]>([])
const agentModelsError = ref('')
/** 知识库范围红线：引擎里若被改成 all，这条链路会直接拒绝写入 */
const agentKbMode = ref('')
const agentKbIds = ref<string[]>([])
const agentIntentPrompts = ref<Array<{ key: string; length: number }>>([])
const agentMode = ref('')

/** 「详细设置」展开态：默认收起，只露模型与 API Key */
const detailsOpen = ref(false)

/** 正在编辑的 7 个可改字段（真实写入口径仍由后端合并校验） */
const agentForm = ref({
  system_prompt: '',
  model_id: '',
  temperature: 0,
  max_completion_tokens: 0,
  fallback_strategy: 'fixed',
  fallback_response: '',
  /** true = 思考模式（先想再答），false = 快速模式（直接答） */
  thinking: false
})
/** 已保存、现在生效中的值（只用来判断「当前模型是否还在引擎里」） */
const agentSaved = ref({ ...agentForm.value })
/** 上一次保存后没通过回读校验的项 */
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

/** 引擎里的 agent_mode（智能体架构，只读）翻成人话 */
function agentArchLabel(mode: string): string {
  if (mode === 'quick-answer') return '快速问答（RAG）'
  if (mode === 'smart-reasoning') return '智能推理（ReAct）'
  return mode || '—'
}

/** 把接口返回的白名单视图铺到表单与只读区 */
function applyAgentView(d: AgentConfigPayload): void {
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
    fallback_response: d.editable?.fallback_response ?? '',
    thinking: d.editable?.thinking === true
  }
  agentSaved.value = { ...agentForm.value }
}

async function loadAgent(): Promise<void> {
  agentLoading.value = true
  agentError.value = ''
  try {
    applyAgentView(await fetchAgentConfig())
  } catch (err) {
    agentError.value = errorMessage(err, '智能体设置拉取失败，看看后端（:4000）在不在。')
  } finally {
    agentLoading.value = false
  }
}

/**
 * 保存智能体设置（「智能体设置」与「回答模型」两块共用这一套口径）：
 *   - 六项一起提交，空串 = 不改这一项（后端会记进 ignored，这里如实提示）；
 *   - 不乐观更新，存完以后端回显为准；
 *   - 只把没通过回读校验的项留在页面上。
 */
async function submitAgentCard(): Promise<void> {
  if (agentSaving.value) return
  agentSaving.value = true
  agentChecks.value = []
  try {
    const d = await saveAgentConfig({
      system_prompt: agentForm.value.system_prompt,
      model_id: agentForm.value.model_id,
      temperature: agentForm.value.temperature,
      max_completion_tokens: agentForm.value.max_completion_tokens,
      fallback_strategy: agentForm.value.fallback_strategy,
      fallback_response: agentForm.value.fallback_response,
      thinking: agentForm.value.thinking
    })
    applyAgentView(d.after)
    agentChecks.value = failedAgentChecks(d.checks)
    if (d.ignored && d.ignored.length > 0) {
      ElMessage.warning(`这几项填的是空值，已保持原样没改：${d.ignored.join('、')}`)
    }
    // 顺手把填了新值的 MinerU API Key 一起存掉（没填就跳过）
    const keySubmitted = await saveMineruKeyIfAny()
    if (agentChecks.value.length > 0) {
      ElMessage.error(`已写入，但有 ${agentChecks.value.length} 项回读校验没过`)
    } else if (!keySubmitted) {
      ElMessage.success('已保存')
    }
  } catch (err) {
    ElMessage.error(errorMessage(err, '保存失败，看看后端（:4000）在不在'))
    await loadAgent()
  } finally {
    agentSaving.value = false
  }
}

/* ------------------------------------------------------------------ *
 * 解析引擎：只保留 MinerU 的 1 个 API Key（其余项已被去掉）
 * ------------------------------------------------------------------ */

const parserLoading = ref(false)
const parserSaving = ref(false)
const parserError = ref('')
/**
 * API Key 输入框。🔴 初始值恒为空串 —— 后端只回「已配置」，没有原值可填。
 * 留空 = 不改（后端不提交这个字段，引擎保留原值）。
 */
const mineruApiKey = ref('')
/** 密钥是否已配置（只显示状态，不回显原值） */
const mineruConfigured = ref(false)
/** 上一次保存后没通过回读校验的项 */
const parserChecks = ref<ParserFieldCheck[]>([])

async function loadParser(): Promise<void> {
  parserLoading.value = true
  parserError.value = ''
  try {
    const d = await fetchParserConfig()
    mineruConfigured.value = d.secrets?.['mineru_api_key']?.configured === true
  } catch (err) {
    parserError.value = errorMessage(err, '解析引擎设置拉取失败，看看后端（:4000）在不在。')
  } finally {
    parserLoading.value = false
  }
}

/**
 * 只有真填了新密钥才提交；空串绝不提交（后端也不接受空串当成新密钥）。
 * 返回「这次有没有提交 Key」——用来决定还要不要弹通用的「已保存」。
 */
async function saveMineruKeyIfAny(): Promise<boolean> {
  const key = mineruApiKey.value.trim()
  if (!key) return false
  parserSaving.value = true
  parserChecks.value = []
  try {
    const result = await saveParserConfig({ mineru_api_key: key })
    mineruConfigured.value = result.config?.secrets?.['mineru_api_key']?.configured === true
    mineruApiKey.value = ''
    parserChecks.value = failedParserChecks(result.checks)
    if (parserChecks.value.length > 0) {
      ElMessage.error('MinerU API Key 已提交，但回读校验没过')
    } else {
      ElMessage.success('MinerU API Key 已更新')
    }
  } catch (err) {
    ElMessage.error(errorMessage(err, 'MinerU API Key 保存失败'))
  } finally {
    parserSaving.value = false
  }
  return true
}

/* ------------------------------------------------------------------ *
 * ② 回答模型
 * ------------------------------------------------------------------ *
 * 这一块没有独立的接口：随机度 / 长度上限 / 兜底策略 / 固定文案
 * 都是智能体那 6 个可改字段的一部分，保存按钮直接走 submitAgentCard
 * （六项一起提交，避免「改了模型只点了这块的保存」导致漏存）。
 */

/* ------------------------------------------------------------------ *
 * ③ 游客权限（T11）
 * ------------------------------------------------------------------ *
 * 这块改的是我们自己的一个小 JSON（backend/data/guest-permissions.json）。
 * 清单与顺序由后端下发（switches[]），前端只照着渲染。
 * 🔴 前端只是「把按钮置灰」这层体验，真正的拦截在后端
 *    （routes/ask.ts / docs.ts / track.ts）。绕过前端直接调接口照样按同一份配置拒绝。
 */
const guestLoading = ref(false)
const guestSaving = ref(false)
const guestError = ref('')
/** 开关清单（后端下发；取不到时给一份兜底，保证这一块不至于空白） */
const guestSwitches = ref<GuestSwitchItem[]>([
  { key: 'browse', label: '浏览书架与搜索', hint: '', type: 'readonly', default: true, editable: false }
])
/** 正在编辑的值 */
const guestForm = ref<GuestPermissionValues>({ ...GUEST_FALLBACK_VALUES })
/** 上一次保存后没通过回读校验的项 */
const guestChecks = ref<GuestPermissionCheck[]>([])

function applyGuestView(d: {
  switches: GuestSwitchItem[]
  values: GuestPermissionValues
  updatedAt: string
}): void {
  if (d.switches && d.switches.length > 0) guestSwitches.value = d.switches
  guestForm.value = { ...GUEST_FALLBACK_VALUES, ...d.values }
}

async function loadGuest(): Promise<void> {
  guestLoading.value = true
  guestError.value = ''
  try {
    applyGuestView(await fetchGuestPermissions())
  } catch (err) {
    guestError.value = errorMessage(err, '游客权限拉取失败，看看后端（:4000）在不在。')
  } finally {
    guestLoading.value = false
  }
}

/** 保存：只提交「可改的键」，`browse` 是只读项，传了后端也会忽略 */
async function submitGuest(): Promise<void> {
  if (guestSaving.value) return
  guestSaving.value = true
  guestChecks.value = []
  try {
    const result = await saveGuestPermissions({
      aiAsk: guestForm.value.aiAsk,
      aiAskDailyLimit: guestForm.value.aiAskDailyLimit,
      preview: guestForm.value.preview,
      share: guestForm.value.share,
      feedback: guestForm.value.feedback,
      download: guestForm.value.download
    })
    applyGuestView(result.config)
    guestChecks.value = failedGuestChecks(result.checks)
    const failed = guestChecks.value.length
    if (failed > 0) {
      ElMessage.error(`已写入，但有 ${failed} 项回读校验没过`)
    } else {
      ElMessage.success('已保存')
    }
    if (result.ignored && result.ignored.length > 0) {
      ElMessage.warning(`这几项没有开关、已被忽略：${result.ignored.join('、')}`)
    }
  } catch (err) {
    ElMessage.error(errorMessage(err, '保存失败，看看后端（:4000）在不在'))
    // 存失败也要让老师看到「现在生效的是什么」——重新拉一次，别让表单停在半改状态
    await loadGuest()
  } finally {
    guestSaving.value = false
  }
}

/** 某个键这一行当前是不是「关」了（界面上标色用） */
function guestOff(key: string): boolean {
  return guestForm.value[key as keyof GuestPermissionValues] === false
}

/* ------------------------------------------------------------------ *
 * ④ 一键自检（页内最下面）
 * ------------------------------------------------------------------ */

const selfchecking = ref(false)
const selfcheckItems = ref<SelfcheckItem[]>([])

async function runCheck(): Promise<void> {
  selfchecking.value = true
  try {
    const result = await runSelfcheck()
    selfcheckItems.value = result.items ?? []
    // 失败项的原始原因打到控制台，页面上只给人话
    for (const item of selfcheckItems.value) {
      if (!item.ok && item.detail) console.warn(`[自检] ${item.label}：${item.detail}`)
    }
    if (result.ok) ElMessage.success('四项全部正常')
    else ElMessage.warning(`有 ${selfcheckItems.value.filter((i) => !i.ok).length} 项没通过，看下面的说明`)
  } catch (err) {
    ElMessage.error(errorMessage(err, '自检失败，看看后端（:4000）在不在'))
  } finally {
    selfchecking.value = false
  }
}

onMounted(() => {
  void loadAgent()
  void loadParser()
  void runCheck()
  void loadGuest()
})
</script>

<template>
  <section class="admin-settings">
    <header class="st-head">
      <h2 class="st-title">系统设置</h2>
    </header>

    <!-- ① 智能体设置（含 MinerU 解析引擎的 API Key） -->
    <el-card shadow="never" class="block">
      <div class="block-head">
        <h3 class="block-title">智能体设置</h3>
        <el-button
          link
          type="primary"
          size="small"
          class="details-toggle"
          :aria-expanded="detailsOpen"
          @click="detailsOpen = !detailsOpen"
        >
          {{ detailsOpen ? '收起详细设置 ▴' : '详细设置 ▾' }}
        </el-button>
      </div>

      <p v-if="agentError" class="warn">{{ agentError }}</p>
      <p v-else-if="agentModelsError" class="warn">{{ agentModelsError }}</p>
      <p v-else-if="agentModelMissing" class="warn">
        当前生效的模型（{{ agentSaved.model_id }}）在引擎里已经找不到了，请重新选一个再保存。
      </p>
      <p v-else-if="agentKbMode && agentKbMode !== 'selected'" class="warn">
        ⚠️ 智能体的知识库范围现在是「{{ agentKbMode }}」，会把不相干的库一起拉进检索。请到引擎里改回「按选择」。
      </p>

      <p v-if="parserError" class="warn">{{ parserError }}</p>

      <div class="grid">
        <div class="field">
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
        </div>

        <div class="field">
          <label>回答模式</label>
          <el-radio-group
            v-model="agentForm.thinking"
            class="mode-group"
            :disabled="agentLoading"
          >
            <el-radio-button :value="false">快速模式</el-radio-button>
            <el-radio-button :value="true">思考模式</el-radio-button>
          </el-radio-group>
        </div>

        <div class="field">
          <label>
            MinerU 云解析 API Key
            <span class="key-state" :class="mineruConfigured ? 'on' : 'off'">
              {{ mineruConfigured ? '已配置' : '未配置' }}
            </span>
          </label>
          <el-input
            v-model="mineruApiKey"
            type="password"
            show-password
            placeholder="留空 = 不改"
            autocomplete="new-password"
            :disabled="parserLoading || parserSaving"
          />
        </div>
      </div>

      <div v-show="detailsOpen" class="details">
        <div class="field">
          <label>系统提示词 <span class="count">{{ agentForm.system_prompt.length }} 字</span></label>
          <el-input
            v-model="agentForm.system_prompt"
            type="textarea"
            :rows="10"
            placeholder="智能体回答问题的总规则"
          />
        </div>

        <div class="readonly">
          <span><b>关联知识库</b>{{ agentKbIds.length ? agentKbIds.join('、') : '未关联' }}</span>
          <span><b>范围口径</b>{{ agentKbMode || '—' }}</span>
          <span><b>智能体架构</b>{{ agentArchLabel(agentMode) }}</span>
          <span><b>意图提示词</b>{{ agentIntentPrompts.length }} 段</span>
        </div>
      </div>

      <div class="foot">
        <el-button type="primary" :loading="agentSaving" @click="submitAgentCard">
          {{ agentSaving ? '保存中…' : '保存' }}
        </el-button>
      </div>

      <div v-if="agentChecks.length" class="checks">
        <div class="checks-title">回读校验未通过</div>
        <div v-for="c in agentChecks" :key="c.key" class="check">
          <span class="mark">未通过</span>
          <span class="name">{{ c.label }}</span>
          <span class="val">期望 {{ c.expected }} ／ 实际 {{ c.actual }}</span>
        </div>
      </div>

      <div v-if="parserChecks.length" class="checks">
        <div class="checks-title">MinerU API Key 回读校验未通过</div>
        <div v-for="c in parserChecks" :key="c.key" class="check">
          <span class="mark">未通过</span>
          <span class="name">{{ c.label }}</span>
          <span class="val">期望 {{ c.expected }} ／ 实际 {{ c.actual }}</span>
        </div>
      </div>
    </el-card>

    <!-- ② 回答模型 -->
    <el-card shadow="never" class="block">
      <div class="block-head">
        <h3 class="block-title">回答模型</h3>
      </div>

      <div class="grid">
        <div class="field">
          <label>随机度</label>
          <el-input-number
            v-model="agentForm.temperature"
            :min="0"
            :max="1"
            :step="0.1"
            :precision="2"
            style="width: 100%"
          />
          <p class="hint">0～1，越大越随机，越小越稳。</p>
        </div>

        <div class="field">
          <label>长度上限</label>
          <el-input-number
            v-model="agentForm.max_completion_tokens"
            :min="256"
            :max="65536"
            :step="512"
            style="width: 100%"
          />
          <p class="hint">越大能写得越长，但也更慢；8192 够日常问答。</p>
        </div>

        <div class="field">
          <label>答不上来时</label>
          <el-select v-model="agentForm.fallback_strategy" style="width: 100%">
            <el-option value="fixed" label="用固定文案" />
            <el-option value="model" label="交给模型自由发挥" />
          </el-select>
        </div>
      </div>

      <div class="field wide">
        <label>固定文案 <span class="count">{{ agentForm.fallback_response.length }} 字</span></label>
        <el-input v-model="agentForm.fallback_response" type="textarea" :rows="5" />
      </div>

      <div class="foot">
        <el-button type="primary" :loading="agentSaving" @click="submitAgentCard">
          {{ agentSaving ? '保存中…' : '保存' }}
        </el-button>
      </div>
    </el-card>

    <!-- ③ 游客权限 -->
    <el-card shadow="never" class="block">
      <div class="block-head">
        <h3 class="block-title">游客权限</h3>
      </div>

      <p v-if="guestError" class="warn">{{ guestError }}</p>

      <div class="guest-list">
        <div
          v-for="item in guestSwitches"
          :key="item.key"
          class="guest-row"
          :class="{ readonly: item.type === 'readonly' }"
        >
          <span class="guest-label">{{ item.label }}</span>

          <div class="guest-ctl">
            <!-- 只读项：不给开关，直接标「始终开放」 -->
            <span v-if="item.type === 'readonly'" class="guest-ro">始终开放</span>

            <!-- 每日上限：数字输入（0 = 不限） -->
            <template v-else-if="item.type === 'number'">
              <el-input-number
                v-model="guestForm.aiAskDailyLimit"
                :min="0"
                :max="9999"
                :step="1"
                controls-position="right"
                style="width: 130px"
              />
              <span class="guest-unit">次 / 天</span>
            </template>

            <!-- 开关 -->
            <template v-else>
              <el-switch
                v-if="item.key === 'aiAsk'"
                v-model="guestForm.aiAsk"
                :loading="guestLoading"
              />
              <el-switch
                v-else-if="item.key === 'preview'"
                v-model="guestForm.preview"
                :loading="guestLoading"
              />
              <el-switch
                v-else-if="item.key === 'share'"
                v-model="guestForm.share"
                :loading="guestLoading"
              />
              <el-switch
                v-else-if="item.key === 'feedback'"
                v-model="guestForm.feedback"
                :loading="guestLoading"
              />
              <el-switch v-else v-model="guestForm.download" :loading="guestLoading" />
              <span class="guest-state" :class="guestOff(item.key) ? 'off' : 'on'">
                {{ guestOff(item.key) ? '需登录' : '游客可用' }}
              </span>
            </template>
          </div>
        </div>
      </div>

      <div class="foot">
        <el-button type="primary" :loading="guestSaving" @click="submitGuest">
          {{ guestSaving ? '保存中…' : '保存' }}
        </el-button>
      </div>

      <div v-if="guestChecks.length" class="checks">
        <div class="checks-title">回读校验未通过</div>
        <div v-for="c in guestChecks" :key="c.key" class="check">
          <span class="mark">未通过</span>
          <span class="name">{{ c.label }}</span>
          <span class="val">期望 {{ c.expected }} ／ 实际 {{ c.actual }}</span>
        </div>
      </div>
    </el-card>

    <!-- ④ 一键自检（最下面） -->
    <el-card shadow="never" class="block">
      <div class="block-head">
        <h3 class="block-title">一键自检</h3>
        <el-button size="small" :loading="selfchecking" @click="runCheck">
          {{ selfchecking ? '自检中…' : '开始自检' }}
        </el-button>
      </div>

      <div v-if="selfcheckItems.length" class="selfcheck">
        <div
          v-for="item in selfcheckItems"
          :key="item.key"
          class="sc-card"
          :class="item.ok ? 'ok' : 'bad'"
        >
          <div class="sc-head">
            <span class="sc-mark">{{ item.ok ? '通过' : '未通过' }}</span>
            <span class="sc-label">{{ item.label }}</span>
            <span class="sc-ms">{{ item.ms }} ms</span>
          </div>
          <p class="sc-msg">{{ item.message }}</p>
        </div>
      </div>
    </el-card>
  </section>
</template>

<style scoped>
.admin-settings {
  max-width: 1080px;
  margin: 0 auto;
  padding: 8px 4px 60px;
}
.st-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.st-title {
  margin: 0;
  font-size: 22px;
  color: var(--zw-green-ink);
}
.block {
  margin: 0 0 16px;
  border-radius: 12px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.block-title {
  margin: 0;
  font-size: 15px;
  color: var(--zw-green-ink);
}
.details-toggle {
  flex: 0 0 auto;
  font-size: 13px;
}
/* 快速模式 / 思考模式：两个按钮等宽，随手一点就换 */
.mode-group {
  display: flex;
  width: 100%;
}
.mode-group :deep(.el-radio-button) {
  flex: 1 1 0;
}
.mode-group :deep(.el-radio-button__inner) {
  width: 100%;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px 20px;
}
.field label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--zw-text);
}
.field.wide {
  margin-top: 16px;
}
.count {
  font-size: 11px;
  font-weight: 400;
  color: var(--zw-faint);
}
/* 字段下方的解释小字：只留一句，别铺满整屏 */
.hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--zw-faint);
}
.key-state {
  font-size: 11px;
  font-weight: 400;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid transparent;
}
.key-state.on {
  color: var(--zw-green);
  border-color: var(--zw-green-soft);
  background: var(--zw-mint-2);
}
.key-state.off {
  color: var(--zw-amber);
  border-color: #f0dcc0;
  background: #fdf8f0;
}
.details {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed var(--zw-line);
}
.readonly {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  margin-top: 14px;
  font-size: 12px;
  color: var(--zw-muted);
}
.readonly b {
  margin-right: 6px;
  font-weight: 500;
  color: var(--zw-faint);
}
.warn {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--zw-amber);
}
.foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.checks {
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #fdf6f6;
}
.checks-title {
  margin-bottom: 6px;
  font-size: 13px;
  color: #c45656;
}
.check {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: baseline;
  padding: 3px 0;
  font-size: 12px;
  color: var(--zw-muted);
}
.check .mark {
  flex: 0 0 auto;
  min-width: 42px;
  font-weight: 600;
  color: #c45656;
}
.check .name {
  flex: 0 0 auto;
  color: var(--zw-text);
}
.check .val {
  font-variant-numeric: tabular-nums;
}

/* 游客权限 */
.guest-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.guest-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 14px;
  border: 1px solid var(--zw-line);
  border-radius: 8px;
  background: var(--zw-surface);
  flex-wrap: wrap;
}
.guest-row.readonly {
  background: var(--zw-mint-2);
  border-style: dashed;
}
.guest-label {
  flex: 1 1 240px;
  min-width: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--zw-text);
}
.guest-ctl {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}
.guest-ro {
  padding: 3px 12px;
  border: 1px solid var(--zw-green-soft);
  border-radius: 999px;
  background: #fff;
  font-size: 12px;
  color: var(--zw-green);
}
.guest-unit {
  font-size: 12px;
  color: var(--zw-faint);
}
.guest-state {
  min-width: 52px;
  text-align: right;
  font-size: 12px;
}
.guest-state.on {
  color: var(--zw-green);
}
.guest-state.off {
  color: var(--zw-amber);
}

/* 自检四卡 */
.selfcheck {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
}
.sc-card {
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--zw-line);
  background: var(--zw-surface);
}
.sc-card.ok {
  border-color: var(--zw-green-soft);
  background: var(--zw-mint-2);
}
.sc-card.bad {
  border-color: #e2b8b8;
  background: #fdf6f6;
}
.sc-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.sc-mark {
  font-size: 12px;
  font-weight: 600;
}
.sc-card.ok .sc-mark {
  color: var(--zw-green);
}
.sc-card.bad .sc-mark {
  color: #c45656;
}
.sc-label {
  font-size: 13px;
  color: var(--zw-text);
}
.sc-ms {
  margin-left: auto;
  font-size: 11px;
  color: var(--zw-faint);
  font-variant-numeric: tabular-nums;
}
.sc-msg {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--zw-muted);
}
</style>
