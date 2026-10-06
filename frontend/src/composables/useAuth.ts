/**
 * 登录态组合式函数 —— 负责人：丁梓柔（B04）
 * 导航栏、登录注册页（B02）等共用同一份用户状态：
 *   - user：当前用户信息（null = 未登录）
 *   - fetchMe()：带 token 请求 GET /auth/me，未登录 / 接口未就绪时静默降级
 *   - setToken()：登录成功后保存 token
 *   - logout()：退出登录，清空本地凭证与用户信息
 */
import { ref } from 'vue'
import http, { TOKEN_KEY } from '../api/http'
import type { CurrentUser } from '../api/types'

// 模块级单例：多个组件共享同一份登录态
const user = ref<CurrentUser | null>(null)

export function useAuth() {
  /** 拉取当前登录用户；失败时静默置为未登录态（不弹错误提示） */
  async function fetchMe(): Promise<void> {
    if (!localStorage.getItem(TOKEN_KEY)) {
      user.value = null
      return
    }
    try {
      const res = await http.get<CurrentUser>('/auth/me', { silent: true })
      user.value = res.data
    } catch {
      // token 失效或后端接口未就绪：按未登录处理
      user.value = null
    }
  }

  /** 登录成功后调用：保存 token（随后可调 fetchMe 拉取用户信息） */
  function setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token)
  }

  /** 退出登录：清空本地凭证与用户信息 */
  function logout(): void {
    localStorage.removeItem(TOKEN_KEY)
    user.value = null
  }

  return { user, fetchMe, setToken, logout }
}
