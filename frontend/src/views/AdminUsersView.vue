<script setup lang="ts">
/**
 * 老师后台 · 注册用户 —— 2026-10-08 本地演示版新增
 *
 * 路由：/admin/users
 * 数据源：GET /api/admin/users（需管理员账号登录态）
 *
 * 说明（2026-10-19 改）：手机号**显示完整号码**（机构要能直接联系注册用户）；
 *   本页受管理员守卫保护，页面上写明号码不要外传。
 *   2026-10-19 二次改（用户要求）：**导出的 CSV 也改成完整号码**，与页面口径一致；
 *   同日新增「使用明细」入口 —— 点账号（或点该行的按钮）在右侧抽屉里逐条看这个账号的
 *   AI 提问原文、预览/下载了哪份资料（数据源 /api/admin/user-activity，见 components/admin/ActivityDrawer.vue）。
 *
 * 2026-10-19：管理台鉴权从共用口令改成管理员账号，本页口令输入框与口令状态一并删除。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { exportCsv, fetchUserList, type AdminUserItem } from '../api/admin'
import ActivityDrawer from '../components/admin/ActivityDrawer.vue'

const PAGE_SIZE = 20

const items = ref<AdminUserItem[]>([])
const loading = ref(false)
const errorText = ref('')
const keyword = ref('')
const page = ref(1)
const exporting = ref(false)

/**
 * 导出注册用户名单（CSV）。
 * 2026-10-19 改：页面与导出**都用完整手机号**（用户要求，机构要拿名单直接联系）。
 * 提醒：名单属于个人信息，别对外转发。
 */
async function doExport(): Promise<void> {
  exporting.value = true
  try {
    await exportCsv('users')
    ElMessage.success('名单已开始下载')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导出失败')
  } finally {
    exporting.value = false
  }
}

/* 使用明细抽屉：点账号看这个人的逐条记录（提问原文 / 预览 / 下载 / 检索 / 浏览） */
const drawerOpen = ref(false)
const drawerAccount = ref({ id: '', name: '', org: '' })

function openActivity(user: AdminUserItem): void {
  drawerAccount.value = { id: user.id, name: user.name, org: user.org }
  drawerOpen.value = true
}

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
  loading.value = true
  try {
    const data = await fetchUserList()
    items.value = data.items ?? []
    errorText.value = ''
    page.value = 1
  } catch (err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: { message?: string } } } }
    ).response
    errorText.value =
      response?.status === 403
        ? '当前账号不是管理员。'
        : (response?.data?.error?.message ?? '拉取失败，看看后端（:4000）在不在。')
    items.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="admin-users">
    <header class="head">
      <div>
        <h2 class="title">注册用户</h2>
        <p class="sub">
          截至目前的注册情况。手机号显示完整号码（用于联系用户），导出名单里也是完整号码，请勿对外转发。
          点任意一行（或行尾的「使用明细」）可以看到这个账号具体提问了什么、预览/下载了哪份资料。
        </p>
      </div>
      <el-button v-if="items.length" :loading="exporting" @click="doExport">
        导出名单 CSV
      </el-button>
    </header>

    <p v-if="errorText" class="err">{{ errorText }}</p>

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

      <el-table :data="pageItems" size="small" border class="table clickable-table" @row-click="openActivity">
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
        <el-table-column label="使用明细" width="104" align="center">
          <template #default="scope">
            <el-button text size="small" @click.stop="openActivity(scope.row)">查看记录</el-button>
          </template>
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

    <el-card v-else-if="!loading && !errorText" shadow="never" class="empty-card">
      <p class="empty-text">还没有人注册。等有人注册后，这里会出现他们的信息。</p>
    </el-card>

    <ActivityDrawer
      v-model:open="drawerOpen"
      :user-id="drawerAccount.id"
      :name="drawerAccount.name"
      :org="drawerAccount.org"
      :days="90"
    />
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
  color: var(--zw-green-ink);
}
.sub {
  margin: 0;
  font-size: 13px;
  color: var(--zw-muted);
}
.err {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--zw-amber);
}
.stat {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 10px;
  font-size: 14px;
  color: var(--zw-text);
}
.stat .dot {
  color: var(--zw-line-strong);
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.bar .count {
  font-size: 13px;
  color: var(--zw-muted);
}
.table {
  background: var(--zw-surface);
}
/* 整行可点 → 打开使用明细，给个手型提示，别让人以为只是装饰 */
.clickable-table :deep(.el-table__row) {
  cursor: pointer;
}
.topic {
  margin-right: 4px;
}
.empty {
  color: var(--zw-line-strong);
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
  color: var(--zw-muted);
}
</style>
