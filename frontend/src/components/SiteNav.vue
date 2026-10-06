<script setup lang="ts">
/**
 * 顶部导航 —— 负责人：丁梓柔（B04）
 * 显示：站点名 + 导航链接 + 右上角登录态
 * TODO: 接入 useAuth() 显示"XX，你好"
 */
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
        <!-- TODO: 未登录显示"登录/注册"，登录后显示"XX，你好" -->
        <RouterLink to="/auth">登录 / 注册</RouterLink>
      </div>
    </div>
  </header>
</template>

<style scoped>
.site-nav {
  background: var(--zw-green);
  color: #fff;
}
.inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 24px;
}
.brand {
  font-weight: 700;
  font-size: 18px;
  color: #fff;
  text-decoration: none;
}
.links {
  display: flex;
  gap: 16px;
}
.links a {
  color: #eaf5ea;
  text-decoration: none;
}
.auth-slot {
  margin-left: auto;
}
.auth-slot a {
  color: #fff;
  text-decoration: none;
}

/* 手机窄屏：导航不换行、不横滚 */
@media (max-width: 480px) {
  .inner {
    gap: 12px;
    padding: 10px 12px;
  }
  .brand {
    font-size: 15px;
  }
  .links {
    gap: 10px;
    font-size: 14px;
  }
  .auth-slot {
    font-size: 14px;
  }
}
</style>
