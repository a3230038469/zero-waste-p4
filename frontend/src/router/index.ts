/**
 * 路由 —— 负责人：丁梓柔（B04）
 * 页面：首页 / 资料库 / 数据概览 / 关于项目 / 资料详情 / 注册登录 /（后台）
 *
 * ⚠️ 本文件被三人动过：
 *   - 丁梓柔：B04 四个页面 + 404
 *   - 韶茹：`/admin/stats` 数据看板路由 + 一处 PV 埋点（B03 埋点统计配套，2026-10-07）
 *     如需回退，删掉带「韶茹」注释的这几行即可，不影响其余路由。
 *   - 对外展示站改造（2026-10-10）：新增 `/insights` 数据概览、`/about` 关于项目。
 *     这两个页面的内容**全部来自真实数据与已核事实**，没有一段是编的（见页面内注释）。
 *   - T5（2026-10-12）：新增 `/chat` AI 问答独立页（会话存数据库，可接着聊）。
 *   - B09（2026-10-13）：新增 `/contribute` 我要投稿 + 意见反馈，与
 *     `/admin/contributions` 投稿审核队列。要回退就删掉带「B09 公众互动」注释的几行。
 */
import { createRouter, createWebHistory } from 'vue-router'

import { trackEvent } from '../api/track'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
    { path: '/shelf', name: 'shelf', component: () => import('../views/ShelfView.vue') },
    { path: '/insights', name: 'insights', component: () => import('../views/InsightsView.vue') },
    { path: '/about', name: 'about', component: () => import('../views/AboutView.vue') },
    // T5：AI 问答独立页（左会话列表 / 右对话流，会话存数据库，可接着聊）
    { path: '/chat', name: 'chat', component: () => import('../views/ChatView.vue') },
    // B09 公众互动（2026-10-13）：我要投稿 + 意见反馈，一个页面两个标签页
    {
      path: '/contribute',
      name: 'contribute',
      component: () => import('../views/ContributeView.vue')
    },
    { path: '/doc/:id', name: 'doc', component: () => import('../views/DocDetailView.vue') },
    { path: '/auth', name: 'auth', component: () => import('../views/AuthView.vue') },
    // 韶茹：数据看板（POST /api/track + GET /api/track/stats 的配套页）
    {
      path: '/admin/stats',
      name: 'adminStats',
      component: () => import('../views/AdminStatsView.vue')
    },
    // 本地演示：老师后台 · 资料管理（GET /api/admin/knowledge）
    {
      path: '/admin/knowledge',
      name: 'adminKnowledge',
      component: () => import('../views/AdminKnowledgeView.vue')
    },
    // 本地演示：老师后台 · 注册用户（GET /api/admin/users）
    {
      path: '/admin/users',
      name: 'adminUsers',
      component: () => import('../views/AdminUsersView.vue')
    },
    // B09 公众互动：老师后台 · 投稿审核队列（GET /api/admin/contributions）
    {
      path: '/admin/contributions',
      name: 'adminContributions',
      component: () => import('../views/AdminContributionsView.vue')
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'notFound',
      component: () => import('../views/NotFoundView.vue')
    }
  ],
  scrollBehavior(to) {
    // 带锚点的页内跳转（如 /about#data）落在对应区块，其余一律回顶部
    if (to.hash) return { el: to.hash, behavior: 'smooth', top: 80 }
    return { top: 0 }
  }
})

// 韶茹：PV 埋点。放在路由层是唯一能覆盖「所有页面」的位置，页面组件不用各自记一遍。
// 埋点失败只打一条 warn（api/track.ts 内部已吞异常），不影响任何导航。
router.afterEach((to) => {
  void trackEvent({ event: 'page_view', path: to.fullPath })
})

export default router
