/**
 * 路由 —— 负责人：丁梓柔（B04）
 * 页面：首页 / 资料库 / 资料详情 / AI 问答 / 我要投稿 / 注册登录 /（管理台）
 *
 * ⚠️ 本文件被多人动过：
 *   - 丁梓柔：B04 四个页面 + 404
 *   - 韶茹：`/admin/stats` 数据看板路由 + 一处 PV 埋点（B03 埋点统计配套，2026-10-07）
 *   - 对外展示站改造（2026-10-10）：曾新增 `/insights` 数据概览、`/about` 关于项目。
 *   - 访客反馈（2026-10-14）：新增 `/admin/feedback` 反馈管理页。
 *   - T5（2026-10-12）：新增 `/chat` AI 问答独立页（会话存数据库，可接着聊）。
 *   - B09（2026-10-13）：新增 `/contribute` 我要投稿 + 意见反馈，
 *     与 `/admin/contributions` 投稿审核队列。
 *   - T10（2026-10-14）：新增 `/admin/settings` 设置页。
 *   - 2026-10-18（task-6）：**删掉 `/insights` 与 `/about` 两条路由**。
 *     用户口述「老页面不要了」：关于项目的内容整页搬进首页分隔线以下，
 *     数据概览收成首页那张「按主题领域」的分布图；对应两个视图文件已删除
 *     （`views/AboutView.vue`、`views/InsightsView.vue`，git 历史里可找回）。
 *     站内旧链接已同步改到首页锚点：页脚 `/#distribution`、`/#cite`、`/#coop`，
 *     资料详情页 `/#cite`。因此**不要再重建这两条路由**，除非同时改回那些链接。
 *   - 2026-10-19（管理台改造，用户口述「把口令去掉、改成管理员体系、机构信息要在
 *     管理台里填、管理台要有入口页」）：
 *     1. 六条 `/admin/*` 收进**一个父路由** `/admin`（组件 `views/admin/AdminLayout.vue`），
 *        于是它们共享同一套左侧导航与页头 —— 以前每个页面各自渲染一段重复的导航。
 *     2. 父路由带 `meta.adminOnly`，下面新增 `beforeEach` 守卫：不是管理员一律
 *        挡到登录页。⚠️ 守卫只是「别让公众看到入口 + 少一次无用请求」，
 *        **真正的权限判断在后端**（每个 /api/admin/* 都会自己查一次账号身份）。
 *     3. 新增 `/admin/site` 机构信息页（填联系方式 / 邮箱 / 地址 / 合作说明 / 版权行，
 *        首页与页脚读它；空串 = 没填，前端继续显示「待补充」，不编内容）。
 */
import { createRouter, createWebHistory } from 'vue-router'

import { trackEvent } from '../api/track'
import { useAuth } from '../composables/useAuth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
    { path: '/shelf', name: 'shelf', component: () => import('../views/ShelfView.vue') },
    // T5：AI 问答独立页（左会话列表 / 右对话流，会话存数据库，可接着聊）
    { path: '/chat', name: 'chat', component: () => import('../views/ChatView.vue') },
    // B09 公众互动（2026-10-13）：我要投稿 + 意见反馈，一个页面两个标签页
    { path: '/contribute', name: 'contribute', component: () => import('../views/ContributeView.vue') },
    { path: '/doc/:id', name: 'doc', component: () => import('../views/DocDetailView.vue') },
    { path: '/auth', name: 'auth', component: () => import('../views/AuthView.vue') },
    {
      // 管理台外壳（2026-10-19）：左侧导航 + 页面出口。
      // 放在父级是刻意的 —— 导航只写一处，六个页面不再各写一遍。
      path: '/admin',
      component: () => import('../views/admin/AdminLayout.vue'),
      meta: { adminOnly: true },
      children: [
        // 直接访问 /admin 时落到「资料管理」，不给一个空壳页面
        { path: '', redirect: { name: 'adminKnowledge' } },
        // 韶茹：数据看板（POST /api/track + GET /api/track/stats 的配套页）
        { path: 'stats', name: 'adminStats', component: () => import('../views/AdminStatsView.vue') },
        // 本地演示：老师后台 · 资料管理（GET /api/admin/knowledge）
        { path: 'knowledge', name: 'adminKnowledge', component: () => import('../views/AdminKnowledgeView.vue') },
        // 本地演示：老师后台 · 注册用户（GET /api/admin/users）
        { path: 'users', name: 'adminUsers', component: () => import('../views/AdminUsersView.vue') },
        // 访客反馈（2026-10-14）：收得进来、看得见、能导出
        { path: 'feedback', name: 'adminFeedback', component: () => import('../views/AdminFeedbackView.vue') },
        // B09 公众互动：老师后台 · 投稿审核队列（GET /api/admin/contributions）
        {
          path: 'contributions',
          name: 'adminContributions',
          component: () => import('../views/AdminContributionsView.vue')
        },
        // 2026-10-19：机构信息（联系方式 / 邮箱 / 地址 / 合作说明 / 版权行）
        { path: 'site', name: 'adminSite', component: () => import('../views/admin/AdminSiteView.vue') },
        // T10：老师后台 · 设置（智能体设置 / 解析引擎设置 / 一键自检）
        { path: 'settings', name: 'adminSettings', component: () => import('../views/AdminSettingsView.vue') }
      ]
    },
    { path: '/:pathMatch(.*)*', name: 'notFound', component: () => import('../views/NotFoundView.vue') }
  ],
  scrollBehavior(to) {
    // 带锚点的页内跳转（如首页 `/#cite`、`/#distribution`）落在对应区块，其余一律回顶部
    // 2026-10-18（task-6）：`/about`、`/insights` 两条路由已删，锚点全部落在首页
    if (to.hash) return { el: to.hash, behavior: 'smooth', top: 80 }
    return { top: 0 }
  }
})

/**
 * 管理台守卫（2026-10-19 新增，此前本文件**没有**任何 beforeEach）：
 * 只拦 `meta.adminOnly` 的路由。做法是先确保本地有用户信息（刷新后第一次进管理台
 * 时 `user` 还是 null，得先拉一次 /auth/me），再比 role。
 * 不是管理员 → 跳登录页并带上 redirect，登录后能回到原来想去的页面。
 *
 * ⚠️ 这层只管「别让公众看见管理台」，不是安全边界：所有 /api/admin/* 在后端
 * 都会用 requireAdminGuard 再查一次账号身份，前端改 localStore 也拿不到数据。
 */
router.beforeEach(async (to) => {
  const needAdmin = to.matched.some((r) => r.meta.adminOnly === true)
  if (!needAdmin) return true

  const { user, isAdmin, fetchMe } = useAuth()
  if (!user.value) await fetchMe()
  if (isAdmin.value) return true

  return { path: '/auth', query: { redirect: to.fullPath } }
})

// 韶茹：PV 埋点。放在路由层是唯一能覆盖「所有页面」的位置，页面组件不用各自记一遍。
// 埋点失败只打一条 warn（api/track.ts 内部已吞异常），不影响任何导航。
router.afterEach((to) => {
  void trackEvent({ event: 'page_view', path: to.fullPath })
})

export default router
