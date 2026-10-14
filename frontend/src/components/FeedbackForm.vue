<script setup lang="ts">
/**
 * 访客反馈表单 —— 2026-10-14 新增
 *
 * 对应任务单里前端「反馈 / 联系」那一栏。此前全站只有一个孤零零的 `feedback_submit`
 * 埋点事件名躺在白名单里，没有任何提交入口 —— 那条埋点永远是 0。
 *
 * 匿名可提交：这是「关于项目」页对公众的邀请，要求先注册再反馈等于把大部分反馈挡在门外。
 * 后端配了游客权限开关、类型白名单、长度上限与频率限制（见 backend/src/routes/feedback.ts）。
 *
 * 目前只挂在「关于项目」页的联系与共建区（不传 docId / docTitle）。
 * ⚠️ 合并记录（2026-10-14）：资料详情页原本也挂了本组件（传 docId / docTitle 做「纠错」），
 *   合并时发现该页已有 B09 的「反馈这份资料」（FeedbackDialog，资料级），两者是同一动作的
 *   重复出口，且本组件当时绕过了 T11 的游客权限开关 —— 故从详情页撤下，只留这一处。
 *   `docId` / `docTitle` / `defaultKind` 三个 prop 因此暂时无人传，保留是为了少一个改动面、
 *   也为了将来若把详情页的入口统一到这条链路上时可以直接用。
 */
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  FEEDBACK_KIND_HINTS,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_KINDS,
  FEEDBACK_MAX_CONTACT_CHARS,
  FEEDBACK_MAX_MESSAGE_CHARS,
  submitFeedback,
  type FeedbackKind
} from '../api/feedback'

const props = withDefaults(
  defineProps<{ docId?: string; docTitle?: string; defaultKind?: FeedbackKind }>(),
  {
    docId: '',
    docTitle: '',
    defaultKind: 'recommend'
  }
)

const route = useRoute()

const kind = ref<FeedbackKind>(props.defaultKind)
const message = ref('')
const contact = ref('')
const submitting = ref(false)
const errorText = ref('')
const done = ref(false)

const kinds = FEEDBACK_KINDS.map((value) => ({
  value,
  label: FEEDBACK_KIND_LABELS[value],
  hint: FEEDBACK_KIND_HINTS[value]
}))

const tooLong = computed(() => message.value.length > FEEDBACK_MAX_MESSAGE_CHARS)

async function submit(): Promise<void> {
  if (!message.value.trim()) {
    errorText.value = '请写一下反馈内容'
    return
  }
  if (tooLong.value) {
    errorText.value = `反馈内容最多 ${FEEDBACK_MAX_MESSAGE_CHARS} 字`
    return
  }

  submitting.value = true
  errorText.value = ''
  try {
    await submitFeedback({
      kind: kind.value,
      message: message.value.trim(),
      contact: contact.value.trim(),
      docId: props.docId,
      docTitle: props.docTitle,
      path: route.fullPath
    })
    done.value = true
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : '提交失败，请稍后再试'
  } finally {
    submitting.value = false
  }
}

/** 提交成功后再提一条：清空内容、回到初始态 */
function reset(): void {
  done.value = false
  message.value = ''
  contact.value = ''
  kind.value = props.defaultKind
}
</script>

<template>
  <div class="fb zw-card zw-card--pad">
    <div v-if="done" class="fb-done">
      <p class="fb-done-title">收到了，谢谢。</p>
      <p class="fb-done-text">
        我们会尽快查看。如果留了联系方式，会有同事回复你。
      </p>
      <el-button link type="primary" @click="reset">再提一条</el-button>
    </div>

    <template v-else>
      <p class="fb-lead">
        <template v-if="docTitle">
          关于资料《{{ docTitle }}》——可以在这里直接告诉我们哪里不对。
        </template>
        <template v-else> 不用登录也能提交，我们会尽快查看。 </template>
      </p>

      <el-form label-position="top">
        <el-form-item label="反馈类型">
          <el-radio-group v-model="kind">
            <el-radio v-for="k in kinds" :key="k.value" :value="k.value" class="fb-radio">
              {{ k.label }}
              <span class="fb-kind-hint">{{ k.hint }}</span>
            </el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="反馈内容">
          <el-input
            v-model="message"
            type="textarea"
            :rows="4"
            :maxlength="FEEDBACK_MAX_MESSAGE_CHARS"
            show-word-limit
            placeholder="例如：某份资料的发布年份与原件不符；或推荐一份值得收录的公开资料（附链接更好）。"
          />
        </el-form-item>

        <el-form-item label="联系方式（选填）">
          <el-input
            v-model="contact"
            :maxlength="FEEDBACK_MAX_CONTACT_CHARS"
            placeholder="邮箱或电话，方便我们回复"
          />
        </el-form-item>
      </el-form>

      <p v-if="errorText" class="fb-err">{{ errorText }}</p>

      <div class="fb-foot">
        <el-button type="primary" :loading="submitting" @click="submit">提交反馈</el-button>
        <span class="fb-note">
          联系方式只用于回复，不会公开展示，也不会写进任何对外页面。
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.fb-lead {
  margin: 0 0 16px;
  font-size: 14px;
  line-height: 1.8;
  color: var(--zw-text);
}

.fb-radio {
  display: flex;
  align-items: center;
  height: auto;
  margin-right: 18px;
  margin-bottom: 6px;
}

.fb-kind-hint {
  margin-left: 6px;
  font-size: 12px;
  color: var(--zw-faint);
}

.fb-err {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--zw-danger);
}

.fb-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.fb-note {
  font-size: 12px;
  line-height: 1.7;
  color: var(--zw-faint);
}

.fb-done-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--zw-green-ink);
}

.fb-done-text {
  margin: 0 0 8px;
  font-size: 14px;
  line-height: 1.8;
  color: var(--zw-text);
}
</style>
