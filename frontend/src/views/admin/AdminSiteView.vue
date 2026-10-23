<script setup lang="ts">
/**
 * 机构信息 —— 2026-10-19 新增，2026-10-22 扩展
 *
 * 2026-10-19：把首页「合作与共建」里的联系方式 / 邮箱 / 地址从「待补充」占位
 * 改成老师自己在管理台填（空着仍显示「待补充」，不编机构口径）。
 *
 * 2026-10-22（用户要求）：首页另外三块文案也开放编辑 ——
 *   1. 「项目简介」正文（空一行分一段；下面那排绿色小胶囊已从首页删掉）
 *   2. 「关于基金会」条目（小标题 + 正文，可增删、可上下移、可强调显示）
 *   3. 「引用与转载」正文 + 规则（规则可增删）
 *   「资料分布」不开放编辑：图注与「其他」说明收进首页标题旁的圆圈「!」，
 *   那段跟着统计口径走，改了会和数字对不上。
 *
 * 三条规矩：
 *   1. 只提交**改过的**字段（后端是部分更新）；清空 = 真的清空，首页回退默认文案。
 *   2. 字段清单、类型与上限由后端下发（`fields`），前端不自己抄一份，免得两边漂。
 *   3. 每块下面都有「公众会看到什么」实时预览：不请求后端，纯本地渲染。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'

import {
  DEFAULT_CITE_INTRO,
  DEFAULT_CITE_RULES,
  DEFAULT_COOPERATION,
  DEFAULT_FOUNDATION_ITEMS,
  DEFAULT_INTRO_PARAGRAPHS,
  defaultCopyright
} from '../../constants/site-defaults'
import {
  fetchAdminSiteInfo,
  saveSiteInfo,
  type SiteInfoField,
  type SiteInfoPatch,
  type SiteInfoValues
} from '../../api/site'
import { inlineBold, splitLines, splitParagraphs } from '../../utils/siteText'

/** 表单里的一条「关于基金会」条目（emphasis 在这里必须是布尔，方便复选框双向绑定） */
interface FormEntry {
  title: string
  body: string
  emphasis: boolean
}

/** 表单状态（key 与后端白名单一一对应） */
interface FormState {
  contact: string
  email: string
  address: string
  cooperation: string
  copyright: string
  introBody: string
  foundationItems: FormEntry[]
  citeIntro: string
  citeRules: string[]
}

function emptyForm(): FormState {
  return {
    contact: '',
    email: '',
    address: '',
    cooperation: '',
    copyright: '',
    introBody: '',
    foundationItems: [],
    citeIntro: '',
    citeRules: []
  }
}

/** 深拷贝（只用于「已保存」快照与撤销，字段都是纯数据） */
function cloneForm(src: FormState): FormState {
  return JSON.parse(JSON.stringify(src)) as FormState
}

/** 按 key 取表单值（表单字段是动态的，只能过一层 Record） */
function valueOf(state: FormState, key: string): unknown {
  return (state as unknown as Record<string, unknown>)[key]
}

const loading = ref(true)
const saving = ref(false)
/** 读取 / 保存失败时页面上要有一句说明（读接口是静默的，不会弹全局提示） */
const errorText = ref('')
/** 后端下发的字段清单（含中文标签、类型、上限、填写提示） */
const fields = ref<SiteInfoField[]>([])

const form = reactive<FormState>(emptyForm())
/** 数据库里已保存的值（用来算「改过哪些」，只提交有变化的字段） */
const saved = ref<FormState>(emptyForm())

const year = new Date().getFullYear()

/* ---------------- 字段元数据 ---------------- */

function fieldOf(key: string): SiteInfoField | undefined {
  return fields.value.find((f) => f.key === key)
}

const introField = computed(() => fieldOf('introBody'))
const citeField = computed(() => fieldOf('citeIntro'))
const foundationField = computed(() => fieldOf('foundationItems'))
const rulesField = computed(() => fieldOf('citeRules'))

