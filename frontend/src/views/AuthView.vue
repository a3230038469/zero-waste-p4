<script setup lang="ts">
/**
 * 注册 / 登录页 —— 负责人：月月（B02）
 *
 * 同一页用标签（el-tabs）切换：登录 / 注册。
 * 注册五字段：姓名、机构、职业、关注议题（可多选）、电话 + 密码 + 确认密码。
 * 登录：手机号 + 密码；成功后 setToken + fetchMe → 导航栏显示「XX，你好」。
 * token 存 localStorage（zwp.token，与 B04 的 http.ts / useAuth.ts 共用同一键），
 * 刷新浏览器登录态不掉。
 * 支持 ?redirect=...：从详情页「下载（需登录）」跳来，登录后自动回到原页面。
 *
 * 接口：POST /api/auth/register、POST /api/auth/login（见 docs/接口约定.md）
 */
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { login, register } from '../api/auth'
import { useAuth } from '../composables/useAuth'

const route = useRoute()
const router = useRouter()
const { setToken, fetchMe } = useAuth()

const activeTab = ref<'login' | 'register'>('login')

/**
 * 登录后跳哪儿：**只允许站内相对路径**（2026-10-21 修 · P1-13 开放重定向）。
 *
 * ⚠️ 原来是把 ?redirect= 原样丢给 router.push：
 *    别人发一条 /auth?redirect=https://evil.example 的链接，
 *    用户一登录就被带到外站 —— 借本站的信任钓鱼。
 *    现在只放行「以 / 开头」的站内路径，其余一律回首页。
 *
 * 放行的条件（同时满足）：
 *   - 以 / 开头（站内路径）
 *   - 不是 // 开头（那会被浏览器当成 //evil.example 这种「协议相对地址」）
 *   - 不含反斜杠（老浏览器会把 \ 当成 /，"/\evil.example" 又是一条绕过口子）
 *   - 不是 http:/https: 开头（绝对地址）
 */
function safeRedirect(target: unknown): string {
  if (typeof target !== 'string') return '/'
  const value = target.trim()
  if (!value.startsWith('/')) return '/'
  if (value.startsWith('//')) return '/'
  if (value.includes('\\')) return '/'
  if (/^https?:/i.test(value)) return '/'
  return value
}

// ============ 登录 ============
const loginFormRef = ref<FormInstance>()
const loginForm = reactive({ phone: '', password: '' })
const loginRules: FormRules = {
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确', trigger: 'blur' }
  ],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}
const loginLoading = ref(false)

async function handleLogin(): Promise<void> {
  const form = loginFormRef.value
  if (!form) return
  const valid = await form.validate().catch(() => false)
  if (!valid) return
  loginLoading.value = true
  try {
    const token = await login({ phone: loginForm.phone, password: loginForm.password })
    setToken(token) // 保存 token（localStorage），刷新不掉登录态
    await fetchMe() // 拉取用户信息 → 导航栏右上角显示「XX，你好」
    ElMessage.success('登录成功')
    router.push(safeRedirect(route.query.redirect))
  } catch {
    // 错误提示由 http.ts 统一弹出，这里只负责收尾
  } finally {
    loginLoading.value = false
  }
}

// ============ 注册 ============
const registerFormRef = ref<FormInstance>()
const registerForm = reactive({
  name: '',
  org: '',
  occupation: '',
  topics: [] as string[],
  phone: '',
  password: '',
  confirm: ''
})

/** 关注议题候选项（可多选，也允许手动输入自定义议题） */
const TOPIC_OPTIONS = ['垃圾分类', '厨余处理', '循环再生', '源头减量', '政策倡导', '社区营造', '其他']

const registerRules: FormRules = {
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  org: [{ required: true, message: '请输入所在机构', trigger: 'blur' }],
  occupation: [{ required: true, message: '请输入职业', trigger: 'blur' }],
  topics: [{ required: true, type: 'array', min: 1, message: '请至少选择一个关注议题', trigger: 'change' }],
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 8, max: 72, message: '密码长度 8–72 位', trigger: 'blur' }
  ],
  confirm: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback: (error?: Error) => void) => {
        if (value !== registerForm.password) {
          callback(new Error('两次输入的密码不一致'))
        } else {
          callback()
        }
      },
      trigger: 'blur'
    }
  ]
}
const registerLoading = ref(false)

