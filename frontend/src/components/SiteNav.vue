<script setup lang="ts">
/**
 * 顶部导航 —— 对外展示站版（2026-10-10 改版）
 *
 * 改动要点：
 *   1. 导航项从「首页 / 书架」扩到四页：首页 / 资料库 / 数据概览 / 关于项目。
 *      对外展示站要让访问者一眼看懂「这里有什么」，「书架」这种内部叫法改成「资料库」。
 *   2. 深绿实心条 → 半透明磨砂条：内容才是主角，导航不该压住页面。
 *   3. 补上**退出登录**。此前登录成功后没有任何退出入口，注册过的用户只能清浏览器缓存 ——
 *      这在一个对外开的站点上是硬伤。
 *   4. 「管理」入口从导航条移到页脚（见 SiteFooter）：公众站不该把内部后台摆在主航道上，
 *      但仍留在页脚让老师找得到。
 *   5. 2026-10-13（B09）：新增「我要投稿」（/contribute）。只加一个导航项与一行注释，
 *      不动其余导航项的顺序与高亮逻辑。
 *   6. 2026-10-15（T13b）：「关于项目」提到第一位；品牌 Logo 换成 zero-logo.png。
 *      只动了 NAV 的排列顺序与 Logo，样式、hover、高亮、登录态一律未动。
 *   7. 2026-10-18（task-5，按 docs/前端改版方案-2026-10-18.md §4.2 / §4.3）：
 *      桌面 6 项 → 5 项：「首页」撤掉（回首页改由左侧 Logo 承担，补 title 与 aria-label）；
 *      顺序改为「资料库 → AI 问答 → 我要投稿 → 数据概览 → 关于项目」，核心两项置前；
 *      「AI 问答」加默认态可见的小圆点标记；项间距统一到 32px（相邻两项文字间留白 12+8+12）。
 *      手机端（≤720px）：顶栏只留 Logo + 汉堡 + 登录/注册，次要三项收进汉堡菜单；
 *      两个核心功能放**底部常驻操作条**（左「找资料」→ /shelf，右「问 AI」→ /chat），
 *      并给 body 留 72px 安全区；原来「导航换第二行横向滚动」的样式一并删掉。
 *      ⚠️ 本次只动「排版与文字」：颜色令牌一个没改，MouseGlow 一个数值没碰。
 *   8. 2026-10-18（task-6，用户当日口述）：第二轮改版，导航回到 4 项
 *      「首页 → 资料库 → AI 问答 → 我要投稿」。
 *      - 「首页」加回来（task-5 撤掉它的理由是「Logo 就能回首页」，用户明确要求导航里看得见）。
 *        它用 `exact: true`：只有路径恰好是 `/` 才高亮，否则首页会在每一页都亮着。
 *      - 「数据概览」「关于项目」两项撤掉：两个页面整页并进首页（关于项目的内容搬到首页
 *        分隔线以下，统计收成一张「按主题领域」的分布图），页面文件与路由一并删除。
 *      - 手机端汉堡菜单因此只剩「首页 / 我要投稿」两项；底部常驻条（找资料 / 问 AI）不变。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import AccountMenu from './AccountMenu.vue'

const router = useRouter()
const route = useRoute()
const { user, isLoggedIn, fetchMe, logout } = useAuth()

/**
 * 全屏工作区（2026-10-19）：问答页与管理台都铺满窗口、自己管滚动，
 * 底部的常驻操作条与给它留的 72px 安全区在这两类页面上是多余的
 * （用户明确要求删掉问答页底部导航；管理台是操作台，同样不该压一条公众导航）。
 * 只按路径判断、只在这些页面隐藏，其它页面的底部条与 body 安全区保持原样。
 */
const atFullBleed = computed(
  () => route.path.startsWith('/chat') || route.path.startsWith('/admin')
)
watch(
  atFullBleed,
  (on) => document.body.classList.toggle('zw-no-mobile-bar', on),
  { immediate: true }
)

/** 手机端汉堡菜单是否展开（桌面端不显示汉堡，此值恒为 false） */
const menuOpen = ref(false)

function toggleMenu(): void {
  menuOpen.value = !menuOpen.value
}

/** 点完菜单项就收起菜单（含点「登录 / 注册」跳走的情况） */
function closeMenu(): void {
  menuOpen.value = false
}

/**
 * 两个「核心功能」的路径：桌面端排最前，手机端放底部常驻条 —— 都不许藏进汉堡。
 * 抽成常量是为了让下面的 MENU 从 NAV 派生，避免菜单里再手抄一份导航项。
 */
const CORE_PATHS: string[] = ['/shelf', '/chat']