const maxItems = computed(() => foundationField.value?.max ?? 8)
const titleMax = computed(() => foundationField.value?.titleMax ?? 40)
const bodyMax = computed(() => foundationField.value?.bodyMax ?? 600)
const maxRules = computed(() => rulesField.value?.max ?? 12)
const ruleItemMax = computed(() => rulesField.value?.itemMax ?? 200)

/**
 * 后端是不是已经更新到支持新字段的版本。
 *
 * 本地后端是 `node dist/index.js` 起的常驻进程：前端热更新 / 重新打包后，
 * 后端**不重启**就还是旧代码（字段清单里没有 introBody 这些）。
 * 那种状态下新板块能看不能存 —— 必须明说，不能让老师以为保存成功了。
 */
const backendReady = computed(() => fields.value.some((f) => f.key === 'introBody'))

/* ---------------- 读 / 写 ---------------- */

function fillFrom(info: SiteInfoValues | null): void {
  const next: FormState = {
    contact: info?.contact ?? '',
    email: info?.email ?? '',
    address: info?.address ?? '',
    cooperation: info?.cooperation ?? '',
    copyright: info?.copyright ?? '',
    introBody: info?.introBody ?? '',
    citeIntro: info?.citeIntro ?? '',
    foundationItems: (info?.foundationItems ?? []).map((item) => ({
      title: item.title,
      body: item.body,
      emphasis: item.emphasis === true
    })),
    citeRules: [...(info?.citeRules ?? [])]
  }
  Object.assign(form, next)
  saved.value = cloneForm(next)
}

async function load(): Promise<void> {
  loading.value = true
  errorText.value = ''
  try {
    // 管理台读站点信息：先走管理接口 GET /admin/site-info，
    // 后端还没有这个读接口时自动退回公开的 GET /site-info（值一样，不白屏）。
    const res = await fetchAdminSiteInfo()
    fields.value = res.fields ?? []
    fillFrom(res.info ?? null)
  } catch {
    errorText.value = '机构信息读取失败，请刷新页面重试。'
  } finally {
    loading.value = false
  }
}

/** 改过的字段（用 JSON 比，数组 / 字符串都适用） */
const dirtyKeys = computed<string[]>(() =>
  fields.value
    .map((f) => f.key)
    .filter((key) => JSON.stringify(valueOf(form, key)) !== JSON.stringify(valueOf(saved.value, key)))
)

function isEmptyValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  return typeof value !== 'string' || value.trim() === ''
}

async function onSave(): Promise<void> {
  if (dirtyKeys.value.length === 0) {
    ElMessage.info('没有需要保存的改动')
    return
  }
  saving.value = true
  errorText.value = ''
  const patch: SiteInfoPatch = {}
  const put = <K extends keyof FormState>(key: K): void => {
    if (dirtyKeys.value.includes(key)) patch[key] = form[key]
  }
  put('contact')
  put('email')
  put('address')
  put('cooperation')
  put('copyright')
  put('introBody')
  put('citeIntro')
  put('foundationItems')
  put('citeRules')

  try {
    const res = await saveSiteInfo(patch)
    fillFrom(res.info ?? null)
    const cleared = res.changed.filter((key) => isEmptyValue(valueOf(saved.value, key)))
    ElMessage.success(
      cleared.length
        ? `已保存，其中 ${cleared.length} 项已清空（首页回退默认文案）`
        : `已保存（${res.changed.length} 项）`
    )
  } catch (err) {
    // 失败原因（邮箱格式不对、条目超长等）由统一拦截器弹出来，
    // 这里补一句页面内的说明；表单保留用户填的内容，改完可以直接再点保存。
    const response = (err as { response?: { status?: number; data?: { error?: { message?: string } } } })
      .response
    errorText.value = response?.data?.error?.message ?? '保存失败，请稍后再试。'
  } finally {
    saving.value = false
  }
}

function onReset(): void {
  Object.assign(form, cloneForm(saved.value))
}

/* ---------------- 关于基金会：条目编辑 ---------------- */

function addFoundation(): void {
  if (form.foundationItems.length >= maxItems.value) return
  form.foundationItems.push({ title: '', body: '', emphasis: false })
}

