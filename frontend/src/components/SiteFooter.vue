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
 *
 * 2026-10-12（B09）：补「意见反馈」入口——页脚是访客找不到路时的最后一站，
 * 站点级反馈放这里最合适；弹窗与资料详情页共用同一组件。
 */
import { onMounted, ref } from 'vue'
import { getOverview } from '../api/overview'
import { formatCount } from '../utils/format'
import FeedbackDialog from './FeedbackDialog.vue'

const total = ref<number | null>(null)
/** 站点级反馈弹窗 */
const feedbackVisible = ref(false)

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
        <button type="button" class="foot-link-btn" @click="feedbackVisible = true">意见反馈</button>
        <RouterLink to="/about#contact">联系与共建</RouterLink>
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
        引用请注明原始出处。
      </span>
    </div>

    <!-- 站点级反馈：与资料详情页的资料级反馈共用同一个弹窗组件（B09） -->
    <FeedbackDialog v-model="feedbackVisible" scope="site" />
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

/* 「意见反馈」是按钮不是链接（点了开弹窗），样式上要跟同列的链接长得一样 */
.foot-link-btn {
  border: 0;
  background: none;
  padding: 0;
  text-align: left;
  font: inherit;
  font-size: 13px;
  color: var(--zw-muted);
  cursor: pointer;
}

.foot-link-btn:hover {
  color: var(--zw-green-deep);
  text-decoration: underline;
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
