<script setup lang="ts">
/**
 * 反馈弹窗 —— 对外展示站的「访客能说话」入口（B09，2026-10-12 新增）
 *
 * 两类反馈共用这一个弹窗，用 scope 区分（两个入口分别挂在资料详情页与页脚）：
 *   - scope="doc" ：针对**某一份资料**（内容有误 / 文件打不开 / 重复收录 / 希望补充）
 *   - scope="site"：针对**站点本身**（功能建议 / 内容建议 / 使用问题 / 其他）
 *
 * 落库口径：**不新增接口、不新增事件名**，走已有的 POST /api/track，用白名单里现成的
 * `feedback_submit`（真相来源：backend/src/track/types.ts）。
 *
 * 2026-10-13（B09 公众上传）：四个原因 / 四个分类 / 字数上限 / 提交 payload 已抽到
 *   `src/constants/feedback.ts`，与「我要投稿」页的反馈 Tab 共用同一份 —— 免得两处漂。
 *   本文件的职责只剩「把这个弹窗画出来」。
 *
 * 为什么匿名也能提：反馈是「路过的访客也可能发现错」的场景，卡登录会挡住最有用的那部分反馈；
 * 联系方式做成选填，愿意留的我们才能回。
 * 埋点本身是尽力而为的旁路（见 api/track.ts）：网络异常不影响页面，也不会把用户卡在弹窗里。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  DOC_REASONS,
  FEEDBACK_TEXT_MAX,
  SITE_FEEDBACK_HINT,
  SITE_KINDS,
  submitFeedback
} from '../constants/feedback'
import { useAuth } from '../composables/useAuth'

const props = withDefaults(
  defineProps<{
    /** v-model：弹窗开关 */
    modelValue: boolean
    /** 反馈对象：资料级 / 站点级 */
    scope?: 'doc' | 'site'
    /** 资料级必传：被反馈资料的 id（站点级忽略） */
    docId?: string
    /** 资料级必传：被反馈资料的标题，写进 payload 便于人工排查 */
    docTitle?: string
  }>(),
  { scope: 'site', docId: '', docTitle: '' }
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 提交成功（父组件可用来做埋点/提示，非必须） */
  submitted: []
}>()

const route = useRoute()
const { user } = useAuth()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const isDoc = computed(() => props.scope === 'doc')

const form = reactive({ reason: '', text: '', contact: '' })
const submitting = ref(false)

const title = computed(() => (isDoc.value ? '这份资料有问题？' : '意见反馈'))
const intro = computed(() =>
  isDoc.value
    ? `你正在反馈：${props.docTitle || '这份资料'}。我们会核实后修正或撤下，感谢你帮我们发现问题。`
    : SITE_FEEDBACK_HINT
)
const options = computed(() => (isDoc.value ? DOC_REASONS : SITE_KINDS))
const textPlaceholder = computed(() =>
  isDoc.value
    ? '补充说明（选填）：具体哪里不对、什么情况下打不开……'
    : '请写下你的建议或遇到的问题（必填）'
)

/** 每次打开都从空白开始：上一条的留言留在框里，用户很容易误发 */
watch(visible, (open) => {
  if (open) {
    form.reason = ''
    form.text = ''
    form.contact = ''
  }
})

async function onSubmit(): Promise<void> {
  if (submitting.value) return
  if (!form.reason) {
    ElMessage.warning(isDoc.value ? '请选择问题类型' : '请选择反馈分类')
    return
  }
  const text = form.text.trim()
  // 站点级反馈的价值全在这段文字里，空着等于没反馈；资料级可以只勾原因
  if (!isDoc.value && !text) {
    ElMessage.warning('请填写反馈内容')
    return
  }

  submitting.value = true
  try {
    await submitFeedback({
      scope: isDoc.value ? 'doc' : 'site',
      reason: form.reason,
      text,
      contact: form.contact,
      docId: props.docId,
      docTitle: props.docTitle,
      path: route.fullPath,
      userId: user.value?.id ?? null
    })

    ElMessage.success(isDoc.value ? '已收到，感谢你帮我们发现问题' : '反馈已提交，感谢你的建议')
    emit('submitted')
    visible.value = false
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="title"
    width="520px"
    :close-on-click-modal="false"
    append-to-body
    class="feedback-dialog"
  >
    <p class="fb-intro">{{ intro }}</p>

    <div class="fb-field">
      <label class="fb-label">
        {{ isDoc ? '问题类型' : '反馈分类' }}<span class="fb-req">*</span>
      </label>
      <el-radio-group v-model="form.reason" class="fb-options">
        <el-radio v-for="opt in options" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </el-radio>
      </el-radio-group>
    </div>

    <div class="fb-field">
      <label class="fb-label">
        详细说明<span v-if="isDoc" class="fb-opt">（选填）</span><span v-else class="fb-req">*</span>
      </label>
      <el-input
        v-model="form.text"
        type="textarea"
        :rows="4"
        :maxlength="FEEDBACK_TEXT_MAX"
        show-word-limit
        :placeholder="textPlaceholder"
      />
    </div>

    <div class="fb-field">
      <label class="fb-label">联系方式<span class="fb-opt">（选填，便于我们回复你）</span></label>
      <el-input v-model="form.contact" maxlength="60" clearable placeholder="邮箱 / 微信等，选填" />
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="onSubmit">
        {{ submitting ? '提交中…' : '提交反馈' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.fb-intro {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--zw-muted);
}

.fb-field {
  margin-bottom: 16px;
}

.fb-label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--zw-ink);
}

.fb-req {
  margin-left: 2px;
  color: #d9534f;
}

.fb-opt {
  color: var(--zw-faint);
}

.fb-options {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
</style>
