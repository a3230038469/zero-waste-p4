<script setup lang="ts">
/**
 * 老师后台 · 设置 —— T10 新增（老师后台第 5 个页面）
 *
 * 路由：/admin/settings
 *
 * 三块内容（都走同一套 X-Admin-Token 鉴权）：
 *   1. **智能体设置**：从「资料管理」页**整体搬过来**，接口与逻辑一个字没改
 *      （GET/PUT /api/admin/agent）。搬走的原因：资料管理页讲的是「资料」，
 *      把「问答的大脑」塞在那儿本来就别扭；现在这一页专门放「设置」。
 *   2. **MinerU / 解析引擎设置**：读引擎那份配置，密钥**只显示「已配置」不回显原值**，
 *      支持「测试连接」（只测不存）与「保存」（读全量→合并→整份写回→回读逐字段校验）。
 *   3. **一键自检**：一次看四项（引擎 / 数据库 / 向量服务 / MinerU 云解析），
 *      失败项给一句人话，不甩英文报错原文。
 *
 * ⚠️ 密钥的三条铁律（前端这边也要守住）：
 *   - 输入框**留空 = 不改**，别拿 GET 回来的东西回填（后端回的是「已配置」，不是原值）；
 *   - **绝不**把占位值当新密钥提交（填了 `***` 就等于把真密钥覆盖成 `***`）；
 *   - 页面从头到尾不显示、不缓存、不打印任何密钥明文。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

import {
  ADMIN_TOKEN_KEY,
  checkParserConfig,
  fetchAgentConfig,
  fetchParserConfig,
  runSelfcheck,
  saveAgentConfig,
  saveParserConfig,
  type AgentCheck,
  type AgentConfigPayload,
  type ParserConfigPayload,
  type ParserEngineInfo,
  type ParserFieldCheck,
  type SelfcheckItem
} from '../api/admin'

/* ------------------------------------------------------------------ *
 * 口令（与资料管理页同一套：X-Admin-Token，存在 localStorage）
 * ------------------------------------------------------------------ */

const token = ref('')
const tokenError = ref('')
/** 「进入」按钮的 loading（自检有自己的一套 loading，别混用） */
const entering = ref(false)

function errorMessage(err: unknown, fallback: string): string {
  const response = (err as { response?: { status?: number; data?: { error?: { message?: string } } } })
    .response
  if (response?.status === 403) return '口令不正确。'
  return response?.data?.error?.message ?? fallback
}

/* ------------------------------------------------------------------ *
 * 1️⃣ 智能体设置（整体搬运，逻辑未改）
 * ------------------------------------------------------------------ */

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
    agentError.value = errorMessage(err, '智能体设置拉取失败，看看后端（:4000）在不在。')
  } finally {
    agentLoading.value = false
  }
}

/**
 * 保存。
 *
 * ⚠️ 与搬迁前完全一致的三个刻意为之：
 *   - 传空串 = 「不改这一项」（后端已这样处理），不做「空值兜底成旧值」的加工；
 *   - 存完以后端回显的为准 —— **不乐观更新**，否则校验没过界面还显示成功；
 *   - 回读校验结果原样显示，哪一项不过就写哪一项。
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
    if (d.ignored && d.ignored.length > 0) {
      ElMessage.warning(`这几项填的是空值，已保持原样没改：${d.ignored.join('、')}`)
    }
  } catch (err) {
    // 后端把「哪一项没过」写进了 message，如实展示，别压成一句「保存失败」
    ElMessage.error(errorMessage(err, '保存失败，看看后端（:4000）在不在'))
    await loadAgent()
  } finally {
    agentSaving.value = false
  }
}

/* ------------------------------------------------------------------ *
 * 2️⃣ MinerU / 解析引擎设置
 * ------------------------------------------------------------------ */

/** 引擎配置里可以在页面上改的常用项（不是全部 18 个） */
const PARSER_FIELDS = [
  { key: 'mineru_endpoint', label: 'MinerU 服务地址', kind: 'text' as const, hint: '用云解析时留空即可；自建 MinerU 才需要填。' },
  { key: 'mineru_cloud_model', label: '云解析模型', kind: 'text' as const, hint: '引擎当前用 vlm（视觉语言模型，版面还原更好）。' },
  { key: 'mineru_cloud_language', label: '云解析语言', kind: 'text' as const, hint: 'ch = 中英混排（默认）；纯英文文档可填 en。' }
]

