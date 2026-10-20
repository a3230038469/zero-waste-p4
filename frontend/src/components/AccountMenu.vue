<script setup lang="ts">
/**
 * 账号菜单 —— 右上角「头像 + 用户名」下拉卡（2026-10-19 新增）
 *
 * 为什么单独做一个组件：顶部导航的登录态区块（SiteNav）已经很长，而这一块自带
 * 「开关状态 + 点外部关闭 + 资料弹窗 + 保存请求」四套逻辑，塞回导航会让那个文件
 * 继续膨胀；拆出来后 SiteNav 只留一行 `<AccountMenu />`。
 *
 * 结构（经典账号菜单）：
 *   触发区 = 头像圆标（名字首字）+ 用户名 + 展开箭头
 *   下拉卡 = 顶部身份（名 / 机构）→ 个人资料 / 我的投稿 / 意见反馈 → 退出登录
 *
 * 资料弹窗（PATCH /api/auth/me，契约见 docs/接口约定.md）：
 *   只提交**改过的**字段；手机号是登录凭证，改完提示「下次用新号登录」。
 *   保存成功后用后端返回的用户对象直接覆盖本地登录态（useAuth().setUser），
 *   不额外再打一次 /auth/me。
 *
 * ⚠️ 这里的「意见反馈」与页脚共用同一个 FeedbackDialog（scope="site"），
 *    同样受 T11 游客权限开关控制。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { useAuth } from '../composables/useAuth'
import { useGuestPermissions } from '../composables/useGuestPermissions'
import { updateMe, type UpdateProfilePayload } from '../api/auth'
import FeedbackDialog from './FeedbackDialog.vue'

/** 关注议题候选项：与注册页（AuthView）保持同一套，另允许手动输入自定义议题 */
const TOPIC_OPTIONS = ['垃圾分类', '厨余处理', '循环再生', '源头减量', '政策倡导', '社区营造', '其他']

const router = useRouter()
const { user, isAdmin, logout, setUser } = useAuth()
const { ensure: ensureGuestPermissions, guestAllowed } = useGuestPermissions()

/** 下拉卡是否展开 */
const menuOpen = ref(false)
/** 资料弹窗是否展开 */
const profileOpen = ref(false)
/** 保存中（防连点） */
const saving = ref(false)
/** 站点级反馈弹窗（与页脚共用组件） */
const feedbackVisible = ref(false)

/** 根元素：判断「点在组件外面」要靠它 */
const rootRef = ref<HTMLElement | null>(null)

/** 头像里的首字：取名字第一个字符（中文名就是姓），没有名字时用「用」 */
const initial = computed(() => (user.value?.name?.trim()?.[0] ?? '用').toUpperCase())

/** 详细资料（弹窗表单）。打开弹窗时用当前登录用户回填 */
const form = reactive({
  name: '',
  org: '',
  occupation: '',
  topics: [] as string[],
  phone: ''
})
const formRef = ref<FormInstance>()
const rules: FormRules = {
  name: [{ required: true, message: '请填写姓名', trigger: 'blur' }],
  org: [{ required: true, message: '请填写机构', trigger: 'blur' }],
  occupation: [{ required: true, message: '请填写职业', trigger: 'blur' }],
  topics: [{ required: true, type: 'array', min: 1, message: '请至少选择一个关注议题', trigger: 'change' }],
  phone: [
    { required: true, message: '请填写手机号', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确（1 开头的 11 位数字）', trigger: 'blur' }
  ]
}

function toggleMenu(): void {
  menuOpen.value = !menuOpen.value
}

function closeMenu(): void {
  menuOpen.value = false
}

/** 点组件外面 / 按 Esc 收下拉卡（与站内其它浮层习惯一致） */
function onDocumentClick(ev: MouseEvent): void {
  if (!menuOpen.value) return
  const el = rootRef.value
  if (el && ev.target instanceof Node && el.contains(ev.target)) return
  menuOpen.value = false
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') menuOpen.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onKeydown)
  void ensureGuestPermissions()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onKeydown)
})