function removeFoundation(index: number): void {
  form.foundationItems.splice(index, 1)
}

function moveFoundation(index: number, delta: number): void {
  const target = index + delta
  if (target < 0 || target >= form.foundationItems.length) return
  const [item] = form.foundationItems.splice(index, 1)
  if (item) form.foundationItems.splice(target, 0, item)
}

/* ---------------- 引用与转载：规则编辑 ---------------- */

function addRule(): void {
  if (form.citeRules.length >= maxRules.value) return
  form.citeRules.push('')
}

function removeRule(index: number): void {
  form.citeRules.splice(index, 1)
}

/* ---------------- 预览（与首页同一套排版规则） ---------------- */

const coopRows = computed(() => [
  { key: 'contact', label: '联系方式', value: form.contact.trim() },
  { key: 'email', label: '邮箱', value: form.email.trim() },
  { key: 'address', label: '地址', value: form.address.trim() }
])

const coopPreviewText = computed(() => form.cooperation.trim() || DEFAULT_COOPERATION)
const copyrightPreview = computed(() => form.copyright.trim() || defaultCopyright(year))

const introPreview = computed(() => splitParagraphs(form.introBody))
const introIsEmpty = computed(() => introPreview.value.length === 0)

/** 预览里不显示全空的条目（首页也不会显示） */
const foundationPreview = computed(() =>
  form.foundationItems.filter((item) => item.title.trim() || item.body.trim())
)
const foundationIsEmpty = computed(() => foundationPreview.value.length === 0)

const citePreviewIntro = computed(() => form.citeIntro.trim() || DEFAULT_CITE_INTRO)
const citeIntroIsEmpty = computed(() => !form.citeIntro.trim())
const citePreviewRules = computed(() => form.citeRules.map((r) => r.trim()).filter(Boolean))
const citeRulesAreEmpty = computed(() => citePreviewRules.value.length === 0)

/** 预览：条目正文多行 → 圆点列表（核心方向那种） */
function itemLines(body: string): string[] {
  return splitLines(body)
}

/** 预览：引用与转载的 **加粗**（与首页同一个函数） */
function previewBold(text: string): string {
  return inlineBold(text)
}

/** 空态提示里要显示的默认条数 */
const defaultFoundationCount = DEFAULT_FOUNDATION_ITEMS.length
const defaultRulesCount = DEFAULT_CITE_RULES.length

onMounted(() => {
  void load()
})
</script>

