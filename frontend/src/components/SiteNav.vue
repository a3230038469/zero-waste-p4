<script setup lang="ts">
/**
 * 顶部导航 —— 负责人：丁梓柔（B04）
 * 站点名 + 导航链接 + 右上角登录态（GET /api/auth/me）
 * 登录态三级：拿到用户信息 → 「XX，你好」；只有 token（用户信息暂取不到）→「已登录」；
 * 都没有 → 「登录 / 注册」。
 * 手机窄屏：整体换行为两行（品牌+登录态 / 导航链接），不横滚、不错位。
 */
import { onMounted } from 'vue'
import { useAuth } from '../composables/useAuth'

const { user, isLoggedIn, fetchMe } = useAuth()

onMounted(() => {
  fetchMe()
})
</script>

<template>
  <header class="site-nav">
    <div class="inner">
      <RouterLink to="/" class="brand">零废弃知识库</RouterLink>
      <nav class="links">
        <RouterLink to="/">首页</RouterLink>
        <RouterLink to="/shelf">书架</RouterLink>
      </nav>
      <div class="auth-slot">
        <span v-if="user" class="greeting">{{ user.name }}，你好</span>
        <!-- 有 token 但 /me 没取到用户信息：仍算已登录，别让用户以为登录没生效 -->
        <span v-else-if="isLoggedIn" class="greeting">已登录</span>
        <RouterLink v-else to="/auth">登录 / 注册</RouterLink>
        <!-- 老师后台入口：刻意做得不显眼（公众看的是首页/书架），但让老师找得到 -->
        <RouterLink to="/admin/knowledge" class="admin-link">管理</RouterLink>
      </div>
    </div>
  </header>
</template>

<style scoped>
.site-nav {
  background: var(--zw-green);
  color: #fff;
  /* 窄屏下内容不出头 */
  overflow-x: hidden;
}
.inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: 12px 16px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 24px;
}
.brand {
  font-weight: 700;
  font-size: 18px;
  color: #fff;
  text-decoration: none;
  white-space: nowrap;
}
.auth-slot {
  margin-left: auto;
  font-size: 15px;
}
.auth-slot a {
  color: #fff;
  text-decoration: none;
  white-space: nowrap;
}
.auth-slot a:hover {
  text-decoration: underline;
}
.greeting {
  color: #eaf5ea;
  white-space: nowrap;
}
/* 老师后台入口：比正常导航淡一档，不抢公众视线，但一直可见。
   ⚠️ 选择器必须带 .auth-slot —— 否则被上面 `.auth-slot a` 的优先级压掉（实测踩过） */
.auth-slot .admin-link {
  margin-left: 14px;
  font-size: 13px;
  color: #cbe4cb;
}
.auth-slot .admin-link:hover {
  color: #fff;
}
.links {
  display: flex;
  gap: 16px;
}
.links a {
  color: #eaf5ea;
  text-decoration: none;
  white-space: nowrap;
}
.links a:hover {
  color: #fff;
}
/* 当前页对应的导航链接高亮 */
.links a.router-link-active {
  color: #fff;
  font-weight: 600;
  border-bottom: 2px solid #fff;
  padding-bottom: 2px;
}

/* 手机窄屏：第一行 = 品牌 + 登录态，第二行 = 导航链接 */
@media (max-width: 480px) {
  .inner {
    gap: 6px 12px;
    padding: 10px 12px;
  }
  .brand {
    font-size: 15px;
  }
  .links {
    order: 3;
    flex-basis: 100%;
    gap: 14px;
    font-size: 14px;
  }
  .auth-slot {
    font-size: 14px;
  }
}
</style>
