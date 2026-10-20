<script setup lang="ts">
/**
 * 管理台外壳 —— 2026-10-19 新增（管理台改造）
 *
 * 为什么要有这一层：
 *   改造前六个后台页面各自渲染一段**一模一样**的横向导航与口令输入框，
 *   口令取消后那些块就成了死代码，而且每加一个页面就要再抄一遍导航。
 *   收成一个父级布局后：导航只有这一份，子页面只管自己的内容。
 *
 * 结构：
 *   左侧 248px 竖栏 = 品牌行 → 导航（7 项，带一句中文说明）→ 底部账号区（返回网站 / 退出）
 *   右侧内容区 = 子页面（`<RouterView />`），自己滚动，页宽上限 1160px 居中
 *
 * 视觉口径（与全站一致，没有新造色）：
 *   栏底 `--zw-mint-2` + 1px 发丝线；当前项 = 白卡 + 绿字 + 左侧 3px 绿条；
 *   圆角只用 `--zw-radius-sm` / `--zw-radius`；强调色只用 `--zw-green*`。
 *
 * 手机上（≤900px）：竖栏折成顶部一条横向可滑的导航带，内容区接在下面。
 *
 * ⚠️ 权限：这里只决定「入口给不给看」。真正的拦截在后端每个 /api/admin/* 上，
 *    路由守卫（router/index.ts 的 beforeEach）负责把非管理员挡到登录页。
 */
import { computed, onMounted } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { useAuth } from '../../composables/useAuth'

const route = useRoute()
const router = useRouter()
const { user, fetchMe, logout } = useAuth()

/** 导航表：to 用命名路由，避免手写路径拼错；hint 是给「第一次进后台的人」看的一句人话 */
const NAV = [
  { to: 'adminKnowledge', label: '资料管理', hint: '上传、删除、重新解析' },
  { to: 'adminContributions', label: '投稿审核', hint: '公众投稿的入库队列' },
  { to: 'adminSite', label: '机构信息', hint: '联系方式与合作口径' },
  { to: 'adminUsers', label: '注册用户', hint: '谁在用这个站' },
  { to: 'adminFeedback', label: '访客反馈', hint: '意见与纠错' },
  { to: 'adminStats', label: '数据看板', hint: '访问与使用明细' },
  { to: 'adminSettings', label: '系统设置', hint: '问答、解析与游客权限' }
] as const

/** 头像首字：与站内账号菜单同一套取法 */
const initial = computed(() => (user.value?.name?.trim()?.[0] ?? '管').toUpperCase())

/** 导航高亮：命名路由相同才算当前项（子路由不会误亮父项） */
function isActive(name: string): boolean {
  return route.name === name
}

function onLogout(): void {
  logout()
  void router.push('/')
}

onMounted(() => {
  // 刷新后直接进 /admin/* 时，守卫已经拉过一次；这里再兜一次，保证底部署名有值
  if (!user.value) void fetchMe()
})
</script>

<template>
  <div class="admin-shell">
    <aside class="admin-rail">
      <RouterLink to="/" class="brand" title="返回网站首页">
        <span class="brand-dot" aria-hidden="true"></span>
        <span class="brand-text">
          <strong>零废弃知识库</strong>
          <em>管理台</em>
        </span>
      </RouterLink>

      <nav class="admin-nav" aria-label="管理台导航">
        <RouterLink
          v-for="item in NAV"
          :key="item.to"
          :to="{ name: item.to }"
          class="nav-item"
          :class="{ 'is-on': isActive(item.to) }"
          :aria-current="isActive(item.to) ? 'page' : undefined"
        >
          <span class="nav-label">{{ item.label }}</span>
          <span class="nav-hint">{{ item.hint }}</span>
        </RouterLink>
      </nav>

      <div class="rail-foot">
        <RouterLink to="/" class="foot-link">← 返回网站</RouterLink>
        <div class="who">
          <span class="who-avatar" aria-hidden="true">{{ initial }}</span>
          <span class="who-text">
            <strong>{{ user?.name ?? '管理员' }}</strong>
            <em>管理员</em>
          </span>
        </div>
        <button type="button" class="foot-link foot-link--danger" @click="onLogout">退出登录</button>
      </div>
    </aside>

    <main class="admin-main">
      <!-- 页面标题由各页自己渲染（它们的页头里还挂着统计行与上传/导出按钮，
           外壳再写一遍标题就会重复；这里只负责「导航 + 内容区」两件事）。 -->
      <div class="admin-body">
        <RouterView />
      </div>
    </main>
  </div>
