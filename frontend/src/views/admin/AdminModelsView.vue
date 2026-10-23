<script setup lang="ts">
/**
 * 模型管理（管理台）—— 2026-10-22 新增
 *
 * 把引擎自带「模型管理」界面的能力搬到我们的管理台，只保留基金会实际在用的三类：
 *   对话模型（KnowledgeQA）/ 视觉模型（VLLM）/ 重排模型（Rerank）
 * 向量模型（Embedding）单独一个只读标签：能看，不能在这里增删改 ——
 * 库里 603 份资料的向量都由它算，换掉检索会悄悄变差。
 *
 * 能做的事：看列表 / 加模型 / 换密钥 / 改展示名与地址 / 测试连通 / 删除。
 * 三条护栏（后端也各有一份，前端只是先提示）：
 *   1. 正在被使用的模型不能删（后端会 409）；
 *   2. 内置模型不能改、不能删；
 *   3. 向量模型不在这里动。
 *
 * 密钥只往上传：引擎只回「已配置 / 未配置」，页面也永远不显示原值。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import {
  createModel,
  deleteModel,
  fetchModelAdminView,
  testModel,
  updateModel,
  updateModelKey,
  type AdminModelItem,
  type ModelAdminView,
  type ModelTestResult
} from '../../api/models'

type EditableGroup = 'chat' | 'vision' | 'rerank'
type GroupKey = EditableGroup | 'embedding'

const loading = ref(true)
const errorText = ref('')
const view = ref<ModelAdminView | null>(null)

/** 四个标签：前三类可编辑，向量只读 */
const GROUPS: { key: GroupKey; label: string; hint: string }[] = [
  { key: 'chat', label: '对话模型', hint: 'AI 问答用的模型' },
  { key: 'vision', label: '视觉模型', hint: '看图理解（扫描件、图表）' },
  { key: 'rerank', label: '重排模型', hint: '检索结果重排' },
  { key: 'embedding', label: '向量模型', hint: '只读：换掉会让已有资料的向量失效' }
]

/** 分组 → 引擎厂商目录里的类型（视觉在引擎里叫 vllm） */
const PROVIDER_TYPE: Record<EditableGroup, string> = {
  chat: 'chat',
  vision: 'vllm',
  rerank: 'rerank'
}

const activeGroup = ref<GroupKey>('chat')

function itemsOf(group: GroupKey): AdminModelItem[] {
  return (view.value?.models ?? []).filter((m) => m.group === group)
}

const activeItems = computed(() => itemsOf(activeGroup.value))
const activeGroupMeta = computed(() => GROUPS.find((g) => g.key === activeGroup.value))

async function load(): Promise<void> {
  loading.value = true
  errorText.value = ''
  try {
    view.value = await fetchModelAdminView()
  } catch (err) {
    // 404 = 后端还是旧版本（本地后端是常驻进程，前端重新打包不会让它换代码）
    const status = (err as { response?: { status?: number } }).response?.status
    errorText.value =
      status === 404
        ? '后端还没更新到支持模型管理的版本：请关掉启动窗口，重新双击「打开零废弃知识库.cmd」再进来。'
        : '模型列表读取失败，请稍后再试。'
    view.value = null
  } finally {
    loading.value = false
  }
}

/* ---------------- 展示辅助 ---------------- */