<template>
  <div v-loading="loading" class="site-page">
    <p v-if="errorText" class="err-line">{{ errorText }}</p>
    <p v-if="!loading && !backendReady" class="err-line err-line--warn">
      后端服务还是旧版本：下面的新板块能看、但保存不了。请关掉启动窗口，重新双击「打开零废弃知识库.cmd」再进来。
    </p>

    <!-- ============ 1. 机构对外信息（原有 5 项，行为不变） ============ -->
    <section class="card">
      <div class="card-head">
        <h2>机构对外信息</h2>
        <p>
          这些内容会直接出现在<strong>首页的「合作与共建」与页脚</strong>上。没填的行，
          公众看到的是「待补充」—— 宁可空着，也不放没确认过的机构口径。
        </p>
      </div>

      <div class="grid">
        <label class="field">
          <span class="label">
            {{ fieldOf('contact')?.label ?? '联系方式' }}
            <em class="max">最多 {{ fieldOf('contact')?.max ?? 60 }} 字</em>
          </span>
          <el-input
            v-model="form.contact"
            :maxlength="fieldOf('contact')?.max ?? 60"
            show-word-limit
            :placeholder="fieldOf('contact')?.hint || '例如：电话 0551-xxxxxxx'"
          />
        </label>
        <label class="field">
          <span class="label">
            {{ fieldOf('email')?.label ?? '邮箱' }}
            <em class="max">最多 {{ fieldOf('email')?.max ?? 120 }} 字</em>
          </span>
          <el-input
            v-model="form.email"
            :maxlength="fieldOf('email')?.max ?? 120"
            show-word-limit
            :placeholder="fieldOf('email')?.hint || '公开对外邮箱'"
          />
        </label>
        <label class="field">
          <span class="label">
            {{ fieldOf('address')?.label ?? '地址' }}
            <em class="max">最多 {{ fieldOf('address')?.max ?? 160 }} 字</em>
          </span>
          <el-input
            v-model="form.address"
            :maxlength="fieldOf('address')?.max ?? 160"
            show-word-limit
            :placeholder="fieldOf('address')?.hint || '办公地址'"
          />
        </label>
        <label class="field">
          <span class="label">
            {{ fieldOf('cooperation')?.label ?? '合作与共建说明' }}
            <em class="max">最多 {{ fieldOf('cooperation')?.max ?? 300 }} 字</em>
          </span>
          <el-input
            v-model="form.cooperation"
            :maxlength="fieldOf('cooperation')?.max ?? 300"
            show-word-limit
            :placeholder="fieldOf('cooperation')?.hint || '留空则用站点默认文案'"
          />
        </label>
        <label class="field">
          <span class="label">
            {{ fieldOf('copyright')?.label ?? '页脚版权行' }}
            <em class="max">最多 {{ fieldOf('copyright')?.max ?? 120 }} 字</em>
          </span>
          <el-input
            v-model="form.copyright"
            :maxlength="fieldOf('copyright')?.max ?? 120"
            show-word-limit
            :placeholder="fieldOf('copyright')?.hint || '留空则用站点默认版权行'"
          />
        </label>
      </div>

      <div class="preview">
        <div class="preview-h">公众会看到什么<em>实时</em></div>
        <div class="preview-body">
          <h3>合作与共建</h3>
          <p>{{ coopPreviewText }}</p>
          <ul class="rows">
            <li v-for="row in coopRows" :key="row.key">
              <span class="k">{{ row.label }}</span>
              <span :class="{ todo: !row.value }">{{ row.value || '待补充' }}</span>
            </li>
          </ul>
          <p class="copy-line">{{ copyrightPreview }}</p>
        </div>
      </div>
    </section>

    <!-- ============ 2. 首页 · 项目简介 ============ -->
    <section class="card">
      <div class="card-head">
        <h2>首页 · 项目简介</h2>
        <p>
          只开放<strong>正文</strong>。空一行 = 分一段。下面那排绿色小胶囊
          （统一标注发布机构／把找资料这一步做掉／资料本身留给使用者判断）已按你的要求从首页删掉。
        </p>
      </div>

      <div class="field">
        <span class="label">
          正文
          <em class="max">最多 {{ introField?.max ?? 1000 }} 字</em>
        </span>
        <el-input
          v-model="form.introBody"
          type="textarea"
          :maxlength="introField?.max ?? 1000"
          show-word-limit
          :autosize="{ minRows: 6, maxRows: 16 }"
          placeholder="空一行分一段。留空则首页用默认文案。"
        />
        <span class="hint">{{ introField?.hint || '空一行 = 分一段；留空则用站点默认文案' }}</span>
      </div>

      <div class="preview">
        <div class="preview-h">公众会看到什么<em>实时</em></div>
        <div class="preview-body">
          <template v-if="introIsEmpty">
            <p class="empty-note">正文空着 → 首页沿用默认文案（下面这段）：</p>
            <p v-for="(p, i) in DEFAULT_INTRO_PARAGRAPHS" :key="`d${i}`" class="is-default">{{ p }}</p>
          </template>
          <template v-else>
            <p v-for="(p, i) in introPreview" :key="i">{{ p }}</p>
          </template>
        </div>
      </div>
    </section>

    <!-- ============ 3. 首页 · 关于基金会 ============ -->
    <section class="card">
      <div class="card-head">
        <h2>首页 · 关于基金会</h2>
        <p>
          可改<strong>小标题 + 正文</strong>，也可增加、删除、调整顺序。
          机构名固定（安徽省六尺巷慈善基金会），不在这里改。
        </p>
      </div>

      <div class="fixed-row">
        <span class="label">机构名<em class="max">固定，不开放编辑</em></span>
        <span class="fixed-value">安徽省六尺巷慈善基金会</span>
      </div>

      <div class="entries">
        <div v-for="(item, index) in form.foundationItems" :key="index" class="entry">
          <div class="entry-top">
            <span class="entry-no">{{ index + 1 }}</span>
            <el-input
              v-model="item.title"
              class="entry-title"
              :maxlength="titleMax"
              placeholder="小标题，例如：基金会简介"
            />
            <div class="entry-acts">
              <el-button link size="small" :disabled="index === 0" @click="moveFoundation(index, -1)">
                上移
              </el-button>
              <el-button
                link
                size="small"
                :disabled="index === form.foundationItems.length - 1"
                @click="moveFoundation(index, 1)"
              >
                下移
              </el-button>
              <el-button link size="small" type="danger" @click="removeFoundation(index)">
                删除
              </el-button>
            </div>
          </div>
          <el-input
            v-model="item.body"
            type="textarea"
            class="entry-body"
            :maxlength="bodyMax"
            show-word-limit
            :autosize="{ minRows: 2, maxRows: 10 }"
            placeholder="正文；多行 = 首页显示成圆点列表（像「核心方向」那样）"
          />
          <label class="emphasis">
            <el-checkbox v-model="item.emphasis">强调显示（首页浅绿底）</el-checkbox>
            <span class="hint">原来「机构宗旨」就是这种样式。</span>
          </label>
        </div>
      </div>

      <div class="add-row">
        <el-button :disabled="form.foundationItems.length >= maxItems" @click="addFoundation">
          + 添加一条
        </el-button>
        <span class="add-note">
          最多 {{ maxItems }} 条，当前 {{ form.foundationItems.length }} 条；
          全部删掉 = 首页恢复默认的 {{ defaultFoundationCount }} 条
        </span>
      </div>

      <div class="preview">
        <div class="preview-h">公众会看到什么<em>实时</em></div>
        <div class="preview-body">
          <p class="org">安徽省六尺巷慈善基金会</p>
          <template v-if="foundationIsEmpty">
            <p class="empty-note">
              一条都没有 → 首页恢复默认的 {{ defaultFoundationCount }} 条（下面这些）：
            </p>
            <div v-for="(item, i) in DEFAULT_FOUNDATION_ITEMS" :key="`d${i}`" class="fund-item">
              <h3 v-if="item.title">{{ item.title }}</h3>
              <p class="is-default">{{ item.body }}</p>
            </div>
          </template>
          <template v-else>
            <div v-for="(item, i) in foundationPreview" :key="i" class="fund-item">
              <h3 v-if="item.title.trim()">{{ item.title }}</h3>
              <ul v-if="itemLines(item.body).length > 1">
                <li v-for="(line, j) in itemLines(item.body)" :key="j">{{ line }}</li>
              </ul>
              <p v-else :class="{ 'is-emphasis': item.emphasis }">{{ item.body }}</p>
            </div>
          </template>
        </div>
      </div>
    </section>

    <!-- ============ 4. 首页 · 引用与转载 ============ -->
    <section class="card">
      <div class="card-head">
        <h2>首页 · 引用与转载</h2>
        <p>
          可改<strong>开头正文</strong>，下面每条规则也能改文字、增加或删除。
          用 <code>**两个星号**</code> 包住的字在首页会加粗。
        </p>
      </div>

      <div class="field">
        <span class="label">
          开头正文
          <em class="max">最多 {{ citeField?.max ?? 600 }} 字</em>
        </span>
        <el-input
          v-model="form.citeIntro"
          type="textarea"
          :maxlength="citeField?.max ?? 600"
          show-word-limit
          :autosize="{ minRows: 3, maxRows: 10 }"
          placeholder="留空则首页用默认文案"
        />
        <span class="hint">{{ citeField?.hint || '留空则用站点默认文案' }}</span>
      </div>

      <div class="field">
        <span class="label">
          规则
          <em class="max">每条最多 {{ ruleItemMax }} 字</em>
        </span>
        <div class="rules">
          <div v-for="(_, index) in form.citeRules" :key="index" class="rule">
            <span class="rule-no">{{ index + 1 }}</span>
            <el-input
              v-model="form.citeRules[index]"
              class="rule-input"
              :maxlength="ruleItemMax"
              placeholder="写一条引用或转载规则"
            />
            <el-button link size="small" type="danger" @click="removeRule(index)">删除</el-button>
          </div>
        </div>
        <div class="add-row">
          <el-button :disabled="form.citeRules.length >= maxRules" @click="addRule">
            + 添加一条规则
          </el-button>
          <span class="add-note">
            最多 {{ maxRules }} 条，当前 {{ form.citeRules.length }} 条；
            全部删掉 = 首页恢复默认的 {{ defaultRulesCount }} 条
          </span>
        </div>
      </div>

      <div class="preview">
        <div class="preview-h">公众会看到什么<em>实时</em></div>
        <div class="preview-body">
          <!-- eslint-disable vue/no-v-html -->
          <template v-if="citeIntroIsEmpty">
            <p class="empty-note">正文空着 → 首页沿用默认文案（下面这段）：</p>
            <p class="is-default" v-html="previewBold(DEFAULT_CITE_INTRO)"></p>
          </template>
          <p v-else v-html="previewBold(citePreviewIntro)"></p>

          <template v-if="citeRulesAreEmpty">
            <p class="empty-note">规则一条都没有 → 首页恢复默认的 {{ defaultRulesCount }} 条：</p>
            <ul>
              <li v-for="(rule, i) in DEFAULT_CITE_RULES" :key="`d${i}`" v-html="previewBold(rule)"></li>
            </ul>
          </template>
          <ul v-else>
            <li v-for="(rule, i) in citePreviewRules" :key="i" v-html="previewBold(rule)"></li>
          </ul>
          <!-- eslint-enable vue/no-v-html -->
        </div>
      </div>
    </section>

    <!-- ============ 5. 首页 · 资料分布（只读） ============ -->
    <section class="card">
      <div class="card-head">
        <h2>首页 · 资料分布<em class="tag-fixed">只读</em></h2>
        <p>
          图下的「其他 = …」和那行口径小字，已收进首页标题旁的圆圈「!」，点开才显示。
          这里不开放编辑 —— 这段跟着统计口径走，改了会和数字对不上。
        </p>
      </div>
      <p class="hint">数字本身来自资料库统计，不在这里手填；要改数字只能改资料库里的资料。</p>
    </section>

    <!-- ============ 底部：统一保存 ============ -->
    <div class="savebar">
      <el-button type="primary" :loading="saving" :disabled="dirtyKeys.length === 0" @click="onSave">
        保存全部改动
      </el-button>
      <el-button :disabled="saving || dirtyKeys.length === 0" @click="onReset">撤销改动</el-button>
      <span class="dirty-hint">
        <template v-if="dirtyKeys.length">有 {{ dirtyKeys.length }} 项待保存</template>
        <template v-else>没有未保存的改动</template>
      </span>
      <span class="spacer"></span>
      <span class="dirty-hint">保存后立刻对外生效</span>
    </div>
  </div>
