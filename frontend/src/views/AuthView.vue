<script setup lang="ts">
/**
 * 注册 / 登录页 —— 负责人：月月（B02）
 *
 * 注册五字段：姓名、机构、职业、关注议题（可多选）、电话 + 密码 + 确认密码
 * 登录：手机号 + 密码
 * 可用于同一页用标签切换。
 *
 * 接口：POST /api/auth/register、POST /api/auth/login（见 docs/接口约定.md）
 */
</script>

<template>
  <section class="auth">
    <h2>登录 / 注册</h2>
    <el-empty description="页面开发中（B02 用户板块）" />
  </section>
</template>
