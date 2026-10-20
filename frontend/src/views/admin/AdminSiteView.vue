<script setup lang="ts">
/**
 * 机构信息 —— 2026-10-19 新增（管理台改造）
 *
 * 解决的问题：首页「合作与共建」里的**联系方式 / 邮箱 / 地址**三行以前写死成
 * 「待补充」，因为那属于基金会的对外口径，没确认前不能编（见 AboutView 时代的旧注释）。
 * 现在改成：老师在管理台里填，首页与页脚自动显示；**空着就仍然显示「待补充」**。
 *
 * 三条规矩：
 *   1. 只提交**改过的**字段（后端是部分更新）；清空某一行 = 真的清空，不是恢复默认。
 *   2. 字段清单与长度上限由后端下发（`fields`），前端不自己抄一份，免得两边漂。
 *   3. 邮箱由后端校验格式（前端只提示，不做「看起来像就放行」的假验证）。
 *
 * 右侧那张预览卡是故意的：老师填的时候能直接看到公众会看到什么样子。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { DEFAULT_COOPERATION, defaultCopyright } from '../../constants/site-defaults'
import {
  fetchSiteInfo,
  saveSiteInfo,
  type SiteInfoField,
  type SiteInfoValues
} from '../../api/site'

const loading = ref(true)
const saving = ref(false)
/** 后端下发的字段清单（含中文标签、长度上限、填写提示） */
const fields = ref<SiteInfoField[]>([])
/** 表单当前值 */
const form = reactive<SiteInfoValues>({})
/** 数据库里已保存的值（用来算「改过哪些」，只提交有变化的字段） */
const saved = reactive<SiteInfoValues>({})

/** 本次改动的字段清单 */
const dirty = computed(() => fields.value.filter((f) => (form[f.key] ?? '') !== (saved[f.key] ?? '')))
/** 有没有任何一行填了内容（用于顶部那句状态话术） */
const filledCount = computed(() => fields.value.filter((f) => (form[f.key] ?? '').trim()).length)

function fillFrom(values: SiteInfoValues): void {
  for (const f of fields.value) {
    form[f.key] = values[f.key] ?? ''
    saved[f.key] = values[f.key] ?? ''
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await fetchSiteInfo()
    fields.value = res.fields ?? []
    fillFrom(res.info ?? {})
  } catch {
    // 统一拦截器已提示
  } finally {
    loading.value = false
  }
}

async function onSave(): Promise<void> {
  const patch: SiteInfoValues = {}
  for (const f of dirty.value) patch[f.key] = (form[f.key] ?? '').trim()
  if (Object.keys(patch).length === 0) {
    ElMessage.info('没有需要保存的改动')
    return
  }
  saving.value = true
  try {
    const res = await saveSiteInfo(patch)
    fillFrom(res.info ?? {})
    const cleared = res.changed.filter((k) => !(res.info[k] ?? '').trim())
    ElMessage.success(
      cleared.length
        ? `已保存，其中 ${cleared.length} 行已清空`
        : `已保存（${res.changed.length} 项）`
    )
  } catch {
    // 失败提示由统一拦截器给（含邮箱格式、字段名不认识等后端原因）
  } finally {
    saving.value = false
  }
}

/** 预览用：空值显示「待补充」，与首页同一套口径 */
function orTodo(v: string | undefined): string {
  return (v ?? '').trim() || '待补充'
}

/** 预览里的三行联系信息（首页「合作与共建」就长这样） */
const CONTACT_ROWS = [
  { key: 'contact', label: '联系方式' },
  { key: 'email', label: '邮箱' },
  { key: 'address', label: '地址' }
] as const

/** 版权行留空时会显示的那条默认文案（与 SiteFooter 保持一致） */
const year = new Date().getFullYear()

onMounted(() => {
  void load()
})
</script>

<template>
  <div v-loading="loading" class="site-page">
    <section class="card">
      <div class="card-head">
        <h2>机构对外信息</h2>
        <p>
          这些内容会直接出现在<strong>首页的「合作与共建」与页脚</strong>上。没填的行，
          公众看到的是「待补充」—— 宁可空着，也不放没确认过的机构口径。
        </p>
      </div>

      <p class="status" :class="{ 'is-empty': filledCount === 0 }">
        当前已填 {{ filledCount }} / {{ fields.length }} 项。
        <span v-if="filledCount === 0">全部空着，首页会显示「待补充」。</span>
      </p>

      <div class="grid">
        <label v-for="f in fields" :key="f.key" class="field">
          <span class="label">
            {{ f.label }}
            <em class="max">最多 {{ f.max }} 字</em>
          </span>
          <el-input
            v-model="form[f.key]"
            :maxlength="f.max"
            show-word-limit
            :placeholder="f.hint || `请填写${f.label}`"
          />
        </label>
      </div>

      <div class="actions">
        <el-button type="primary" :loading="saving" :disabled="dirty.length === 0" @click="onSave">
          保存
        </el-button>
        <el-button :disabled="saving || dirty.length === 0" @click="fillFrom(saved)">撤销改动</el-button>
        <span class="dirty-hint">
          <template v-if="dirty.length">有 {{ dirty.length }} 项待保存</template>
          <template v-else>没有未保存的改动</template>
        </span>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>公众会看到什么</h2>
        <p>下面这块就是首页「合作与共建」的真实排版，内容跟着左边实时变。</p>
      </div>

      <div class="preview">
        <h3>合作与共建</h3>
        <p class="coop-text">
          {{ orTodo(form.cooperation) === '待补充' ? DEFAULT_COOPERATION : form.cooperation }}
        </p>
        <ul class="rows">
          <li v-for="row in CONTACT_ROWS" :key="row.key">
            <span class="row-label">{{ row.label }}</span>
            <span class="row-value" :class="{ 'is-todo': orTodo(form[row.key]) === '待补充' }">
              {{ orTodo(form[row.key]) }}
            </span>
          </li>
        </ul>
        <p class="copy-line">
          {{ (form.copyright ?? '').trim() || `留空时显示默认行：${defaultCopyright(year)}` }}
        </p>
      </div>
    </section>
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

.status {
  margin: 14px 0 0;
  font-size: 12.5px;
  color: var(--zw-green-deep);
}

.status.is-empty {
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

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--zw-line);
}

.dirty-hint {
  font-size: 12.5px;
  color: var(--zw-faint);
}

/* ---- 右侧预览：与首页同一套视觉（绿标题 + 发丝线 + 三行联系信息） ---- */
.preview {
  margin-top: 16px;
  padding: 18px 20px;
  background: var(--zw-mint-2);
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius-sm);
}

.preview h3 {
  margin: 0 0 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--zw-line);
  font-size: 15px;
  font-weight: 700;
  color: var(--zw-green-deep);
}

.coop-text {
  margin: 0 0 12px;
  font-size: 13.5px;
  line-height: 1.8;
  color: var(--zw-text);
}

.rows {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rows li {
  display: flex;
  gap: 14px;
  font-size: 13px;
}

.row-label {
  flex: 0 0 64px;
  color: var(--zw-muted);
}

.row-value {
  color: var(--zw-text);
}

.row-value.is-todo {
  color: var(--zw-faint);
  border-bottom: 1px dashed var(--zw-line-strong);
}

.copy-line {
  margin: 14px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--zw-line);
  font-size: 12px;
  color: var(--zw-faint);
}

/* 窄屏：预览卡与表单同宽堆叠即可 */
@media (max-width: 720px) {
  .card {
    padding: 16px 14px 14px;
  }

  .grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .actions {
    flex-wrap: wrap;
  }
}
</style>
