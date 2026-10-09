<script setup lang="ts">
/**
 * 老师后台 · 注册用户 —— 2026-10-08 本地演示版新增
 *
 * 路由：/admin/users
 * 数据源：GET /api/admin/users（需请求头 X-Admin-Token）
 *
 * 说明：手机号由后端脱敏（138****8888），前端拿到就已经是打码后的。
 */
import { computed, onMounted, ref } from 'vue'

import { ADMIN_TOKEN_KEY, fetchUserList, type AdminUserItem } from '../api/admin'

const PAGE_SIZE = 20

const token = ref('')
const items = ref<AdminUserItem[]>([])
const loading = ref(false)
const errorText = ref('')
const keyword = ref('')
const page = ref(1)

/** 关键词过滤（姓名或机构） */
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return items.value
  return items.value.filter(
    (u) => u.name.toLowerCase().includes(kw) || u.org.toLowerCase().includes(kw)
  )
})

const pageItems = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return filtered.value.slice(start, start + PAGE_SIZE)
})

/** 涉及多少个机构（去重） */
const orgCount = computed(() => new Set(items.value.map((u) => u.org).filter(Boolean)).size)

function shortDateTime(value: string): string {
  return value ? value.slice(0, 16).replace('T', ' ') : '—'
}

async function load(): Promise<void> {
  if (!token.value) {
    errorText.value = '请输入管理口令'
    return
  }
  loading.value = true
  try {
    const data = await fetchUserList(token.value)
    items.value = data.items ?? []
    errorText.value = ''
    page.value = 1
    localStorage.setItem(ADMIN_TOKEN_KEY, token.value)
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    errorText.value =
      response?.status === 403
        ? '口令不正确。'
        : (response?.data?.error?.message ?? '拉取失败，看看后端（:4000）在不在。')
    items.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  const saved = localStorage.getItem(ADMIN_TOKEN_KEY)
  if (saved) {
    token.value = saved
    void load()
  }
})
</script>

<template>
  <section class="admin-users">
    <header class="head">
      <div>
        <h2 class="title">注册用户</h2>
        <p class="sub">截至目前的注册情况。手机号做了打码处理，不显示完整号码。</p>
      </div>
    </header>

    <nav class="admin-nav">
      <router-link to="/admin/knowledge">资料管理</router-link>
      <router-link to="/admin/users">注册用户</router-link>
      <router-link to="/admin/stats">数据看板</router-link>
    </nav>

    <el-card shadow="never" class="token-card">
      <div class="token-row">
        <el-input
          v-model="token"
          type="password"
          show-password
          placeholder="管理口令（backend/.env 里的 ADMIN_STATS_TOKEN）"
          @keyup.enter="load"
        />
        <el-button type="primary" :loading="loading" @click="load">进入</el-button>
      </div>
      <p v-if="errorText" class="err">{{ errorText }}</p>
    </el-card>

    <template v-if="items.length">
      <div class="stat">
        <span>共 <b>{{ items.length }}</b> 位注册用户</span>
        <span class="dot">·</span>
        <span>涉及 <b>{{ orgCount }}</b> 个机构</span>
      </div>

      <div class="bar">
        <el-input v-model="keyword" placeholder="按姓名或机构筛选" clearable />
        <span class="count">筛出 {{ filtered.length }} 位</span>
      </div>

      <el-table :data="pageItems" size="small" border class="table">
        <el-table-column type="index" label="#" width="52" />
        <el-table-column prop="name" label="姓名" width="110" show-overflow-tooltip />
        <el-table-column prop="org" label="机构" min-width="180" show-overflow-tooltip />
        <el-table-column prop="occupation" label="职业" width="110" show-overflow-tooltip />
        <el-table-column label="关注议题" min-width="180">
          <template #default="scope">
            <template v-if="scope.row.topics.length">
              <el-tag
                v-for="t in scope.row.topics"
                :key="t"
                size="small"
                type="info"
                effect="plain"
                class="topic"
              >
                {{ t }}
              </el-tag>
            </template>
            <span v-else class="empty">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="phone" label="手机号" width="130" align="center" />
        <el-table-column label="注册时间" width="150" align="center">
          <template #default="scope">{{ shortDateTime(scope.row.createdAt) }}</template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        :page-size="PAGE_SIZE"
        :total="filtered.length"
        layout="prev, pager, next, total"
        class="pager"
      />
    </template>

    <el-card v-else-if="!loading && token && !errorText" shadow="never" class="empty-card">
      <p class="empty-text">口令对了，但还没有人注册。等有人注册后，这里会出现他们的信息。</p>
    </el-card>
  </section>
</template>

<style scoped>
.admin-users {
  max-width: 1180px;
  margin: 0 auto;
  padding: 20px 16px 60px;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.title {
  margin: 0 0 6px;
  font-size: 22px;
  color: #1f3a24;
}
.sub {
  margin: 0;
  font-size: 13px;
  color: #5f6f5f;
}
.admin-nav {
  display: flex;
  gap: 18px;
  margin: 12px 0 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid #e6ece6;
  font-size: 14px;
}
.admin-nav a {
  color: #5f6f5f;
  text-decoration: none;
  padding: 2px 2px 6px;
  border-bottom: 2px solid transparent;
}
.admin-nav a:hover {
  color: #1f3a24;
}
.admin-nav a.router-link-active {
  color: #1f3a24;
  font-weight: 500;
  border-bottom-color: #2e7d32;
}
.token-card {
  margin: 14px 0;
  border-radius: 10px;
}
.token-row {
  display: flex;
  gap: 8px;
}
.err {
  margin: 8px 0 0;
  font-size: 13px;
  color: #b26a00;
}
.stat {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 10px;
  font-size: 14px;
  color: #33473a;
}
.stat .dot {
  color: #b9c6b9;
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.bar .count {
  font-size: 13px;
  color: #6b7d6b;
}
.table {
  background: #fff;
}
.topic {
  margin-right: 4px;
}
.empty {
  color: #b9c6b9;
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
.empty-card {
  margin-top: 14px;
  border-radius: 10px;
}
.empty-text {
  margin: 0;
  font-size: 14px;
  color: #6b7d6b;
}
</style>