/** 三个开关（云解析的 OCR / 表格 / 公式识别） */
const PARSER_SWITCHES = [
  { key: 'mineru_cloud_enable_ocr', label: '云解析 · OCR 识别', hint: '扫描件 / 图片型 PDF 需要它，关了会认不出正文。' },
  { key: 'mineru_cloud_enable_table', label: '云解析 · 表格识别', hint: '表格会被还原成结构化内容，关了就是一段纯文本。' },
  { key: 'mineru_cloud_enable_formula', label: '云解析 · 公式识别', hint: '公式转 LaTeX，关了对含公式的资料识别会变差。' }
]

const parserLoading = ref(false)
const parserSaving = ref(false)
const parserChecking = ref(false)
const parserError = ref('')
const parserEngines = ref<ParserEngineInfo[]>([])
const parserEnginesError = ref('')
/** 上一次保存后的回读校验结果（逐项显示） */
const parserChecks = ref<ParserFieldCheck[]>([])
const parserSavedInfo = ref('')
/** 正在编辑的文本字段（值来自 GET 的 values，**密钥不在这里**） */
const parserText = ref<Record<string, string>>({})
/** 正在编辑的三个开关 */
const parserSwitch = ref<Record<string, boolean>>({})
/**
 * API Key 输入框。🔴 初始值恒为空串 —— 后端只回「已配置」，没有原值可填。
 * 留空 = 不改（后端不提交这个字段，引擎保留原值）。
 */
const mineruApiKey = ref('')
/** 密钥字段的「已配置 / 未配置」（后端只给这个状态，没有原值） */
const parserSecrets = ref<Record<string, { configured: boolean }>>({})

/** 密钥是否已配置（只读状态，用来显示那行小字提示） */
const mineruKeyConfigured = computed(
  () => parserSecrets.value['mineru_api_key']?.configured === true
)

/** 把 GET 的视图铺到表单 */
function applyParserView(d: ParserConfigPayload): void {
  parserSecrets.value = d.secrets ?? {}
  parserEngines.value = d.engines ?? []
  parserEnginesError.value = d.enginesError ?? ''
  const values = d.values ?? {}
  const text: Record<string, string> = {}
  for (const field of PARSER_FIELDS) {
    const value = values[field.key]
    text[field.key] = typeof value === 'string' ? value : ''
  }
  parserText.value = text
  const switches: Record<string, boolean> = {}
  for (const item of PARSER_SWITCHES) {
    switches[item.key] = values[item.key] === true
  }
  parserSwitch.value = switches
  // 密钥输入框每次读配置后都清空：它是「写新值」的输入框，不是回显框
  mineruApiKey.value = ''
}

async function loadParser(): Promise<void> {
  if (!token.value) return
  parserLoading.value = true
  parserError.value = ''
  try {
    applyParserView(await fetchParserConfig(token.value))
  } catch (err) {
    parserError.value = errorMessage(err, '解析引擎设置拉取失败，看看后端（:4000）在不在。')
  } finally {
    parserLoading.value = false
  }
}

/** 把表单拼成请求体（只放「有值」的字段；空值 = 不改，别提交空串去清零） */
function buildParserPatch(): Record<string, string | number | boolean> {
  const patch: Record<string, string | number | boolean> = {}
  for (const field of PARSER_FIELDS) {
    const value = (parserText.value[field.key] ?? '').trim()
    if (value) patch[field.key] = value
  }
  for (const item of PARSER_SWITCHES) {
    patch[item.key] = parserSwitch.value[item.key] === true
  }
  const key = mineruApiKey.value.trim()
  // 🔴 只有真填了新密钥才带上；空串绝不提交（后端也不接受空串当成新密钥）
  if (key) patch['mineru_api_key'] = key
  return patch
}

