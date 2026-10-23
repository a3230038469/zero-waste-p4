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
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { useAuth } from '../../composables/useAuth'
import { runSelfcheck, type SelfcheckItem } from '../../api/admin'

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
  { to: 'adminModels', label: '模型管理', hint: '密钥、增删与测试' },
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

/* --------------------------------------------------------------
 * 常驻健康状态条（2026-10-21 新增）
 *
 * 之前「引擎没起」「向量服务没启动」只有去「系统设置」页点「开始自检」才看得到，
 * 平时在别的后台页操作时出了问题只能靠猜。现在外壳顶部常驻一条：
 * 四项（知识库引擎 / 云解析 / 向量服务 / 数据库）各一颗小圆点，绿=通过、红=未通过，
 * 点「重新检查」就能刷新。读的就是设置页那同一个 POST /api/admin/selfcheck。
 * ------------------------------------------------------------------ */

const healthItems = ref<SelfcheckItem[]>([])
const healthError = ref('')
const healthChecking = ref(false)
/** 全部通过时这条可以收起，别一直占地方 */
const healthAllOk = computed(() => healthItems.value.length > 0 && healthItems.value.every((i) => i.ok))

async function loadHealth(): Promise<void> {
  healthChecking.value = true
  healthError.value = ''
  try {
    const result = await runSelfcheck()
    healthItems.value = result.items ?? []
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: { error?: { message?: string } } } })
      .response
    healthError.value = response?.data?.error?.message ?? '暂时查不到服务状态，请稍后再试。'
    healthItems.value = []
  } finally {
    healthChecking.value = false
  }
}

onMounted(() => {
  // 刷新后直接进 /admin/* 时，守卫已经拉过一次；这里再兜一次，保证底部署名有值
  if (!user.value) void fetchMe()
  void loadHealth()
})

// 换页时顺手刷新一次状态（不同页面对应的服务依赖可能不一样）
watch(
  () => route.name,
  () => {
    void loadHealth()
  }
)
</script>

<template>
  <div class="admin-shell">
    <aside class="admin-rail">
      <RouterLink to="/" class="brand" title="返回网站首页">
        <img src="/logo-mark-nav.svg" alt="" class="brand-logo" width="28" height="28" />
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
      <!-- 常驻健康状态条：引擎 / 解析 / 向量 / 数据库 -->
      <div class="health-bar" :class="{ 'is-bad': healthError || healthItems.some((i) => !i.ok) }">
        <span class="health-title">服务状态</span>
        <span v-if="healthChecking" class="health-text">正在检查…</span>
        <template v-else-if="healthError">
          <span class="health-text">{{ healthError }}</span>
        </template>
        <template v-else-if="healthItems.length">
          <span v-if="healthAllOk" class="health-text">四项全部正常。</span>
          <span v-for="item in healthItems" :key="item.key" class="health-item" :class="item.ok ? 'ok' : 'bad'">
            <span class="dot" aria-hidden="true" />
            <span class="h-label">{{ item.label }}</span>
            <span class="h-state">{{ item.ok ? '正常' : '未通过' }}</span>
            <span v-if="!item.ok && item.message" class="h-msg" :title="item.message">{{ item.message }}</span>
          </span>
        </template>
        <span v-else class="health-text">还没检查过。</span>
        <button type="button" class="health-refresh" :disabled="healthChecking" @click="loadHealth">
          {{ healthChecking ? '检查中…' : '重新检查' }}
        </button>
      </div>

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

/* 2026-10-20：原来的绿色圆角方块换成和公众站同一款圆形 logo 图标。
   28px 是配合右侧「零废弃知识库 / 管理台」两行文字（14px + 11px）的尺寸：
   图标高度略大于两行文字块，视觉上与文字块居中对齐。 */
.brand-logo {
  display: block;
  width: 28px;
  height: 28px;
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

/* ---- health bar ---- */
.health-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin: -8px 0 16px;
  padding: 8px 12px;
  border: 1px solid var(--zw-line);
  border-radius: 10px;
  background: #fff;
  font-size: 12.5px;
  color: var(--zw-muted);
}
.health-bar.is-bad {
  border-color: #f0c9c2;
  background: #fdf6f4;
}
.health-title {
  font-weight: 600;
  color: var(--zw-ink);
}
.health-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.health-item .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--zw-line-strong);
  flex: 0 0 auto;
}
.health-item.ok .dot {
  background: var(--zw-green);
}
.health-item.bad .dot {
  background: #d0493b;
}
.health-item.bad .h-label,
.health-item.bad .h-state {
  color: #c0392b;
}
.h-state {
  color: var(--zw-faint);
}
.h-msg {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #c0392b;
}
.health-text {
  color: var(--zw-muted);
}
.health-refresh {
  margin-left: auto;
  border: 1px solid var(--zw-line);
  border-radius: 6px;
  padding: 2px 10px;
  background: #fff;
  font-size: 12px;
  color: var(--zw-ink);
  cursor: pointer;
}
.health-refresh:disabled {
  opacity: 0.6;
  cursor: default;
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
    flex-wrap: wrap;
    gap: 6px;
    /* 窄屏不再横向滚动：换行摆开，避免最后一项被裁掉半个字（2026-10-22） */
    overflow: visible;
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