/**
 * 导航项。`/chat` 是 T5 的 AI 问答独立页（带会话历史，可接着聊）。
 *
 * 顺序（2026-10-18 task-6）：首页 → 资料库 → AI 问答 → 我要投稿。
 * 「首页」回到第一位，`exact: true` 限定它只在 `/` 高亮；
 * `dot: true` 只给「AI 问答」，用于默认态就能看见的小圆点标记。
 * 「我要投稿」留在末位（B09 起就是公众参与的唯一入口，不该藏进页脚）。
 * ⚠️ 新增导航项时记得同步 SiteFooter 的「浏览」列 —— 两处顺序此前是对齐的。
 */
const NAV = [
  { to: '/', label: '首页', exact: true, dot: false },
  { to: '/shelf', label: '资料库', exact: false, dot: false },
  { to: '/chat', label: 'AI 问答', exact: false, dot: true },
  { to: '/contribute', label: '我要投稿', exact: false, dot: false }
]

/** 汉堡菜单项（手机端）：从 NAV 剔除两个核心功能，只留次要两项 */
const MENU = NAV.filter((item) => !CORE_PATHS.includes(item.to))

function onLogout(): void {
  logout()
  menuOpen.value = false
  void router.push('/')
}

onMounted(() => {
  void fetchMe()
})
</script>

<template>
  <header class="site-nav">
    <div class="zw-container inner">
      <!-- 回首页改由 Logo 承担：悬停给 title 提示，读屏给 aria-label -->
      <RouterLink to="/" class="brand" title="回到首页" aria-label="回到首页">
        <span class="brand-mark" aria-hidden="true">
          <img src="/zero-logo.png" alt="" class="brand-logo-img" width="32" height="32" />
        </span>
        <span class="brand-text">
          <strong>零废弃知识库</strong>
          <em>六尺巷基金会</em>
        </span>
      </RouterLink>

      <nav class="links" aria-label="主导航">
        <RouterLink
          v-for="item in NAV"
          :key="item.to"
          :to="item.to"
          class="nav-link"
          :class="{
            'is-current': item.exact ? $route.path === item.to : $route.path.startsWith(item.to),
            'has-dot': item.dot
          }"
        >
          {{ item.label }}
        </RouterLink>
      </nav>

      <!-- 手机端（≤720px）汉堡：只放次要三项 + 登录/注册；
           两个核心功能在底部常驻条上，不藏这里 -->
      <button
        type="button"
        class="hamburger"
        :aria-expanded="menuOpen"
        aria-controls="mobile-menu"
        aria-label="导航菜单"
        @click="toggleMenu"
      >
        <span class="hamburger-bar" aria-hidden="true"></span>
        <span class="hamburger-bar" aria-hidden="true"></span>
        <span class="hamburger-bar" aria-hidden="true"></span>
      </button>

      <div class="auth-slot">
        <!-- 已登录：头像 + 名字 → 下拉账号菜单（个人资料 / 我的投稿 / 意见反馈 / 退出登录）
             见 AccountMenu.vue；这里只留一行，导航组件不再堆登录态逻辑 -->
        <AccountMenu v-if="isLoggedIn" />
        <RouterLink v-else to="/auth" class="login-link">登录 / 注册</RouterLink>
      </div>
    </div>

    <!-- 汉堡展开的抽屉（≤720px 才可能打开） -->
    <nav v-if="menuOpen" id="mobile-menu" class="mobile-menu" aria-label="更多导航">
      <RouterLink
        v-for="item in MENU"
        :key="item.to"
        :to="item.to"
        class="mobile-link"
        @click="closeMenu"
      >
        {{ item.label }}
      </RouterLink>
      <button v-if="user || isLoggedIn" type="button" class="mobile-link" @click="onLogout">
        退出登录
      </button>
      <RouterLink v-else to="/auth" class="mobile-link" @click="closeMenu">登录 / 注册</RouterLink>
    </nav>
  </header>

  <!-- 手机端底部常驻操作条：两个核心功能各占一半，任何滚动位置都在。
       必须放在 header **外面**：.site-nav 带 backdrop-filter，会给 fixed 子元素当定位基准，
       留在里面 bottom:0 会贴到导航条底边而不是视口底边。 -->
  <nav v-if="!atFullBleed" class="mobile-bar" aria-label="核心功能">
    <RouterLink to="/shelf" class="bar-btn bar-shelf">找资料</RouterLink>
    <RouterLink to="/chat" class="bar-btn bar-chat">问 AI</RouterLink>
  </nav>
</template>

<style scoped>
.site-nav {
  position: sticky;
  top: 0;
  z-index: 100;
  background: rgba(255, 255, 255, 0.82);
  backdrop-filter: saturate(1.4) blur(12px);
  border-bottom: 1px solid var(--zw-line);
}

.inner {
  display: flex;
  align-items: center;
  gap: 20px;
  min-height: 64px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: var(--zw-ink);
  flex-shrink: 0;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  overflow: hidden;
}

