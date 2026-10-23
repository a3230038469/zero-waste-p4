/**
 * 登录态组合式函数 —— 负责人：丁梓柔（B04）
 * 导航栏、登录注册页（B02）等共用同一份用户状态：
 *   - user：当前用户信息（null = 没取到用户信息，不代表一定没登录）
 *   - isLoggedIn：是否已登录 —— 只要本地有 token 就算已登录
 *   - fetchMe()：带 token 请求 GET /auth/me，未登录 / 接口未就绪时静默降级
 *   - setToken()：登录成功后保存 token
 *   - logout()：退出登录 —— 先让服务端清掉登录 cookie，再清空本地凭证与用户信息
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

/**
 * 是不是管理员（2026-10-19 管理台改造加）。
 * 只看 `/auth/me` 返回的 role —— 它只用来决定「管理台入口显不显示」，
 * **不构成任何权限**：真正的拦截在后端每个管理接口上（requireAdminGuard）。
 * 所以这里为 false 时别去猜、也别把它当安全边界。
 */
const isAdmin = computed(() => user.value?.role === 'admin')

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

  /**
   * 直接写入当前用户（2026-10-19 加，配合 PATCH /auth/me）：
   * 资料改完后端会把**更新后的用户对象**回给前端，用它覆盖本地状态即可，
   * 不用再打一次 /auth/me（省一次请求，也避免两次数据短暂不一致）。
   */
  function setUser(next: CurrentUser | null): void {
    user.value = next
  }

  /**
   * 退出登录：打服务端把登录 cookie 清掉，同时清空本地凭证与用户信息。
   *
   * ⚠️ 为什么要多打一次服务端（2026-10-21 · C2）：
   *    以前只清 localStorage，浏览器的 zwp_token cookie 还留着，
   *    后端仍认为「已登录」—— 游客每天 5 次的提问额度就这么被绕过去了
   *    （登录一次就能无限问，退出也不算数）。
   *
   * 顺序：先把请求发出去，再同步清本地。
   *   - 本地同步清：调用方就算没 await（导航栏/管理台那两处旧调用），
   *     退出登录也立刻生效，不会卡在「看着还登录着」；
   *   - await 本函数：等服务端把 cookie 清掉再发下一个请求，
   *     否则紧接着的那一枪还带着旧登录态。
   */
  async function logout(): Promise<void> {
    const cookieCleared = http.post('/auth/logout', undefined, { silent: true }).catch(() => undefined)
    localStorage.removeItem(TOKEN_KEY)
    hasToken.value = false
    user.value = null
    await cookieCleared
  }

  return { user, isLoggedIn, isAdmin, fetchMe, setToken, setUser, logout }
}
