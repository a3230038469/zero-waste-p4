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
 */
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'

const router = useRouter()
const { user, isLoggedIn, fetchMe, logout } = useAuth()

/**
 * 导航项。`/chat` 是 T5 的 AI 问答独立页（带会话历史，可接着聊）。
 *
 * 顺序（2026-10-12 按需求调整）：关于项目 → 首页 → 资料库 → 数据概览 → AI 问答。
 * ⚠️ 只调了本数组的排列顺序，样式、hover、高亮逻辑、Logo、登录态一律未动。
 */
const NAV = [
  { to: '/about', label: '关于项目', exact: false },
  { to: '/', label: '首页', exact: true },
  { to: '/shelf', label: '资料库', exact: false },
  { to: '/insights', label: '数据概览', exact: false },
  { to: '/chat', label: 'AI 问答', exact: false }
]

function onLogout(): void {
  logout()
  void router.push('/')
}

onMounted(() => {
  void fetchMe()
})
</script>

<template>
  <header class="site-nav">
    <div class="zw-container inner">
      <RouterLink to="/" class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M12 21c5-2.5 8-6.6 8-11V5.8L12 3 4 5.8V10c0 4.4 3 8.5 8 11Z" stroke-linejoin="round" />
            <path d="M9.2 12.2l2.1 2.1 3.9-4.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
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
          :class="{ 'is-current': item.exact ? $route.path === item.to : $route.path.startsWith(item.to) }"
        >
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="auth-slot">
        <template v-if="user">
          <span class="greeting">{{ user.name }}，你好</span>
          <button type="button" class="text-btn" @click="onLogout">退出</button>
        </template>
        <template v-else-if="isLoggedIn">
          <span class="greeting">已登录</span>
          <button type="button" class="text-btn" @click="onLogout">退出</button>
        </template>
        <RouterLink v-else to="/auth" class="login-link">登录 / 注册</RouterLink>
      </div>
    </div>
  </header>
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
  color: #fff;
  background: linear-gradient(140deg, var(--zw-green), var(--zw-green-deep));
  box-shadow: 0 4px 12px rgba(46, 125, 50, 0.28);
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

.links {
  display: flex;
  gap: 4px;
  margin-left: 12px;
}

.nav-link {
  position: relative;
  padding: 8px 14px;
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

.auth-slot {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  white-space: nowrap;
}

.greeting {
  color: var(--zw-muted);
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

.text-btn {
  border: 0;
  background: none;
  padding: 4px 2px;
  font: inherit;
  font-size: 14px;
  color: var(--zw-muted);
  cursor: pointer;
}

.text-btn:hover {
  color: var(--zw-green-deep);
  text-decoration: underline;
}

/* 窄屏：品牌与登录态一行，导航换到第二行横向可滚，不挤压、不换行成柱状 */
@media (max-width: 720px) {
  .inner {
    flex-wrap: wrap;
    row-gap: 4px;
    padding-top: 8px;
    padding-bottom: 8px;
    min-height: 0;
  }

  .brand-text em {
    display: none;
  }

  .links {
    order: 3;
    flex-basis: 100%;
    margin-left: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .links::-webkit-scrollbar {
    display: none;
  }

  .nav-link {
    padding: 6px 12px;
    font-size: 14px;
  }
}
</style>