.brand-mark img {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.brand-text strong {
  font-size: 16px;
  letter-spacing: 0.01em;
}

.brand-text em {
  font-style: normal;
  font-size: 11px;
  color: var(--zw-muted);
  letter-spacing: 0.08em;
}

/* 桌面项间距统一 32px：左项右内边距 12 + 项间 8 + 右项左内边距 12 = 相邻两项文字间空白 32px。
   （药丸底之间留 8px，不会两项粘成一块。） */
.links {
  display: flex;
  gap: 8px;
  margin-left: 12px;
}

.nav-link {
  position: relative;
  padding: 8px 12px;
  border-radius: 999px;
  font-size: 15px;
  color: var(--zw-text);
  text-decoration: none;
  transition:
    color 0.18s ease,
    background 0.18s ease;
}

.nav-link:hover {
  color: var(--zw-green-deep);
  background: var(--zw-mint-2);
}

.nav-link.is-current {
  color: var(--zw-green-deep);
  font-weight: 600;
  background: var(--zw-mint);
}

/* 「AI 问答」的默认态视觉标记：标签左侧一个小圆点（不依赖 hover / 选中态） */
.nav-link.has-dot::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  vertical-align: middle;
  border-radius: 50%;
  background: var(--zw-green);
}

/* 汉堡按钮：只在手机端出现（桌面端 display: none） */
.hamburger {
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--zw-ink);
  cursor: pointer;
}

.hamburger-bar {
  display: block;
  width: 18px;
  height: 2px;
  border-radius: 1px;
  background: currentColor;
}

/* 汉堡展开的抽屉：贴在导航条下沿（header 是 sticky，绝对定位以它为基准） */
.mobile-menu {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 120;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 20px 14px;
  background: var(--zw-surface);
  border-bottom: 1px solid var(--zw-line);
  box-shadow: var(--zw-shadow);
}

.mobile-link {
  padding: 11px 4px;
  border: 0;
  border-radius: 8px;
  background: none;
  font: inherit;
  font-size: 15px;
  color: var(--zw-text);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

.mobile-link:hover {
  color: var(--zw-green-deep);
  background: var(--zw-mint-2);
}

/* 底部常驻操作条：桌面端不出现（手机端在下面的 @media 里打开） */
.mobile-bar {
  display: none;
}

.auth-slot {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  white-space: nowrap;
}

.login-link {
  color: var(--zw-green-deep);
  text-decoration: none;
  font-weight: 600;
  padding: 7px 16px;
  border: 1px solid var(--zw-line-strong);
  border-radius: 999px;
  background: #fff;
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}

.login-link:hover {
  border-color: var(--zw-green);
  box-shadow: 0 4px 14px rgba(46, 125, 50, 0.14);
}

/* 手机端（≤720px）：顶栏只留 Logo + 汉堡 + 登录/注册。
   主导航不再换到第二行横滚（旧样式已删）：次要三项进汉堡抽屉，
   两个核心功能常驻底部操作条，任何滚动位置都能一步点到。 */
@media (max-width: 720px) {
  .inner {
    flex-wrap: nowrap;
    gap: 10px;
  }

  /* 副标题「六尺巷基金会」窄屏隐去，顶栏保持单行 64px */
  .brand-text em {
    display: none;
  }

  /* 整条主导航隐藏：核心两项在底部条上，次要三项在汉堡里 */
  .links {
    display: none;
  }

  .hamburger {
    display: flex;
    margin-left: auto;
  }

  .auth-slot {
    margin-left: 12px;
    gap: 8px;
  }

  /* 底部常驻操作条：50px 内容高 + iOS 安全区 padding */
  .mobile-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 90;
    display: flex;
    height: calc(50px + env(safe-area-inset-bottom, 0px));
    padding-bottom: env(safe-area-inset-bottom, 0px);
    box-shadow: var(--zw-shadow);
  }

  .bar-btn {
    flex: 1 1 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    font-weight: 600;
    text-decoration: none;
  }

  /* 左「找资料」：深绿实心（两色都用既有令牌，没新造色值） */
  .bar-shelf {
    background: var(--zw-green-deep);
    color: var(--zw-surface);
  }

  /* 右「问 AI」：浅绿 */
  .bar-chat {
    background: var(--zw-mint);
    color: var(--zw-green-deep);
  }
}

/* 兜底：在手机上打开抽屉后把窗口拉大，别让抽屉挂在大屏导航条下面 */
@media (min-width: 721px) {
  .mobile-menu {
    display: none;
  }
}
</style>

<style>
/* 底部操作条会盖住页面最后 50px（+ 安全区），给 body 留出安全区。
   必须是非 scoped：body 在本组件之外。与上方 .mobile-bar 的断点保持一致。
   ⚠️ 全屏页（问答页）不渲染这条操作条，它的 body 安全区也要一起去掉，
   否则页尾会多出一条 72px 的空白可滚区。 */
@media (max-width: 720px) {
  body {
    padding-bottom: 72px;
  }

  body.zw-no-mobile-bar {
    padding-bottom: 0;
  }
}
</style>
