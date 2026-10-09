/**
 * 路由 —— 负责人：丁梓柔（B04）
 * 页面：首页 / 书架 / 资料详情 / 注册登录 /（韶茹加的）数据看板
 *
 * ⚠️ 本文件被两人动过：
 *   - 丁梓柔：B04 四个页面 + 404
 *   - 韶茹：`/admin/stats` 数据看板路由 + 一处 PV 埋点（B03 埋点统计配套，2026-10-07）
 *     如需回退，删掉带「韶茹」注释的这几行即可，不影响其余路由。
 */
import { createRouter, createWebHistory } from 'vue-router'

import { trackEvent } from '../api/track'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
    { path: '/shelf', name: 'shelf', component: () => import('../views/ShelfView.vue') },
    { path: '/doc/:id', name: 'doc', component: () => import('../views/DocDetailView.vue') },
    { path: '/auth', name: 'auth', component: () => import('../views/AuthView.vue') },
    // 韶茹：数据看板（POST /api/track + GET /api/track/stats 的配套页）
    { path: '/admin/stats', name: 'adminStats', component: () => import('../views/AdminStatsView.vue') },
    // 本地演示：老师后台 · 资料管理（GET /api/admin/knowledge）
    { path: '/admin/knowledge', name: 'adminKnowledge', component: () => import('../views/AdminKnowledgeView.vue') },
    // 本地演示：老师后台 · 注册用户（GET /api/admin/users）
    { path: '/admin/users', name: 'adminUsers', component: () => import('../views/AdminUsersView.vue') },
    { path: '/:pathMatch(.*)*', name: 'notFound', component: () => import('../views/NotFoundView.vue') }
  ],
  scrollBehavior() {
    return { top: 0 }
  }
})

// 韶茹：PV 埋点。放在路由层是唯一能覆盖「所有页面」的位置，页面组件不用各自记一遍。
// 埋点失败只打一条 warn（api/track.ts 内部已吞异常），不影响任何导航。
router.afterEach((to) => {
  void trackEvent({ event: 'page_view', path: to.fullPath })
})

export default router
