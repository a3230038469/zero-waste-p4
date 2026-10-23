<script setup lang="ts">
/**
 * 老师后台 · 注册用户 —— 2026-10-08 本地演示版新增
 *
 * 路由：/admin/users
 * 数据源：GET /api/admin/users（需管理员账号登录态）
 *
 * 说明（2026-10-19 改）：手机号在**页面里显示完整号码**（机构要能直接联系注册用户）；
 *   本页受管理员守卫保护，页面上写明号码不要外传。
 *   2026-10-21（T4）再改：**导出的 CSV 里手机号做脱敏**（只保留后 4 位）——
 *   名单是个人信息，导出后最容易外传；脱敏在 api/admin.ts 的 exportCsv 里做。
 *   同日新增「使用明细」入口 —— 点账号（或点该行的按钮）在右侧抽屉里逐条看这个账号的
 *   AI 提问原文、预览/下载了哪份资料（数据源 /api/admin/user-activity，见 components/admin/ActivityDrawer.vue）。
 *
 * 2026-10-19：管理台鉴权从共用口令改成管理员账号，本页口令输入框与口令状态一并删除。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import {
  exportCsv,
  fetchUserList,
  resetAdminUserPassword,
  updateAdminUser,
  type AdminUserItem
} from '../api/admin'
import { publicErrorText } from '../api/http'
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
 * 2026-10-21（T4）：导出的名单里**手机号是脱敏的**（只留后 4 位）——
 * 页面里看得到完整号码，导出件不带完整号码，少一份外传风险。
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

/** 重置密码：把用户密码重置为初始密码 123456（原密码立即失效） */
const resettingId = ref('')

