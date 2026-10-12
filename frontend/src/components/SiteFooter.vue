<script setup lang="ts">
/**
 * 页脚 —— 对外展示站版（2026-10-10 新增）
 *
 * 对外站点必须有页脚：它是「这是谁办的、数据哪来的、能不能引用、怎么联系」的落脚点，
 * 也是「管理后台」这类内部入口该待的地方（不占导航条，但找得到）。
 *
 * ⚠️ 页脚里的机构描述与联系方式目前只写**可核实的事实**（数据来自台账、份数、年份跨度）。
 *    机构使命、地址、电话等属于基金会对外口径，未经确认一律留占位符，
 *    绝不由我编一段听起来很合理的话填进去（见 docs/对外展示站改造说明 第五节）。
 */
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'

import { getOverview } from '../api/overview'
import { trackEvent } from '../api/track'
import { formatCount } from '../utils/format'

const total = ref<number | null>(null)
const route = useRoute()

/* ---------------------------------------------------------------- 意见反馈（R12）
 *
 * 为什么是表单而不是留一个邮箱：**基金会的对外联系方式尚未确认**（页脚注释已说明，
 * 未核实的信息一律不编）。所以入口做成站内表单，内容走已有的埋点通道落库，
 * 不新增接口、不新增后端字段。后端事件白名单里 `feedback_submit` 早已就绪。
 *
 * 匿名可提交：公众站不该为了提一条意见先注册（与 AI 问答「访客免注册」同一取舍）。
 * 落库内容由看板侧按需取；本组件只负责发出去与给一句回执。
 */
const FEEDBACK_KINDS = ['资料纠错', '资料推荐', '功能建议', 'AI 回答问题', '其他'] as const
/** 与后端 payload 上限（4000 字符）留足余量，同时防一次粘贴灌爆 */
const FEEDBACK_MAX_CHARS = 1000

const feedbackOpen = ref(false)
const feedbackKind = ref<string>(FEEDBACK_KINDS[0])
const feedbackText = ref('')
const feedbackBusy = ref(false)

function openFeedback(): void {
  feedbackOpen.value = true
}

/** 关掉就清空，不把上一条意见留给下一个人看（公众站共用一台设备的情况真实存在） */
function onFeedbackClosed(): void {
  feedbackKind.value = FEEDBACK_KINDS[0]
  feedbackText.value = ''
}

async function submitFeedback(): Promise<void> {
  const content = feedbackText.value.trim()
  if (!content) {
    ElMessage.warning('请先写点内容')
    return
  }

  feedbackBusy.value = true
  try {
    // trackEvent 永不 reject（内部吞异常），所以这里一定能走到成功回执。
    // 埋点是旁路：宁可少一条统计，也不能让一次正常提交给用户报错。
    await trackEvent({
      event: 'feedback_submit',
      path: route.fullPath,
      payload: {
        kind: feedbackKind.value,
        content: content.slice(0, FEEDBACK_MAX_CHARS)
      }
    })
    ElMessage.success('已收到，谢谢你的反馈')
    feedbackOpen.value = false
  } finally {
    feedbackBusy.value = false
  }
}

onMounted(() => {
  void getOverview().then((data) => {
    if (data) total.value = data.total
  })
})
</script>

