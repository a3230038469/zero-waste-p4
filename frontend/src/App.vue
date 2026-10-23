<script setup lang="ts">
/**
 * 根组件 —— 结构：氛围层 + 顶部导航 + 路由出口 + 页脚
 *
 * 分层说明（决定鼠标光效能不能看到、会不会挡住操作）：
 *   MouseGlow 是 position:fixed + z-index:0 的装饰层，整层 pointer-events:none；
 *   .app-shell 抬到 z-index:1，于是「光在内容之下、内容照常可点」。
 *   页面底不能是不透明背景，否则光被盖住 —— 各页面因此都用卡片承载内容、页面本身留白。
 *
 * 2026-10-19（用户要求）：问答页改成**全屏工作区**——铺满窗口、不再套在
 *   `.app-main` 的 1160px 容器里（那个容器给的左右留白 + 页面自己的圆角卡片
 *   叠在一起，就是「框里还有一个框」的来源），并且这一页不渲染页脚。
 *   做法：只对全屏页加一个 `is-flush` 修饰类，**不改 .app-main 的默认样式**，
 *   所以其它页面的留白、边框、页脚一律照旧。
 *   同一天做管理台（`/admin/*`）时按同一套处理：管理台也是全屏工作区，
 *   左侧导航自己一栏、内容区自己滚动。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import MouseGlow from './components/MouseGlow.vue'
import SiteNav from './components/SiteNav.vue'
import SiteFooter from './components/SiteFooter.vue'

const route = useRoute()

/** 全屏页：AI 问答页与管理台（它们自己管滚动，不能再被外层容器包一层） */
const isFullBleed = computed(
  () => route.path.startsWith('/chat') || route.path.startsWith('/admin')
)

/**
 * 管理台：连**公众顶部导航**也不渲染。
 * 理由：管理台左侧已经有一栏自己的导航（含「← 返回网站」「退出登录」），
 * 顶上再压一条公众导航就成了「两套导航打架」，页头也被顶掉 65px。
 * 只影响 /admin/*，公众页面一律照旧。
 */
const isConsole = computed(() => route.path.startsWith('/admin'))
</script>

<template>
  <MouseGlow />
  <div class="app-shell">
    <SiteNav v-if="!isConsole" />
    <main class="app-main" :class="{ 'is-flush': isFullBleed, 'is-console': isConsole }">
      <RouterView v-slot="{ Component }">
        <transition name="fade-slide" mode="out-in">
          <component :is="Component" />
        </transition>
      </RouterView>
    </main>
    <SiteFooter v-if="!isFullBleed" />
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

/**
 * 全屏页（问答页）：去掉容器宽度上限与四周留白，高度只留顶部导航那 77px
 * （76px 内容高 + 1px 下边线；手机端顶栏是 65px，见下面的 @media），
 * 剩下的全部交给页面自己铺满。
 * 这里给的是**确定高度**，页面内就可以用 `height: 100%` 拿到它 ——
 * 比页面自己再算一次 `100vh` 稳（各页导航高度一旦变，只需改这一处）。
 * dvh 是移动端地址栏收放时更准的视口高度，不支持的浏览器退回 vh。
 */
.app-main.is-flush {
  /* flex:1 的 flex-basis 是 0%，在主轴上会盖掉下面的 height ——
     这里必须退回 auto，height 才算数（踩过：页面被内容撑高、整页能滚） */
  flex: 0 0 auto;
  max-width: none;
  margin: 0;
  padding: 0;
  height: calc(100vh - 77px);
  height: calc(100dvh - 77px);
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 手机端顶栏换回 64px 紧凑版 logo，全屏页要把高度让回来 */
@media (max-width: 720px) {
  .app-main.is-flush {
    height: calc(100vh - 65px);
    height: calc(100dvh - 65px);
  }
}

/* 管理台没有公众顶部导航，整屏高度全给控制台 */
.app-main.is-console {
  height: 100vh;
  height: 100dvh;
}

@media (max-width: 640px) {
  .app-main {
    padding: 20px 14px 32px;
  }

  /* 全屏页在手机上也一样：不留边、不设上限 */
  .app-main.is-flush {
    padding: 0;
  }
}
</style>