/** 「测试连接」：只测不存 */
async function testParser(): Promise<void> {
  if (!token.value) {
    ElMessage.warning('先输入管理口令并点「进入」')
    return
  }
  parserChecking.value = true
  try {
    const result = await checkParserConfig(token.value, buildParserPatch())
    applyEngines(result.engines)
    const okCount = (result.engines ?? []).filter((e) => e.available).length
    ElMessage.success(result.message || `测试完成：${okCount} 个引擎可用`)
    if (!mineruApiKey.value.trim()) {
      ElMessage.info('没填新的 API Key，这次用的是引擎里已保存的那一把')
    }
  } catch (err) {
    ElMessage.error(errorMessage(err, '测试失败，看看后端（:4000）在不在'))
  } finally {
    parserChecking.value = false
  }
}

function applyEngines(engines: ParserEngineInfo[] | undefined): void {
  if (engines) parserEngines.value = engines
}

/** 「保存」：后端走「读全量 → 合并 → 整份写回 → 回读逐字段校验」 */
async function submitParser(): Promise<void> {
  if (!token.value) {
    ElMessage.warning('先输入管理口令并点「进入」')
    return
  }
  parserSaving.value = true
  try {
    const result = await saveParserConfig(token.value, buildParserPatch())
    applyParserView(result.config)
    parserChecks.value = result.checks ?? []
    parserSavedInfo.value = `提交 ${result.submittedCount} 个字段 · 回读到 ${result.readBackCount} 个`
    const failed = parserChecks.value.filter((c) => !c.ok)
    if (failed.length > 0) {
      ElMessage.error('已写入引擎，但有字段没生效，请看下面的逐项结果')
    } else {
      ElMessage.success(result.message || '已保存，解析引擎设置已生效')
    }
  } catch (err) {
    ElMessage.error(errorMessage(err, '保存失败，看看后端（:4000）在不在'))
    // 存失败也要让老师看到「现在生效的是什么」——重新拉一次，别让表单停在半改状态
    await loadParser()
  } finally {
    parserSaving.value = false
  }
}

/** 引擎给的不可用原因 → 一句人话（与后端同一套映射，避免两边说法不一致） */
function engineReason(e: ParserEngineInfo): string {
  const reason = e.unavailableReason ?? ''
  if (e.available) return '可用'
  if (/api key/i.test(reason)) return 'API Key 没配或已失效，请在上面填一下'
  if (/token/i.test(reason)) return '云端 Token 没配'
  if (/endpoint|address|not configured/i.test(reason)) return '服务地址没配，请在上面填一下'
  return '暂不可用'
}

/* ------------------------------------------------------------------ *
 * 3️⃣ 一键自检
 * ------------------------------------------------------------------ */

const selfchecking = ref(false)
const selfcheckItems = ref<SelfcheckItem[]>([])
const selfcheckAt = ref('')

