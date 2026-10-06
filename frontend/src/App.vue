<script setup lang="ts">
/**
 * 根组件 —— 负责人：丁梓柔（B04）
 * 结构：顶部导航 + 路由出口
 */
import SiteNav from './components/SiteNav.vue'
</script>

<template>
  <div class="app-shell">
    <SiteNav />
    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>

<style>
:root {
  /* 零废弃主题：绿色系基调，可调整 */
  --zw-green: #2e7d32;
  --zw-green-light: #66bb6a;
  --zw-bg: #f7faf7;
  --zw-text: #1f2d1f;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, -apple-system, sans-serif;
  color: var(--zw-text);
  background: var(--zw-bg);
}

.app-main {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 16px;
}
</style>