</template>

<style scoped>
.site-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-bottom: 8px;
}

.card {
  padding: 20px 22px 18px;
  background: var(--zw-surface);
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  box-shadow: var(--zw-shadow-sm);
}

.card-head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--zw-ink);
}

.card-head p {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--zw-muted);
}

.card-head p strong {
  color: var(--zw-text);
  font-weight: 600;
}

.tag-fixed {
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--zw-mint);
  font-style: normal;
  font-size: 11px;
  font-weight: 400;
  color: var(--zw-green-deep);
  vertical-align: 3px;
}

.err-line {
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: #fdf1ef;
  font-size: 13px;
  color: #c0392b;
}

/* 后端还是旧版本：提醒但不当作错误（红色会让人以为是自己填错了） */
.err-line--warn {
  background: var(--zw-amber-soft);
  color: var(--zw-amber-ink);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 14px 20px;
  margin-top: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 16px;
}

.grid .field {
  margin-top: 0;
}

.label {
  font-size: 13px;
  font-weight: 600;
  color: var(--zw-text);
}

.label .max {
  margin-left: 6px;
  font-style: normal;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--zw-faint);
}

.hint {
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--zw-faint);
}

/* ---- 关于基金会 ---- */
.fixed-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 16px;
}

.fixed-value {
  padding: 0 11px;
  height: 34px;
  line-height: 34px;
  border: 1px dashed var(--zw-line-strong);
  border-radius: 10px;
  background: var(--zw-mint-2);
  font-size: 13px;
  color: var(--zw-muted);
}