async function runCheck(): Promise<void> {
  if (!token.value) {
    ElMessage.warning('先输入管理口令并点「进入」')
    return
  }
  selfchecking.value = true
  try {
    const result = await runSelfcheck(token.value)
    selfcheckItems.value = result.items ?? []
    selfcheckAt.value = result.generatedAt ?? ''
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

/* ------------------------------------------------------------------ *
 * 口令门
 * ------------------------------------------------------------------ */

/** 「进入」：口令对上了才去拉三块内容 */
async function enterAdmin(): Promise<void> {
  if (!token.value.trim()) {
    tokenError.value = '请输入管理口令'
    return
  }
  entering.value = true
  tokenError.value = ''
  // 先单独验一次口令对不对（三块里任何一块返回 403 都会提示，但先验更省事）
  try {
    await fetchParserConfig(token.value)
    localStorage.setItem(ADMIN_TOKEN_KEY, token.value)
    tokenError.value = ''
  } catch (err) {
    tokenError.value = errorMessage(err, '口令不正确。')
    return
  } finally {
    entering.value = false
  }
  await Promise.all([loadAgent(), loadParser(), runCheck()])
}

onMounted(() => {
  const saved = localStorage.getItem(ADMIN_TOKEN_KEY)
  if (saved) {
    token.value = saved
    void loadAgent()
    void loadParser()
    void runCheck()
  }
})
</script>

<template>
  <section class="admin-settings">
    <header class="st-head">
      <div>
        <h2 class="st-title">设置</h2>
        <p class="st-sub">
          这里是老师后台的<b>系统设置</b>：问答的「大脑」（智能体）、资料的解析引擎、以及一键体检。
        </p>
      </div>
    </header>

    <nav class="admin-nav">
      <router-link to="/admin/knowledge">资料管理</router-link>
      <router-link to="/admin/users">注册用户</router-link>
      <router-link to="/admin/contributions">投稿审核</router-link>
      <router-link to="/admin/stats">数据看板</router-link>
      <router-link to="/admin/settings">设置</router-link>
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
        <el-button type="primary" :loading="entering" @click="enterAdmin">进入</el-button>
      </div>
      <p v-if="tokenError" class="err">{{ tokenError }}</p>
    </el-card>

    <!-- 1️⃣ 智能体设置 -->
    <el-card shadow="never" class="block">
      <div class="block-head">
        <h3 class="block-title">智能体设置</h3>
        <span class="block-now">
          智能体：{{ agentName || '（未取到）' }} ·
          回答长度上限 {{ agentSaved.max_completion_tokens }} ·
          随机度 {{ agentSaved.temperature }} ·
          答不上来时{{ fallbackLabel(agentSaved.fallback_strategy) }}
        </span>
      </div>

      <p class="lead">
        这里的修改会<b>直接写入引擎的智能体</b>，下次提问立刻生效；
        漏改的字段不会被清空（后端先读全量、只改你动过的那几项，再整份写回）。
      </p>

      <p v-if="agentError" class="warn">{{ agentError }}</p>
      <p v-else-if="agentModelsError" class="warn">{{ agentModelsError }}</p>
      <p v-else-if="agentModelMissing" class="warn">
        当前生效的模型（{{ agentSaved.model_id }}）在引擎里已经找不到了，请重新选一个并保存。
      </p>
      <p v-else-if="agentKbMode && agentKbMode !== 'selected'" class="warn">
        ⚠️ 智能体的知识库范围现在是「{{ agentKbMode }}」——这会把不相干的库（如 123 份
        「AI系统学习」）一起拉进检索。本页不会替你改这个口径，请到引擎里改回「按选择」再保存。
      </p>

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
          <p class="hint">
            这是智能体自己用的模型（不再是知识库那个「回答模型」）。换模型等于换脑子。
          </p>
        </div>

        <div class="field">
          <label>回答随机度（temperature）</label>
          <el-input-number
            v-model="agentForm.temperature"
            :min="0"
            :max="1"
            :step="0.1"
            :precision="2"
            style="width: 100%"
          />
          <p class="hint">0 最确定、1 最发散。资料问答建议 0 到 0.5。</p>
        </div>

        <div class="field">
          <label>回答长度上限（max_completion_tokens）</label>
          <el-input-number
            v-model="agentForm.max_completion_tokens"
            :min="256"
            :max="65536"
            :step="512"
            style="width: 100%"
          />
          <p class="hint">
            🔴 这一项千万别调小：调回 1024 会让宽泛问题的长回答被截断（以前修过的 bug）。
          </p>
        </div>

        <div class="field">
          <label>答不上来时怎么办</label>
          <el-select v-model="agentForm.fallback_strategy" style="width: 100%">
            <el-option value="fixed" label="固定文案（说「库内暂未收录」，推荐）" />
            <el-option value="model" label="交给模型自己发挥（不建议）" />
          </el-select>
          <p class="hint">
            🔴 改成「交给模型自己发挥」，「库内暂未收录」就不再是固定文案了，模型可能编。
          </p>
        </div>
      </div>

      <div class="field wide">
        <label>系统提示词（system_prompt）· {{ agentForm.system_prompt.length }} 字</label>
        <el-input
          v-model="agentForm.system_prompt"
          type="textarea"
          :rows="12"
          placeholder="智能体回答问题的总规则"
        />
        <p class="hint">
          这是智能体的总规则（只用库内内容、逐条作答、结尾说依据）。
          🔴 清空会让它变成自由发挥 —— 本页按「空值 = 不改」处理，不会让它被抹掉。
        </p>
      </div>

      <div class="field wide">
        <label>答不上来时的固定文案（fallback_response）· {{ agentForm.fallback_response.length }} 字</label>
        <el-input v-model="agentForm.fallback_response" type="textarea" :rows="6" />
      </div>

      <div class="readonly">
        <span class="ro-label">只读（不在本页改）</span>
        <span>关联知识库：{{ agentKbIds.length ? agentKbIds.join('、') : '（未关联）' }}</span>
        <span>范围口径：{{ agentKbMode || '—' }}</span>
        <span>智能体模式：{{ agentMode || '—' }}</span>
        <span>意图提示词：{{ agentIntentPrompts.length }} 段（{{ agentIntentPrompts.map((p) => p.key).join('、') }}）</span>
      </div>
      <p class="hint">
        「思考强度」原来在资料管理页的卡片里，现在由智能体在引擎侧的配置决定，本页不提供开关 ——
        硬改它会和智能体自己的设置打架。
      </p>

      <div class="foot">
        <el-button type="primary" :loading="agentSaving" @click="submitAgent">
          {{ agentSaving ? '保存中…' : '保存智能体设置' }}
        </el-button>
        <span v-if="agentUpdatedAt" class="time">
          引擎侧最后更新：{{ agentUpdatedAt.slice(0, 16).replace('T', ' ') }}
        </span>
      </div>

      <div v-if="agentChecks.length" class="checks">
        <div class="checks-title">保存后回读校验（后端重新读了一遍引擎）</div>
        <div v-for="c in agentChecks" :key="c.key" class="check" :class="c.ok ? 'ok' : 'bad'">
          <span class="mark">{{ c.ok ? '通过' : '未通过' }}</span>
          <span class="name">{{ c.label }}</span>
          <span class="val">期望 {{ c.expected }} ／ 实际 {{ c.actual }}</span>
        </div>
      </div>
    </el-card>

    <!-- 2️⃣ MinerU / 解析引擎设置 -->
    <el-card shadow="never" class="block">
      <div class="block-head">
        <h3 class="block-title">MinerU / 解析引擎设置</h3>
        <span class="block-now">新上传的资料由解析引擎转成文字，改这里只影响之后上传的资料</span>
      </div>

      <p class="lead">
        这里改的是<b>引擎里的解析引擎配置</b>。🔴 引擎这份配置是<b>整份覆盖</b>的
        （不是只改你动的那一项），所以后端会先读全量、再把你改的几项盖上去、整份写回，
        写完重新读一遍逐项校验 —— 页面上那些「回读校验」就是这么来的。
      </p>

      <p v-if="parserError" class="warn">{{ parserError }}</p>
      <p v-else-if="parserEnginesError" class="warn">{{ parserEnginesError }}</p>

      <!-- 当前可用状态 -->
      <div v-if="parserEngines.length" class="engines">
        <div class="engines-title">当前解析引擎可用状态</div>
        <div class="engine-list">
          <div v-for="e in parserEngines" :key="e.name" class="engine" :class="e.available ? 'ok' : 'off'">
            <span class="dot" aria-hidden="true"></span>
            <span class="e-name">{{ e.name }}</span>
            <span class="e-desc">{{ e.description }}</span>
            <span class="e-state">{{ e.available ? '可用' : engineReason(e) }}</span>
          </div>
        </div>
      </div>

      <div class="grid">
        <div class="field">
          <label>MinerU 云解析 API Key</label>
          <el-input
            v-model="mineruApiKey"
            type="password"
            show-password
            placeholder="留空 = 不改（保持现在这把）"
            autocomplete="new-password"
          />
          <p class="hint">
            <span v-if="mineruKeyConfigured">当前已配置（不回显原值）。要换一把就填新的，别填 `***`。</span>
            <span v-else>当前<b>未</b>配置，云解析会不可用（自检那一块能看到）。</span>
          </p>
        </div>

        <div v-for="field in PARSER_FIELDS" :key="field.key" class="field">
          <label>{{ field.label }}</label>
          <el-input v-model="parserText[field.key]" :placeholder="`（${field.key}）`" clearable />
          <p class="hint">{{ field.hint }}</p>
        </div>

        <div v-for="item in PARSER_SWITCHES" :key="item.key" class="field">
          <label>{{ item.label }}</label>
          <el-switch v-model="parserSwitch[item.key]" />
          <p class="hint">{{ item.hint }}</p>
        </div>
      </div>

      <div class="foot">
        <el-button :loading="parserChecking" @click="testParser">
          {{ parserChecking ? '测试中…' : '测试连接（不保存）' }}
        </el-button>
        <el-button type="primary" :loading="parserSaving" @click="submitParser">
          {{ parserSaving ? '保存中…' : '保存解析设置' }}
        </el-button>
        <span v-if="parserSavedInfo" class="time">{{ parserSavedInfo }}</span>
      </div>

      <div v-if="parserChecks.length" class="checks">
        <div class="checks-title">保存后回读校验（后端重新读了一遍引擎；密钥只核对「有没有还在」）</div>
        <div v-for="c in parserChecks" :key="c.key" class="check" :class="c.ok ? 'ok' : 'bad'">
          <span class="mark">{{ c.ok ? '通过' : '未通过' }}</span>
          <span class="name">{{ c.label }}</span>
          <span class="val">期望 {{ c.expected }} ／ 实际 {{ c.actual }}</span>
        </div>
      </div>
    </el-card>

    <!-- 3️⃣ 一键自检 -->
    <el-card shadow="never" class="block">
      <div class="block-head">
        <h3 class="block-title">一键自检</h3>
        <span class="block-now">一次看四项：知识库引擎 / 数据库 / 向量服务 / MinerU 云解析</span>
      </div>

      <p class="lead">
        点一下挨个探活，<b>任何一项失败都不会让整页报错</b> —— 失败项给一句能照着做的人话，
        而不是英文报错原文。{{ selfcheckAt ? `上次自检：${selfcheckAt.slice(0, 19).replace('T', ' ')}` : '' }}
      </p>

      <div class="foot">
        <el-button :loading="selfchecking" @click="runCheck">
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
      <p v-else class="hint">还没自检过。点上面「开始自检」看这四项的状态。</p>
    </el-card>
  </section>
</template>

<style scoped>
.admin-settings {
  max-width: 1100px;
  margin: 0 auto;
  padding: 20px 16px 60px;
}
.st-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.st-title {
  margin: 0 0 6px;
  font-size: 22px;
  color: var(--zw-green-ink);
}
.st-sub {
  margin: 0;
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
.block {
  margin: 0 0 14px;
  border-radius: 10px;
}
.block-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.block-title {
  margin: 0;
  font-size: 15px;
  color: var(--zw-green-ink);
}
.block-now {
  font-size: 12px;
  color: var(--zw-muted);
}
.lead {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--zw-text);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}
.field label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--zw-text);
}
.hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--zw-faint);
}
.warn {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--zw-amber);
}
.wide {
  margin-top: 16px;
}
.readonly {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--zw-line);
  font-size: 12px;
  color: var(--zw-muted);
}
.ro-label {
  color: var(--zw-faint);
}
.checks {
  margin-top: 16px;
  padding: 12px;
  border-radius: 8px;
  background: #f7faf7;
}
.checks-title {
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--zw-green-ink);
}
.check {
  display: flex;
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
}
.check.ok .mark {
  color: var(--zw-green);
}
.check.bad .mark {
  color: #c45656;
}
.check .name {
  flex: 0 0 auto;
  color: var(--zw-text);
}
.check .val {
  font-variant-numeric: tabular-nums;
}
.foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.time {
  font-size: 12px;
  color: var(--zw-faint);
  font-variant-numeric: tabular-nums;
}

/* 解析引擎可用状态 */
.engines {
  margin-bottom: 14px;
}
.engines-title {
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--zw-green-ink);
}
.engine-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 8px;
}
.engine {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--zw-line);
  border-radius: 8px;
  background: var(--zw-surface);
  font-size: 12px;
  color: var(--zw-muted);
}
.engine .dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--zw-line-strong);
}
.engine.ok .dot {
  background: var(--zw-green);
}
.engine .e-name {
  flex: 0 0 auto;
  font-weight: 600;
  color: var(--zw-text);
}
.engine .e-desc {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.engine .e-state {
  flex: 0 0 auto;
}
.engine.ok .e-state {
  color: var(--zw-green);
}
.engine.off .e-state {
  color: var(--zw-muted);
}

/* 自检四卡 */
.selfcheck {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
  margin-top: 16px;
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