function formatTokens(value: number): string {
  if (!value) return ''
  if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`
  if (value >= 1000) return `${Math.round(value / 1000)}K`
  return String(value)
}

/* ---------------- 添加模型 ---------------- */

const addOpen = ref(false)
const adding = ref(false)
const addForm = reactive({
  group: 'chat' as EditableGroup,
  provider: 'generic',
  name: '',
  displayName: '',
  baseUrl: '',
  apiKey: '',
  /** 上下文长度按字符串收，提交时再转数字（el-input 的数字修饰符不可靠） */
  contextWindow: ''
})

/** 厂商下拉：只列支持当前类型的厂商 */
const providerOptions = computed(() => {
  const type = PROVIDER_TYPE[addForm.group]
  return (view.value?.providers ?? []).filter((p) => p.modelTypes.includes(type))
})

function openAdd(): void {
  addForm.group = activeGroup.value === 'embedding' ? 'chat' : activeGroup.value
  const first = providerOptions.value[0]
  addForm.provider = first?.value ?? 'generic'
  addForm.name = ''
  addForm.displayName = ''
  addForm.baseUrl = first ? first.defaultUrls[PROVIDER_TYPE[addForm.group]] ?? '' : ''
  addForm.apiKey = ''
  addForm.contextWindow = ''
  addOpen.value = true
}

/** 换厂商时把默认地址带出来（已经有地址就不覆盖，除非它正好是上一家的默认值） */
function onProviderChange(value: string): void {
  const provider = (view.value?.providers ?? []).find((p) => p.value === value)
  const url = provider?.defaultUrls[PROVIDER_TYPE[addForm.group]] ?? ''
  if (url) addForm.baseUrl = url
}

function onGroupChange(): void {
  const first = providerOptions.value[0]
  if (first) {
    addForm.provider = first.value
    addForm.baseUrl = first.defaultUrls[PROVIDER_TYPE[addForm.group]] ?? ''
  }
}

async function submitAdd(): Promise<void> {
  if (!addForm.name.trim()) {
    ElMessage.warning('请填写模型名（厂商那边叫什么就填什么）')
    return
  }
  if (!addForm.provider.trim()) {
    ElMessage.warning('请选择厂商')
    return
  }
  if (!addForm.baseUrl.trim()) {
    ElMessage.warning('请填写接口地址')
    return
  }
  if (!addForm.apiKey.trim()) {
    ElMessage.warning('请填写 API Key')
    return
  }
  adding.value = true
  try {
    await createModel({
      group: addForm.group,
      name: addForm.name.trim(),
      displayName: addForm.displayName.trim(),
      provider: addForm.provider.trim(),
      baseUrl: addForm.baseUrl.trim(),
      apiKey: addForm.apiKey.trim(),
      contextWindow: Number(addForm.contextWindow) || 0    })
    ElMessage.success('模型已添加，可以直接在设置页的模型下拉里选它')
    addOpen.value = false
    activeGroup.value = addForm.group
    await load()
  } catch {
    // 失败原因（引擎校验、重名、地址不合法）由统一拦截器弹出，弹窗留着让老师改
  } finally {
    adding.value = false
  }
}

/* ---------------- 换密钥 ---------------- */

const keyOpen = ref(false)
const keyTarget = ref<AdminModelItem | null>(null)
const keyValue = ref('')
const savingKey = ref(false)

function openKey(model: AdminModelItem): void {
  keyTarget.value = model
  keyValue.value = ''
  keyOpen.value = true
}

async function submitKey(): Promise<void> {
  const target = keyTarget.value
  if (!target) return
  if (!keyValue.value.trim()) {
    ElMessage.warning('请填写新的 API Key')
    return
  }
  savingKey.value = true
  try {
    await updateModelKey(target.id, keyValue.value.trim())
    keyOpen.value = false
    ElMessage.success('密钥已更新，正在测试连通…')
    await load()
    await runTest(target)
  } catch {
    // 失败提示由拦截器弹出
  } finally {
    savingKey.value = false
  }
}

/* ---------------- 改展示名 / 地址 ---------------- */

const editOpen = ref(false)
const editTarget = ref<AdminModelItem | null>(null)
const editForm = reactive({ displayName: '', baseUrl: '' })
const savingEdit = ref(false)

function openEdit(model: AdminModelItem): void {
  editTarget.value = model
  editForm.displayName = model.displayName
  editForm.baseUrl = model.baseUrl
  editOpen.value = true
}

async function submitEdit(): Promise<void> {
  const target = editTarget.value
  if (!target) return
  savingEdit.value = true
  try {
    await updateModel(target.id, {
      displayName: editForm.displayName.trim(),
      baseUrl: editForm.baseUrl.trim()
    })
    ElMessage.success('已保存')
    editOpen.value = false
    await load()
  } catch {
    // 失败提示由拦截器弹出
  } finally {
    savingEdit.value = false
  }
}

/* ---------------- 测试 ---------------- */

const testingId = ref('')
const testResults = reactive<Record<string, ModelTestResult>>({})

async function runTest(model: AdminModelItem): Promise<void> {
  if (testingId.value) return
  testingId.value = model.id
  try {
    const result = await testModel(model.id)
    testResults[model.id] = result
    if (result.ok) {
      ElMessage.success(`「${model.displayName}」连接正常（${result.elapsedMs} ms）`)
    } else {
      ElMessage.error(`「${model.displayName}」测试没通过：${result.error}`)
    }
  } catch {
    // 失败提示由拦截器弹出
  } finally {
    testingId.value = ''
  }
}

/* ---------------- 删除 ---------------- */

async function remove(model: AdminModelItem): Promise<void> {
  if (model.inUse.length > 0) {
    ElMessage.warning(`这个模型正在被用作「${model.inUse.join('、')}」，先在设置页换掉再删`)
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定删除「${model.displayName}」吗？删掉后引擎里就没有它了，用到它的地方会选不到。`,
      '删除模型',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await deleteModel(model.id)
    ElMessage.success('已删除')
    delete testResults[model.id]
    await load()
  } catch {
    // 409（在用）/ 400（内置）等由拦截器弹出
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div v-loading="loading" class="model-page">
    <header class="page-head">
      <div>
        <h2 class="title">模型管理</h2>
        <p class="sub">
          这里管的是引擎里可用的 AI 模型。新加的模型会直接出现在「系统设置 → 智能体设置」的模型下拉里。
          密钥只存进引擎，页面上永远只显示「已配置 / 未配置」。
        </p>
      </div>
      <div class="head-actions">
        <el-button :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" @click="openAdd">+ 添加模型</el-button>
      </div>
    </header>

    <p v-if="errorText" class="err">{{ errorText }}</p>
    <p v-if="view?.providersError" class="warn">
      厂商目录没读到（{{ view.providersError }}），添加模型时厂商可以手动输入。
    </p>
    <p v-if="view?.bindingsError" class="warn">
      {{ view.bindingsError }}：删除保护可能不完整，删除时会再检查一次。
    </p>

    <div class="tabs" role="tablist" aria-label="模型类型">
      <button
        v-for="g in GROUPS"
        :key="g.key"
        type="button"
        role="tab"
        class="tab"
        :class="{ 'is-on': activeGroup === g.key }"
        :aria-selected="activeGroup === g.key"
        @click="activeGroup = g.key"
      >
        {{ g.label }}
        <b>{{ itemsOf(g.key).length }}</b>
      </button>
    </div>

    <p v-if="activeGroupMeta" class="tab-hint">{{ activeGroupMeta.hint }}</p>

    <p v-if="activeGroup === 'embedding'" class="lock-note">
      向量模型决定全部资料怎么被检索。库里已经有 603 份资料的向量，换掉它检索会悄悄变差，
      所以这里只读：要换请进引擎后台、或导入新库时选定。
    </p>

    <div v-if="activeItems.length > 0" class="cards">
      <article v-for="m in activeItems" :key="m.id" class="card">
        <div class="card-top">
          <div class="card-title">
            <strong class="name" :title="m.name">{{ m.displayName }}</strong>
            <span class="badges">
              <em v-if="m.isBuiltin" class="badge">内置</em>
              <em v-for="u in m.inUse" :key="u" class="badge badge--use">在用 · {{ u }}</em>
            </span>
          </div>
          <span class="key-state" :class="{ 'is-off': !m.keyConfigured }">
            {{ m.keyConfigured ? '密钥已配置' : '密钥未配置' }}
          </span>
        </div>

        <p class="meta">
          <span class="meta-item">{{ m.providerLabel || m.provider || '自定义' }}</span>
          <span v-if="m.contextWindow" class="meta-item">上下文 {{ formatTokens(m.contextWindow) }}</span>
          <span v-if="m.dimension" class="meta-item">维度 {{ m.dimension }}</span>
        </p>
        <p class="url" :title="m.baseUrl">{{ m.baseUrl || '（未填地址）' }}</p>
        <p class="model-name">模型名：<code>{{ m.name }}</code></p>

        <div v-if="m.editable" class="actions">
          <el-button link type="primary" size="small" @click="openKey(m)">换密钥</el-button>
          <el-button link type="primary" size="small" @click="openEdit(m)">编辑</el-button>
          <el-button
            link
            type="primary"
            size="small"
            :loading="testingId === m.id"
            @click="runTest(m)"
          >
            测试
          </el-button>
          <el-button link type="danger" size="small" @click="remove(m)">删除</el-button>
        </div>
        <div v-else class="actions actions--locked">
          <el-button
            link
            type="primary"
            size="small"
            :loading="testingId === m.id"
            @click="runTest(m)"
          >
            测试
          </el-button>
          <span class="lock-hint">{{ m.isBuiltin ? '内置模型，不可改' : '向量模型，只读' }}</span>
        </div>

        <p v-if="testResults[m.id]" class="test-line" :class="{ 'is-ok': testResults[m.id].ok }">
          <template v-if="testResults[m.id].ok">
            ✓ 连接正常（{{ testResults[m.id].elapsedMs }} ms）
            <template v-if="testResults[m.id].summary">：{{ testResults[m.id].summary }}</template>
          </template>
          <template v-else>✗ 测试失败：{{ testResults[m.id].error }}</template>
        </p>
      </article>
    </div>

    <el-empty v-else :description="`这一类还没有模型`">
      <el-button v-if="activeGroup !== 'embedding'" type="primary" @click="openAdd">+ 添加模型</el-button>
    </el-empty>

    <!-- 添加模型 -->
    <el-dialog v-model="addOpen" title="添加模型" width="min(620px, 92vw)">
      <el-form label-width="92px" label-position="left">
        <el-form-item label="类型">
          <el-select v-model="addForm.group" style="width: 100%" @change="onGroupChange">
            <el-option label="对话模型（问答）" value="chat" />
            <el-option label="视觉模型（看图）" value="vision" />
            <el-option label="重排模型（检索）" value="rerank" />
          </el-select>
        </el-form-item>
        <el-form-item label="厂商">
          <el-select
            v-model="addForm.provider"
            filterable
            allow-create
            default-first-option
            style="width: 100%"
            placeholder="选一个厂商，或直接输入厂商标识"
            @change="onProviderChange"
          >
            <el-option
              v-for="p in providerOptions"
              :key="p.value"
              :label="p.label"
              :value="p.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="模型名">
          <el-input v-model="addForm.name" maxlength="100" placeholder="厂商那边的模型名，例如 qwen-plus" />
        </el-form-item>
        <el-form-item label="显示名">
          <el-input v-model="addForm.displayName" maxlength="100" placeholder="页面上显示的名字，留空就用模型名" />
        </el-form-item>
        <el-form-item label="接口地址">
          <el-input v-model="addForm.baseUrl" placeholder="https://api.example.com/v1" />
        </el-form-item>
        <el-form-item label="上下文长度">
          <el-input v-model="addForm.contextWindow" placeholder="可留空；填数字，例如 128000" />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input
            v-model="addForm.apiKey"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="厂商给的密钥，只存进引擎，不会回显"
          />
        </el-form-item>
      </el-form>
      <p class="dlg-note">
        地址与密钥会原样交给引擎；引擎自己会做一次地址安全检查。加完建议点一下「测试」确认能通。
      </p>
      <template #footer>
        <el-button @click="addOpen = false">取消</el-button>
        <el-button type="primary" :loading="adding" @click="submitAdd">添加</el-button>
      </template>
    </el-dialog>

    <!-- 换密钥 -->
    <el-dialog v-model="keyOpen" title="更换 API Key" width="min(520px, 92vw)">
      <p class="dlg-note">
        正在改：<strong>{{ keyTarget?.displayName }}</strong>。旧密钥引擎不回显，填新的直接覆盖。
      </p>
      <el-input
        v-model="keyValue"
        type="password"
        show-password
        autocomplete="new-password"
        placeholder="新的 API Key"
      />
      <p class="dlg-note">保存后会立刻测一次连通，测试失败会如实提示。</p>
      <template #footer>
        <el-button @click="keyOpen = false">取消</el-button>
        <el-button type="primary" :loading="savingKey" @click="submitKey">保存并测试</el-button>
      </template>
    </el-dialog>

    <!-- 改展示名 / 地址 -->
    <el-dialog v-model="editOpen" title="编辑模型" width="min(560px, 92vw)">
      <el-form label-width="92px" label-position="left">
        <el-form-item label="显示名">
          <el-input v-model="editForm.displayName" maxlength="100" />
        </el-form-item>
        <el-form-item label="接口地址">
          <el-input v-model="editForm.baseUrl" placeholder="https://api.example.com/v1" />
        </el-form-item>
      </el-form>
      <p class="dlg-note">模型名与厂商不在这里改：改名会让别处引用的旧名字对不上。</p>
      <template #footer>
        <el-button @click="editOpen = false">取消</el-button>
        <el-button type="primary" :loading="savingEdit" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.model-page {
  padding: 4px 2px 60px;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.title {
  margin: 0 0 6px;
  font-size: 22px;
  color: var(--zw-green-ink);
}

.sub {
  margin: 0;
  max-width: 720px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--zw-muted);
}

.head-actions {
  display: flex;
  gap: 8px;
  padding-top: 4px;
}

.err {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--zw-amber-ink);
}