.entries {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}

.entry {
  padding: 12px;
  border: 1px solid var(--zw-line);
  border-radius: 12px;
  background: #fbfdfb;
}

.entry-top {
  display: flex;
  align-items: center;
  gap: 10px;
}

.entry-no {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--zw-mint);
  color: var(--zw-green-deep);
  font-size: 11px;
  font-weight: 700;
}

.entry-title {
  flex: 1;
  min-width: 0;
}

.entry-acts {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.entry-body {
  margin-top: 8px;
}

.emphasis {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.add-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.add-note {
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--zw-faint);
}

/* ---- 引用与转载 ---- */
.rules {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rule {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rule-no {
  flex: 0 0 18px;
  font-size: 12px;
  color: var(--zw-faint);
  font-variant-numeric: tabular-nums;
}

.rule-input {
  flex: 1;
  min-width: 0;
}

/* ---- 实时预览（与首页同一套观感） ---- */
.preview {
  margin-top: 18px;
  padding: 14px 18px 16px;
  border: 1px solid var(--zw-line);
  border-radius: 12px;
  background: var(--zw-mint-2);
}

.preview-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--zw-line);
  font-size: 13px;
  font-weight: 700;
  color: var(--zw-green-deep);
}

.preview-h em {
  font-style: normal;
  font-size: 11px;
  font-weight: 400;
  color: var(--zw-faint);
}

.preview-body {
  font-size: 13px;
  line-height: 1.9;
  color: var(--zw-text);
}

.preview-body > p {
  margin: 0 0 10px;
}

.preview-body > p:last-child {
  margin-bottom: 0;
}

.preview-body h3 {
  margin: 14px 0 4px;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--zw-ink);
}

