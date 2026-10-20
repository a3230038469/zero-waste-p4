<script setup lang="ts">
/**
 * 404 页 —— 视觉系统接入（月月 · 2026-10-13）
 *
 * 原版只有一个裸的 el-result，没有版心、没有站内导航出口。
 * 现在按空态规范（zw-empty）重排：图标 + 一句人话 + 两个出口（回首页 / 去资料库）。
 */
</script>

<template>
  <div class="zw-container notfound">
    <div class="zw-empty notfound__panel">
      <span class="notfound__code zw-num" aria-hidden="true">404</span>
      <p class="zw-empty__title">页面不存在</p>
      <p class="zw-empty__desc">地址可能输错了，或者这个页面已经移动。下面两个入口都能继续逛：</p>
      <div class="notfound__actions">
        <RouterLink to="/" class="zw-link">回到首页</RouterLink>
        <RouterLink to="/shelf" class="zw-link">去资料库</RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notfound {
  padding-top: var(--zw-space-9);
  padding-bottom: var(--zw-space-10);
}

.notfound__panel {
  max-width: 620px;
  margin-inline: auto;
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  background: var(--zw-surface);
  box-shadow: var(--zw-shadow-sm);
}

.notfound__code {
  font-size: var(--zw-fs-display);
  font-weight: 700;
  line-height: 1;
  color: var(--zw-green-soft);
  letter-spacing: 0.04em;
}

.notfound__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--zw-space-6);
  margin-top: var(--zw-space-2);
}

.notfound__actions .zw-link {
  font-size: var(--zw-fs-body);
}
</style>
