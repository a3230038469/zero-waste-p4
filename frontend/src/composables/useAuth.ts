/**
 * 登录态组合式函数 —— 负责人：丁梓柔（B04）
 * 导航栏、登录注册页（B02）等共用同一份用户状态：
 *   - user：当前用户信息（null = 没取到用户信息，不代表一定没登录）
 *   - isLoggedIn：是否已登录 —— 只要本地有 token 就算已登录
 *   - fetchMe()：带 token 请求 GET /auth/me，未登录 / 接口未就绪时静默降级
 *   - setToken()：登录成功后保存 token
 *   - logout()：退出登录，清空本地凭证与用户信息
 */
import { computed, ref } from 'vue'
import http, { TOKEN_KEY } from '../api/http'
import type { CurrentUser } from '../api/types'

// 模块级单例：多个组件共享同一份登录态
const user = ref<CurrentUser | null>(null)

/** 登录态判定用的 token 存在标记。
 *  localStorage 本身不是响应式，故用这个 ref 镜像一份，setToken/logout 时同步。 */
const hasToken = ref<boolean>(localStorage.getItem(TOKEN_KEY) !== null)

/** 是否已登录：只认 token 在不在，不依赖 /auth/me 能不能取到用户信息。
 *  云端 /me 可能因为网关问题取不到用户信息，但登录本身是成功的，
 *  这时若把登录态判成「未登录」，用户看到的就是「登录了但什么都没变」。 */
const isLoggedIn = computed(() => hasToken.value)

export function useAuth() {
  /** 拉取当前登录用户；失败时静默降级（不弹错误提示、不清 token） */
  async function fetchMe(): Promise<void> {
    hasToken.value = localStorage.getItem(TOKEN_KEY) !== null
    if (!hasToken.value) {
      user.value = null
      return
    }
    try {
      const res = await http.get<CurrentUser>('/auth/me', { silent: true })
      user.value = res.data
    } catch {
      // 刻意不清 token：/me 失败只说明「用户信息取不到」，
      // 不代表凭证无效（云端网关吃 Authorization 头就是这种表现）。
      // 清了会把用户辛苦登录的态直接丢掉，正是「登录成功但像没反应」的成因。
      // isLoggedIn 仍为 true，导航栏会显示「已登录」，下载/预览门槛也放行。
      user.value = null
    }
  }

  /** 登录成功后调用：保存 token（随后可调 fetchMe 拉取用户信息） */
  function setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token)
    hasToken.value = true
  }

  /** 退出登录：清空本地凭证与用户信息 */
  function logout(): void {
    localStorage.removeItem(TOKEN_KEY)
    hasToken.value = false
    user.value = null
  }

  return { user, isLoggedIn, fetchMe, setToken, logout }
}