.preview-body h3:first-child {
  margin-top: 0;
}

.preview-body ul {
  margin: 4px 0 10px;
  padding-left: 18px;
}

.preview-body li {
  margin: 2px 0;
}

.preview-body .org {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--zw-green-deep);
}

.preview-body .rows {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.preview-body .rows li {
  display: flex;
  gap: 12px;
}

.preview-body .rows .k {
  flex: 0 0 64px;
  color: var(--zw-muted);
}

.preview-body .todo {
  color: var(--zw-faint);
  border-bottom: 1px dashed var(--zw-line-strong);
}

.preview-body .copy-line {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--zw-line);
  font-size: 12px;
  color: var(--zw-faint);
}

.preview-body .empty-note {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--zw-amber-ink);
}

.preview-body .is-default {
  color: var(--zw-muted);
}

.preview-body .is-emphasis {
  padding: 8px 12px;
  border-left: 3px solid var(--zw-green-soft);
  border-radius: 0 8px 8px 0;
  background: #fff;
}

.preview-body code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--zw-mint);
  font-size: 12px;
}

/* ---- 底部保存条 ---- */
.savebar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 22px;
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  background: var(--zw-surface);
  box-shadow: var(--zw-shadow-sm);
}

.dirty-hint {
  font-size: 12.5px;
  color: var(--zw-faint);
}

.spacer {
  flex: 1;
}

@media (max-width: 720px) {
  .card {
    padding: 16px 14px 14px;
  }

  .grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .entry-top {
    flex-wrap: wrap;
  }

  .entry-acts {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