<template>
  <footer class="site-footer">
    <div class="zw-container foot-grid">
      <div class="foot-brand">
        <h3>零废弃知识库</h3>
        <p>
          面向公众开放的零废弃领域资料库，收录政策法规、研究报告、标准规范与实践工具，
          提供分类浏览、关键词检索与 AI 问答。
        </p>
        <p class="foot-stat">
          已收录 <strong class="zw-num">{{ total === null ? '—' : formatCount(total) }}</strong> 份资料
        </p>
      </div>

      <div class="foot-col">
        <h4>浏览</h4>
        <RouterLink to="/shelf">资料库</RouterLink>
        <RouterLink to="/insights">数据概览</RouterLink>
        <RouterLink to="/about">关于项目</RouterLink>
      </div>

      <div class="foot-col">
        <h4>使用</h4>
        <RouterLink to="/about#data">数据来源与口径</RouterLink>
        <RouterLink to="/about#cite">引用与转载</RouterLink>
        <RouterLink to="/about#contact">联系与共建</RouterLink>
        <button type="button" class="foot-link" @click="openFeedback">意见反馈</button>
      </div>

      <div class="foot-col">
        <h4>站点</h4>
        <RouterLink to="/auth">登录 / 注册</RouterLink>
        <RouterLink to="/admin/knowledge" class="foot-admin">资料管理（内部）</RouterLink>
        <RouterLink to="/admin/stats">访问统计（内部）</RouterLink>
      </div>
    </div>

    <div class="zw-container foot-bottom">
      <span>© {{ new Date().getFullYear() }} 六尺巷基金会 · 零废弃知识库</span>
      <span class="foot-note">
        本站资料均为公开出版物或公开研究报告的收录与索引，权利归原作者与发布机构所有；
        引用请注明原始出处。发现问题欢迎用「意见反馈」告诉我们。
      </span>
    </div>

    <!-- 意见反馈（R12）：站内表单，匿名可提交，走已有埋点通道落库，不新增接口 -->
    <el-dialog
      v-model="feedbackOpen"
      title="意见反馈"
      width="min(460px, 92vw)"
      @closed="onFeedbackClosed"
    >
      <p class="fb-tip">
        资料纠错、资料推荐、功能建议，或者 AI 答得不对，都可以写在这里。
        我们会在后续更新中处理；需要回复请留下联系方式（选填）。
      </p>

      <el-select v-model="feedbackKind" class="fb-kind">
        <el-option v-for="k in FEEDBACK_KINDS" :key="k" :label="k" :value="k" />
      </el-select>

      <el-input
        v-model="feedbackText"
        type="textarea"
        :rows="5"
        :maxlength="FEEDBACK_MAX_CHARS"
        show-word-limit
        placeholder="请描述你遇到的问题或建议…"
      />

      <template #footer>
        <el-button @click="feedbackOpen = false">取消</el-button>
        <el-button type="primary" :loading="feedbackBusy" @click="submitFeedback">提交</el-button>
      </template>
    </el-dialog>
  </footer>
</template>

<style scoped>
.site-footer {
  margin-top: 48px;
  padding: 40px 0 24px;
  background: #fff;
  border-top: 1px solid var(--zw-line);
}

.foot-grid {
  display: grid;
  grid-template-columns: 1.6fr 1fr 1fr 1fr;
  gap: 28px;
}

.foot-brand h3 {
  margin: 0 0 10px;
  font-size: 18px;
  color: var(--zw-green-deep);
}

.foot-brand p {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--zw-muted);
  max-width: 34em;
}

.foot-stat {
  color: var(--zw-text);
}

.foot-stat strong {
  color: var(--zw-green);
  font-size: 18px;
  margin: 0 3px;
}

.foot-col {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.foot-col h4 {
  margin: 0 0 3px;
  font-size: 13px;
  color: var(--zw-ink);
  letter-spacing: 0.06em;
}

.foot-col a {
  font-size: 13px;
  color: var(--zw-muted);
  text-decoration: none;
}

.foot-col a:hover {
  color: var(--zw-green-deep);
  text-decoration: underline;
}

/* 意见反馈入口：和旁边三个链接长得一样（同一列里视觉要齐），只是行为是开弹窗而非跳路由 */
.foot-link {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--zw-muted);
  text-align: left;
  cursor: pointer;
}

.foot-link:hover {
  color: var(--zw-green-deep);
  text-decoration: underline;
}

.fb-tip {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--zw-muted);
}

.fb-kind {
  width: 100%;
  margin-bottom: 12px;
}

.foot-admin {
  opacity: 0.75;
}

.foot-bottom {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: baseline;
  justify-content: space-between;
  margin-top: 32px;
  padding-top: 16px;
  border-top: 1px dashed var(--zw-line);
  font-size: 12px;
  color: var(--zw-faint);
}

.foot-note {
  max-width: 56em;
  line-height: 1.7;
}

@media (max-width: 860px) {
  .foot-grid {
    grid-template-columns: 1fr 1fr;
  }

  .foot-brand {
    grid-column: 1 / -1;
  }
}

@media (max-width: 480px) {
  .foot-grid {
    grid-template-columns: 1fr;
  }
}
</style>