/** 打开「个人资料」：先把当前登录用户回填进表单，再显示弹窗 */
async function openProfile(): Promise<void> {
  closeMenu()
  form.name = user.value?.name ?? ''
  form.org = user.value?.org ?? ''
  form.occupation = user.value?.occupation ?? ''
  form.topics = [...(user.value?.topics ?? [])]
  form.phone = user.value?.phone ?? ''
  profileOpen.value = true
  await nextTick()
  formRef.value?.clearValidate()
}

/** 保存资料：只提交相对当前用户**有变化**的字段（后端是部分更新） */
async function saveProfile(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  const payload: UpdateProfilePayload = {}
  const cur = user.value
  if (form.name.trim() !== (cur?.name ?? '')) payload.name = form.name.trim()
  if (form.org.trim() !== (cur?.org ?? '')) payload.org = form.org.trim()
  if (form.occupation.trim() !== (cur?.occupation ?? '')) payload.occupation = form.occupation.trim()
  if (form.phone.trim() !== (cur?.phone ?? '')) payload.phone = form.phone.trim()
  const curTopics = [...(cur?.topics ?? [])].join('\u0000')
  if ([...form.topics].join('\u0000') !== curTopics) payload.topics = [...form.topics]

  if (Object.keys(payload).length === 0) {
    ElMessage.info('资料没有变化')
    profileOpen.value = false
    return
  }

  saving.value = true
  try {
    const updated = await updateMe(payload)
    setUser(updated)
    profileOpen.value = false
    ElMessage.success(payload.phone ? '资料已更新，下次登录请用新的手机号' : '资料已更新')
  } catch {
    // 失败提示由 http.ts 的统一拦截器弹出，这里只把弹窗留着让用户改
  } finally {
    saving.value = false
  }
}

/** 意见反馈：与页脚同一套规则（游客被关掉时提示并跳登录页） */
function openFeedback(): void {
  closeMenu()
  if (!guestAllowed('feedback')) {
    ElMessage.warning('意见反馈需要登录后提交，已为你跳到登录页')
    void router.push({ path: '/auth' })
    return
  }
  feedbackVisible.value = true
}

/** 退出登录：清本地凭证并回首页（原来导航栏那颗文字「退出」的行为不变） */
function onLogout(): void {
  closeMenu()
  logout()
  void router.push('/')
}
</script>