async function resetPassword(row: AdminUserItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认把「${row.name}」的密码重置为初始密码 123456？重置后原密码立即失效，请提醒对方登录后尽快修改。`,
      '重置密码',
      { confirmButtonText: '确认重置', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }

  resettingId.value = row.id
  try {
    const res = await resetAdminUserPassword(row.id)
    ElMessage.success(res.message || '密码已重置为初始密码 123456')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '重置密码失败，请稍后再试')
  } finally {
    resettingId.value = ''
  }
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

/**
 * 真正要显示的「关注议题」。
 *
 * ⚠️ 历史数据里存的是 `["[]"]` 这种**假值**（数组里装着字符串 "[]"），
 * 直接渲染就会在表格里出现一个写着 "[]" 的小标签，运营完全看不懂。
 * 这里把空串、纯方括号这类没有意义的值过滤掉，全空就显示「—」。
 */
function displayTopics(topics: string[] | undefined): string[] {
  return (topics ?? []).filter((t) => {
    const v = (t ?? '').trim()
    if (!v) return false
    if (v === '[]' || v === '{}' || v === 'null' || v === 'undefined') return false
    return true
  })
}

/**
 * 角色显示：admin = 管理员，user = 普通用户。
 * 后端还没给 role 字段时（老接口），显示「未标注」而不是硬说成「普通用户」——
 * 把管理员误标成普通用户，比空着更坑。
 */
function roleLabel(row: AdminUserItem): string {
  const role = (row.role ?? '').toLowerCase()
  if (!role) return '未标注'
  return role === 'admin' ? '管理员' : '普通用户'
}

/** 状态列同理：后端给了 status 才显示停用，否则「未标注」 */
function statusLabel(row: AdminUserItem): string {
  const status = (row.status ?? '').toLowerCase()
  if (!status) return '未标注'
  return status === 'disabled' ? '已停用' : '正常'
}

function isAdmin(row: AdminUserItem): boolean {
  return (row.role ?? '').toLowerCase() === 'admin'
}

/* ---------------- 编辑用户资料（角色只能从固定选项里选） ---------------- */

const editDialog = ref(false)
const editSaving = ref(false)
const editTarget = ref<AdminUserItem | null>(null)
const editForm = ref({ name: '', org: '', occupation: '', topics: '', role: 'user' as 'user' | 'admin' })
const roleConfirmDialog = ref(false)
const pendingRoleChange = ref<{ target: AdminUserItem; newRole: 'user' | 'admin' } | null>(null)

const ROLE_OPTIONS = [
  { value: 'user', label: '普通用户' },
  { value: 'admin', label: '管理员' }
]

function openEdit(row: AdminUserItem): void {
  editTarget.value = row
  editForm.value = {
    name: row.name ?? '',
    org: row.org ?? '',
    occupation: row.occupation ?? '',
    topics: displayTopics(row.topics).join('、'),
    role: isAdmin(row) ? 'admin' : 'user'
  }
  editDialog.value = true
}

async function submitEdit(): Promise<void> {
  const target = editTarget.value
  if (!target) return
  if (!editForm.value.name.trim()) {
    ElMessage.warning('姓名不能为空')
    return
  }
  const currentRole = isAdmin(target) ? 'admin' : 'user'
  const newRole = editForm.value.role
  if (currentRole !== newRole) {
    pendingRoleChange.value = { target, newRole }
    roleConfirmDialog.value = true
    return
  }
  await doSave()
}

async function doSave(): Promise<void> {
  const target = editTarget.value
  if (!target) return
  editSaving.value = true
  try {
    await updateAdminUser(target.id, {
      name: editForm.value.name.trim(),
      org: editForm.value.org.trim(),
      occupation: editForm.value.occupation.trim(),
      topics: editForm.value.topics
        .split(/[、,，\s]+/)
        .map((t) => t.trim())
        .filter(Boolean),
      role: editForm.value.role
    })
    ElMessage.success('已保存')
    editDialog.value = false
    await load()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败，请稍后再试')
  } finally {
    editSaving.value = false
  }
}

function confirmRoleChange(): void {
  roleConfirmDialog.value = false
  pendingRoleChange.value = null
  void doSave()
}

function cancelRoleChange(): void {
  roleConfirmDialog.value = false
  const pending = pendingRoleChange.value
  if (pending) {
    editForm.value.role = isAdmin(pending.target) ? 'admin' : 'user'
  }
  pendingRoleChange.value = null
}

/**
 * 注册时间按**本地时区**显示（2026-10-21 · task-18 B-4）。
 *
 * 以前是直接切 ISO 字符串（'2026-10-08T13:28:33Z' → '2026-10-08 13:28'），
 * 那是 UTC 时间，比本地早 8 小时，跟导出的 CSV（本地时间）对不上。
 * 现在用 new Date 转本地时区，带秒 —— 与后端 CSV 导出值逐字一致。
 */
function shortDateTime(value: string): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value.replace('T', ' ').slice(0, 19)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const data = await fetchUserList()
    items.value = data.items ?? []
    errorText.value = ''
    page.value = 1
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status
    // ⚠️ 不透传后端 message —— 里面可能带内部引擎地址（task-18 B-1）
    errorText.value =
      status === 403
        ? '当前账号不是管理员。'
        : publicErrorText(err, '用户名单暂时读不出来，请稍后再试。')
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
          截至目前的注册情况。页面上手机号是完整号码（用于联系用户），导出的名单里手机号只保留后 4 位，请勿对外转发。
          点任意一行（或行尾的「查看记录」）可以看到这个账号具体提问了什么、预览/下载了哪份资料；
          「编辑资料」可以改姓名/机构/职业/关注议题，角色也在这里改。
          <strong>密码无法查看</strong>（系统只保存加密哈希，原文不可反推）；用户忘记密码时用「重置密码」，
          会重置为初始密码 <strong>123456</strong>，请提醒对方登录后尽快修改。
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
        <el-table-column type="index" label="#" width="48" />
        <el-table-column prop="name" label="姓名" width="96" show-overflow-tooltip />
        <el-table-column prop="org" label="机构" min-width="150" show-overflow-tooltip />
        <el-table-column prop="occupation" label="职业" width="90" show-overflow-tooltip />
        <el-table-column label="关注议题" min-width="150">
          <template #default="scope">
            <template v-if="displayTopics(scope.row.topics).length">
              <el-tag
                v-for="t in displayTopics(scope.row.topics)"
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
        <el-table-column prop="phone" label="手机号" width="122" align="center" />
        <el-table-column label="角色" width="76" align="center">
          <template #default="scope">
            <el-tag size="small" :type="isAdmin(scope.row) ? 'warning' : 'info'" effect="plain">
              {{ roleLabel(scope.row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="72" align="center">
          <template #default="scope">
            <el-tag
              size="small"
              :type="(scope.row.status ?? '').toLowerCase() === 'disabled' ? 'danger' : 'success'"
              effect="plain"
            >
              {{ statusLabel(scope.row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="注册时间" width="128" align="center">
          <template #default="scope">{{ shortDateTime(scope.row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220" align="center" fixed="right">
          <template #default="scope">
            <div class="row-actions">
              <el-button text size="small" @click.stop="openEdit(scope.row)">编辑资料</el-button>
              <el-button text size="small" @click.stop="openActivity(scope.row)">查看记录</el-button>
              <el-button
                text
                size="small"
                :loading="resettingId === scope.row.id"
                @click.stop="resetPassword(scope.row)"
              >
                重置密码
              </el-button>
            </div>
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

    <el-dialog v-model="editDialog" title="编辑用户资料" width="480px">
      <el-form label-width="84px" label-position="left">
        <el-form-item label="姓名">
          <el-input v-model="editForm.name" placeholder="用户姓名" clearable />
        </el-form-item>
        <el-form-item label="机构">
          <el-input v-model="editForm.org" placeholder="所属机构" clearable />
        </el-form-item>
        <el-form-item label="职业">
          <el-input v-model="editForm.occupation" placeholder="职业" clearable />
        </el-form-item>
        <el-form-item label="关注议题">
          <el-input
            v-model="editForm.topics"
            placeholder="多个议题用顿号或逗号隔开，例如：垃圾分类、厨余处理"
            clearable
          />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="editForm.role" style="width: 100%">
            <el-option
              v-for="opt in ROLE_OPTIONS"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
          <p class="edit-note">角色只有这两种，改完即时生效。</p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialog = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="roleConfirmDialog"
      title="确认角色变更"
      width="420px"
      :before-close="() => false"
    >
      <template v-if="pendingRoleChange">
        <p style="margin: 0; font-size: 14px; line-height: 1.6;">
          <span v-if="pendingRoleChange.newRole === 'admin'">
            确认把「{{ pendingRoleChange.target.name }}」设为<strong>管理员</strong>？
          </span>
          <span v-else>
            确认取消「{{ pendingRoleChange.target.name }}」的<strong>管理员身份</strong>？
          </span>
        </p>
        <p v-if="pendingRoleChange.newRole === 'user'" style="margin: 12px 0 0; font-size: 12px; color: var(--zw-amber);">
          ⚠️ 如果当前只有这一位管理员，后端会拦截并提示“无法撤销最后一位管理员”。
        </p>
      </template>
      <template #footer>
        <el-button @click="cancelRoleChange">取消</el-button>
        <el-button type="primary" :loading="editSaving" @click="confirmRoleChange">确认</el-button>
      </template>
    </el-dialog>
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
/* 输入框吃掉剩余宽度，右侧「筛出 N 位」不换行（2026-10-23 修：以前被挤成两行） */
.bar :deep(.el-input) {
  flex: 1 1 auto;
  min-width: 0;
}
.bar .count {
  flex: 0 0 auto;
  white-space: nowrap;
  font-size: 13px;
  color: var(--zw-muted);
}
/* 操作列两个文字按钮排一行，不再上下堆叠 */
.row-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  white-space: nowrap;
}
.row-actions :deep(.el-button) {
  margin-left: 0;
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
.edit-note {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--zw-faint);
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
