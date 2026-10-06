/**
 * 路由 —— 负责人：丁梓柔（B04）
 * 四个页面：首页 / 书架 / 资料详情 / 注册登录
 */
import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
    { path: '/shelf', name: 'shelf', component: () => import('../views/ShelfView.vue') },
    { path: '/doc/:id', name: 'doc', component: () => import('../views/DocDetailView.vue') },
    { path: '/auth', name: 'auth', component: () => import('../views/AuthView.vue') },
    { path: '/:pathMatch(.*)*', name: 'notFound', component: () => import('../views/NotFoundView.vue') }
  ],
  scrollBehavior() {
    return { top: 0 }
  }
})

export default router
