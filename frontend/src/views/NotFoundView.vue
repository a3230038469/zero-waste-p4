<template>
  <!-- QA-404：404 是全站被丢最多的传播页，不能只是一个 el-result 灰面板。
       带站内三去向（首页/书架/问 AI）+ 品牌落款，走失的读者还有路可走。 -->
  <div class="nf">
    <p class="nf-code zw-num">404</p>
    <h1 class="nf-title">页面不存在</h1>
    <p class="nf-lead">请检查网址是否正确，或者从这里回到该去的地方：</p>
    <div class="nf-actions">
      <RouterLink to="/" class="nf-btn nf-btn--primary">回到首页</RouterLink>
      <RouterLink to="/shelf" class="nf-btn">浏览资料库</RouterLink>
      <RouterLink to="/chat" class="nf-btn nf-btn--soft">问 AI</RouterLink>
    </div>
    <p class="nf-brand">零废弃知识库 · 六尺巷基金会</p>
  </div>
</template>

<style scoped>
.nf {
  max-width: 560px;
  margin: 0 auto;
  padding: 72px 24px 96px;
  text-align: center;
}

.nf-code {
  margin: 0;
  font-size: 64px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--zw-green-soft);
}

.nf-title {
  margin: 12px 0 8px;
  font-size: 24px;
  color: var(--zw-ink);
}

.nf-lead {
  margin: 0 0 24px;
  font-size: 14px;
  line-height: 1.8;
  color: var(--zw-muted);
}

.nf-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
}

.nf-btn {
  display: inline-flex;
  align-items: center;
  min-height: 44px; /* 热区标准 */
  padding: 0 22px;
  border: 1px solid var(--zw-green);
  border-radius: 999px;
  background: var(--zw-green);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  transition: background 0.16s ease, border-color 0.16s ease;
}

.nf-btn:hover {
  background: var(--zw-green-deep);
  border-color: var(--zw-green-deep);
}

.nf-btn--soft {
  border-color: var(--zw-green-soft);
  background: var(--zw-mint);
  color: var(--zw-green-deep);
}

.nf-btn--soft:hover {
  background: var(--zw-mint-2);
  border-color: var(--zw-green);
}

.nf-btn:focus-visible {
  outline: 2px solid var(--zw-green-deep);
  outline-offset: 2px;
}

.nf-brand {
  margin: 40px 0 0;
  font-size: 12px;
  color: var(--zw-muted);
  letter-spacing: 0.08em;
}
</style>