.warn {
  margin: 10px 0 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--zw-amber-soft);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--zw-amber-ink);
}

.tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 16px 0 10px;
}

.tab {
  font: inherit;
  font-size: 13px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--zw-line);
  background: var(--zw-surface);
  color: var(--zw-text);
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease;
}

.tab:hover {
  border-color: var(--zw-green-soft);
  background: var(--zw-mint-2);
}

.tab.is-on {
  background: var(--zw-green);
  border-color: var(--zw-green);
  color: var(--zw-surface);
}

.tab.is-on b {
  color: var(--zw-surface);
}

.tab b {
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
  color: var(--zw-green-deep);
}

.tab-hint {
  margin: 0 0 12px;
  font-size: 12.5px;
  color: var(--zw-faint);
}

.lock-note {
  margin: 0 0 14px;
  padding: 9px 12px;
  border: 1px dashed var(--zw-line-strong);
  border-radius: 8px;
  background: var(--zw-mint-2);
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--zw-muted);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}

.card {
  padding: 14px 16px 12px;
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  background: var(--zw-surface);
  box-shadow: var(--zw-shadow-sm);
}

.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.name {
  font-size: 14.5px;
  color: var(--zw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

.badges {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
}

.badge {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--zw-mint);
  font-style: normal;
  font-size: 11px;
  color: var(--zw-green-deep);
}

.badge--use {
  background: var(--zw-amber-soft);
  color: var(--zw-amber-ink);
}

.key-state {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--zw-green-deep);
}

.key-state.is-off {
  color: var(--zw-faint);
}

.meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--zw-muted);
}

.url {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--zw-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-name {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--zw-faint);
}

.model-name code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--zw-mint-2);
  font-size: 11.5px;
  color: var(--zw-text);
}

.actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--zw-line);
}

.actions--locked {
  gap: 10px;
}

.lock-hint {
  font-size: 11.5px;
  color: var(--zw-faint);
}

.test-line {
  margin: 8px 0 0;
  padding: 7px 10px;
  border-radius: 8px;
  background: #fdf1ef;
  font-size: 12px;
  line-height: 1.7;
  color: #b04a45;
  word-break: break-word;
}

.test-line.is-ok {
  background: var(--zw-mint-2);
  color: var(--zw-green-deep);
}

.dlg-note {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--zw-muted);
}

.dlg-note strong {
  color: var(--zw-text);
}

@media (max-width: 720px) {
  .cards {
    grid-template-columns: minmax(0, 1fr);
  }

  .name {
    max-width: 160px;
  }
}
</style>