async function handleRegister(): Promise<void> {
  const form = registerFormRef.value
  if (!form) return
  const valid = await form.validate().catch(() => false)
  if (!valid) return
  registerLoading.value = true
  try {
    await register({
      name: registerForm.name,
      org: registerForm.org,
      occupation: registerForm.occupation,
      topics: registerForm.topics,
      phone: registerForm.phone,
      password: registerForm.password
    })
    ElMessage.success('注册成功，请登录')
    // 切到登录标签并带上手机号，少打一次字
    loginForm.phone = registerForm.phone
    activeTab.value = 'login'
  } catch {
    // 错误提示由 http.ts 统一弹出，这里只负责收尾
  } finally {
    registerLoading.value = false
  }
}
</script>

<template>
  <section class="auth-page">
    <el-card class="auth-card" shadow="hover">
      <h1 class="title">零废弃知识库 · 用户中心</h1>
      <p class="subtitle">提问无需注册；下载资料等操作需要登录</p>

      <el-tabs v-model="activeTab" class="auth-tabs">
        <!-- ============ 登录 ============ -->
        <el-tab-pane label="登录" name="login">
          <el-form
            ref="loginFormRef"
            :model="loginForm"
            :rules="loginRules"
            label-position="top"
            size="large"
          >
            <el-form-item label="手机号" prop="phone">
              <el-input
                v-model="loginForm.phone"
                placeholder="注册时填写的手机号"
                maxlength="11"
                clearable
              />
            </el-form-item>
            <el-form-item label="密码" prop="password">
              <el-input
                v-model="loginForm.password"
                type="password"
                show-password
                placeholder="请输入密码"
                @keyup.enter="handleLogin"
              />
            </el-form-item>
            <el-button
              type="primary"
              class="submit"
              :loading="loginLoading"
              @click="handleLogin"
            >
              登 录
            </el-button>
          </el-form>
        </el-tab-pane>

        <!-- ============ 注册 ============ -->
        <el-tab-pane label="注册" name="register">
          <el-form
            ref="registerFormRef"
            :model="registerForm"
            :rules="registerRules"
            label-position="top"
            size="large"
          >
            <el-form-item label="姓名" prop="name">
              <el-input v-model="registerForm.name" placeholder="请输入姓名" clearable />
            </el-form-item>
            <el-form-item label="机构" prop="org">
              <el-input v-model="registerForm.org" placeholder="请输入所在机构" clearable />
            </el-form-item>
            <el-form-item label="职业" prop="occupation">
              <el-input v-model="registerForm.occupation" placeholder="请输入职业" clearable />
            </el-form-item>
            <el-form-item label="关注议题（可多选）" prop="topics">
              <el-select
                v-model="registerForm.topics"
                multiple
                filterable
                allow-create
                default-first-option
                placeholder="请选择关注议题，可多选"
                class="topics-select"
              >
                <el-option v-for="t in TOPIC_OPTIONS" :key="t" :label="t" :value="t" />
              </el-select>
            </el-form-item>
            <el-form-item label="手机号" prop="phone">
              <el-input v-model="registerForm.phone" placeholder="用于登录，一个手机号只能注册一次" maxlength="11" clearable />
            </el-form-item>
            <el-form-item label="密码" prop="password">
              <el-input
                v-model="registerForm.password"
                type="password"
                show-password
                placeholder="8–72 位"
              />
            </el-form-item>
            <el-form-item label="确认密码" prop="confirm">
              <el-input
                v-model="registerForm.confirm"
                type="password"
                show-password
                placeholder="请再次输入密码"
                @keyup.enter="handleRegister"
              />
            </el-form-item>
            <el-button
              type="primary"
              class="submit"
              :loading="registerLoading"
              @click="handleRegister"
            >
              注 册
            </el-button>
          </el-form>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </section>
</template>

<style scoped>
.auth-page {
  min-height: 60vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 48px 16px;
}
.auth-card {
  width: 100%;
  max-width: 460px;
}
.title {
  margin: 4px 0 6px;
  font-size: 20px;
  text-align: center;
  color: var(--zw-ink); /* QA-AM-11：品牌行不是「 sad 绿字」，墨色与全站 h1 同族 */
}
.subtitle {
  margin: 0 0 8px;
  font-size: 13px;
  text-align: center;
  color: var(--zw-muted); /* #888 → 令牌 */
}
.auth-tabs {
  margin-top: 8px;
}
.submit {
  width: 100%;
  margin-top: 4px;
}
.topics-select {
  width: 100%;
}
/* 手机窄屏：卡片贴边、去外层大留白 */
@media (max-width: 480px) {
  .auth-page {
    padding: 20px 10px;
  }
}
</style>