</template>

<style scoped>
/* 整块铺满：高度由 `.app-main.is-flush` 给（见 App.vue），这里只负责分栏 */
.admin-shell {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  background: var(--zw-bg);
}

/* ---- 左：导航栏 ---- */
.admin-rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 14px 12px 12px;
  background: var(--zw-mint-2);
  border-right: 1px solid var(--zw-line);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px 14px;
  text-decoration: none;
}

.brand-dot {
  width: 26px;
  height: 26px;
  border-radius: 9px;
  background: linear-gradient(150deg, var(--zw-green), var(--zw-green-light));
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.5);
  flex-shrink: 0;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  min-width: 0;
}

.brand-text strong {
  font-size: 14px;
  font-weight: 700;
  color: var(--zw-green-ink);
}

.brand-text em {
  font-style: normal;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--zw-muted);
}

.admin-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
}

.nav-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 9px 12px;
  border-radius: var(--zw-radius-sm);
  border-left: 3px solid transparent;
  text-decoration: none;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}

.nav-label {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--zw-text);
}

.nav-hint {
  font-size: 11.5px;
  color: var(--zw-faint);
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.7);
}

/* 当前项：白卡 + 左绿条 —— 一眼看出「我在哪一页」 */
.nav-item.is-on {
  background: var(--zw-surface);
  border-left-color: var(--zw-green);
  box-shadow: var(--zw-shadow-sm);
}

.nav-item.is-on .nav-label {
  color: var(--zw-green-deep);
}

.nav-item.is-on .nav-hint {
  color: var(--zw-muted);
}

.rail-foot {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--zw-line);
}

.foot-link {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: var(--zw-radius-sm);
  background: none;
  font: inherit;
  font-size: 12.5px;
  color: var(--zw-green-deep);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

.foot-link:hover {
  background: var(--zw-mint);
}

.foot-link--danger {
  color: var(--zw-danger);
}

.foot-link--danger:hover {
  background: #fdeeee;
}

.who {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 4px;
}

.who-avatar {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--zw-green);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.who-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.3;
}

.who-text strong {
  font-size: 12.5px;
  color: var(--zw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.who-text em {
  font-style: normal;
  font-size: 11px;
  color: var(--zw-faint);
}

/* ---- 右：内容区（自己滚动） ---- */
.admin-main {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 22px 30px 44px;
}

.admin-body {
  max-width: 1160px;
  margin: 0 auto;
}

/* ---- 手机 / 窄屏：竖栏折成顶部横向导航带 ---- */
@media (max-width: 900px) {
  .admin-shell {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .admin-rail {
    padding: 10px 12px;
    border-right: 0;
    border-bottom: 1px solid var(--zw-line);
  }

  .brand {
    padding: 2px 4px 10px;
  }

  .admin-nav {
    flex-direction: row;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 2px;
  }

  .nav-item {
    flex: 0 0 auto;
    padding: 7px 12px;
    border-left: 0;
    border: 1px solid var(--zw-line);
    background: var(--zw-surface);
  }

  .nav-hint {
    display: none;
  }

  .rail-foot {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 10px;
  }

  .who {
    margin-left: auto;
    padding: 4px 6px;
  }

  .who-text em {
    display: none;
  }

  .foot-link {
    width: auto;
  }

  .admin-main {
    padding: 16px 14px 32px;
  }
}
</style>
