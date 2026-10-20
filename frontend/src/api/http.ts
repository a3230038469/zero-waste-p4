/**
 * 统一请求封装 —— 负责人：丁梓柔（B04）
 * 所有跟后端要数据的地方都走这里：统一 baseURL、统一带登录凭证、统一错误提示。
 * ⚠️ 前端只调自建后端（localhost:4000），绝不直接连引擎。
 *
 * 调用方式：http.get('/docs')、http.post('/auth/login', body)……
 * 路径不带 /api 前缀（baseURL 已含）。
 */
import axios from 'axios'
import { ElMessage } from 'element-plus'

/** token 在 localStorage 的键名（B02 登录成功后也用这个键写入） */
export const TOKEN_KEY = 'zwp.token'

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 静默请求：失败时不弹全局错误提示（用于登录态探测等场景） */
    silent?: boolean
  }
}

const http = axios.create({
  // 接口前缀统一见 docs/接口约定.md：所有业务接口都在 /api 下
  baseURL: import.meta.env.VITE_API_BASE ?? 'http://localhost:4000/api',
  timeout: 20000
})

// 请求拦截：自动带上登录凭证
http.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 响应拦截：统一错误 toast 提示
//
// 同一句话在 1.2s 内只弹一次：一个页面常常并发两三个请求（列表 + 筛选项计数），
// 后端一挂就同时失败，不去重会连弹两三条一模一样的红条，看着像连出三次错。
// 页面自己有错误态卡片的，请在请求上带 `silent: true`，交给页面渲染。
const DEDUPE_MS = 1200
let lastMsg = ''
let lastAt = 0

http.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg = err?.response?.data?.error?.message ?? err.message ?? '请求失败'
    const now = Date.now()
    const shouldToast = msg !== lastMsg || now - lastAt > DEDUPE_MS
    if (!err.config?.silent && shouldToast) {
      ElMessage.error(msg)
      lastMsg = msg
      lastAt = now
    }
    return Promise.reject(err)
  }
)

export default http