<template>
  <div ref="rootRef" class="account">
    <!-- 触发区：头像 + 用户名 + 箭头（真 button，键盘可达） -->
    <button
      type="button"
      class="trigger"
      :class="{ 'is-open': menuOpen }"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      @click="toggleMenu"
    >
      <span class="avatar" aria-hidden="true">{{ initial }}</span>
      <span class="trigger-name">{{ user?.name ?? '已登录' }}</span>
      <span class="caret" aria-hidden="true"></span>
    </button>

    <transition name="acc-fade">
      <div v-if="menuOpen" class="panel" role="menu">
        <!-- 身份区：登录后先确认「我是谁」，再给操作 -->
        <div class="panel-head">
          <span class="avatar avatar--lg" aria-hidden="true">{{ initial }}</span>
          <span class="head-text">
            <strong>{{ user?.name ?? '已登录' }}</strong>
            <em>{{ user?.org || '机构未填写' }}</em>
          </span>
        </div>

        <div class="panel-sep" role="separator"></div>

        <button type="button" class="item" role="menuitem" @click="openProfile">个人资料</button>
        <!-- 管理台入口（2026-10-19）：只有管理员账号能看到这一项。
             后端每个管理接口都会自己再查一次权限，这里藏起来只是不让公众看到入口。 -->
        <RouterLink v-if="isAdmin" to="/admin/knowledge" class="item" role="menuitem" @click="closeMenu">
          管理台
        </RouterLink>
        <RouterLink to="/contribute" class="item" role="menuitem" @click="closeMenu">我的投稿</RouterLink>
        <button type="button" class="item" role="menuitem" @click="openFeedback">意见反馈</button>

        <div class="panel-sep" role="separator"></div>

        <button type="button" class="item item--danger" role="menuitem" @click="onLogout">
          退出登录
        </button>
      </div>
    </transition>

    <!-- 个人资料：改完由后端返回新对象，直接覆盖本地登录态 -->
    <el-dialog
      v-model="profileOpen"
      title="个人资料"
      width="min(520px, 92vw)"
      append-to-body
      class="account-dialog"
    >
      <p class="dialog-lede">
        这些信息在注册时填过，随时可以改。手机号同时是你的登录账号，改完请用新号登录。
      </p>
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="form.name" maxlength="40" placeholder="你的姓名" />
        </el-form-item>
        <el-form-item label="机构" prop="org">
          <el-input v-model="form.org" maxlength="120" placeholder="所在机构 / 单位" />
        </el-form-item>
        <el-form-item label="职业" prop="occupation">
          <el-input v-model="form.occupation" maxlength="40" placeholder="你的职业" />
        </el-form-item>
        <el-form-item label="关注议题（可多选）" prop="topics">
          <el-select
            v-model="form.topics"
            multiple
            filterable
            allow-create
            default-first-option
            :multiple-limit="20"
            placeholder="请选择关注议题，可多选"
            style="width: 100%"
          >
            <el-option v-for="t in TOPIC_OPTIONS" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="电话（登录用）" prop="phone">
          <el-input v-model="form.phone" maxlength="11" placeholder="11 位手机号" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="profileOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveProfile">保存</el-button>
      </template>
    </el-dialog>

    <!-- 站点级反馈：与页脚同一个组件（B09） -->
    <FeedbackDialog v-model="feedbackVisible" scope="site" />
  </div>
</template>

<style scoped>
.account {
  position: relative;
}

/* ---- 触发区 ---- */
.trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 4px 4px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--zw-text);
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;
}

.trigger:hover,
.trigger.is-open {
  background: var(--zw-mint-2);
  border-color: var(--zw-line);
}

.avatar {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--zw-green);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}

.avatar--lg {
  width: 34px;
  height: 34px;
  font-size: 15px;
}

.trigger-name {
  max-width: 8em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.caret {
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--zw-muted);
  transition: transform 0.16s ease;
}

.trigger.is-open .caret {
  transform: rotate(180deg);
}

/* ---- 下拉卡 ---- */
.panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 120;
  width: 240px;
  padding: 6px;
  background: var(--zw-surface);
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-radius);
  box-shadow: var(--zw-shadow-lg);
  transform-origin: top right;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 8px;
}

.head-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.35;
}

.head-text strong {
  font-size: 14px;
  font-weight: 600;
  color: var(--zw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-text em {
  font-style: normal;
  font-size: 12px;
  color: var(--zw-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--zw-line);
}

.item {
  display: block;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: var(--zw-radius-sm);
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--zw-text);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

.item:hover {
  background: var(--zw-mint);
  color: var(--zw-green-deep);
}

.item:active {
  background: var(--zw-mint-2);
}

.item--danger {
  color: var(--zw-danger);
}

.item--danger:hover {
  background: #fdeeee;
  color: var(--zw-danger);
}

/* 展开动效：从触发区右上角轻轻落下，不弹跳 */
.acc-fade-enter-active,
.acc-fade-leave-active {
  transition: opacity 0.14s ease, transform 0.14s ease;
}

.acc-fade-enter-from,
.acc-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}

.dialog-lede {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--zw-muted);
}

/* 手机上：卡片贴右边缘、别顶出屏幕 */
@media (max-width: 480px) {
  .trigger-name {
    max-width: 5em;
  }

  .panel {
    width: min(240px, calc(100vw - 32px));
  }
}
</style>
