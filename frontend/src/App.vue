<script setup lang="ts">
/**
 * 根组件 —— 结构：氛围层 + 顶部导航 + 路由出口 + 页脚
 *
 * 分层说明（决定鼠标光效能不能看到、会不会挡住操作）：
 *   MouseGlow 是 position:fixed + z-index:0 的装饰层，整层 pointer-events:none；
 *   .app-shell 抬到 z-index:1，于是「光在内容之下、内容照常可点」。
 *   页面底不能是不透明背景，否则光被盖住 —— 各页面因此都用卡片承载内容、页面本身留白。
 */
import MouseGlow from './components/MouseGlow.vue'
import SiteNav from './components/SiteNav.vue'
import SiteFooter from './components/SiteFooter.vue'
</script>

<template>
  <MouseGlow />
  <div class="app-shell">
    <SiteNav />
    <main class="app-main">
      <RouterView v-slot="{ Component }">
        <transition name="fade-slide" mode="out-in">
          <component :is="Component" />
        </transition>
      </RouterView>
    </main>
    <SiteFooter />
  </div>
</template>

<style scoped>
.app-shell {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-main {
  flex: 1;
  width: 100%;
  max-width: var(--zw-max);
  margin: 0 auto;
  padding: 28px 20px 40px;
}

@media (max-width: 640px) {
  .app-main {
    padding: 20px 14px 32px;
  }
}
</style>
