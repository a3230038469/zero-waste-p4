/**
 * 统一请求封装 —— 负责人：丁梓柔（B04）
 * 所有跟后端要数据的地方都走这里：统一 baseURL、统一带登录凭证、统一错误提示。
 * ⚠️ 前端只调自建后端（localhost:4000），绝不直接连引擎。
 */
import axios from 'axios'
import { ElMessage } from 'element-plus'

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE ?? 'http://localhost:4000',
  timeout: 20000
})

// 自动带登录凭证
http.interceptors.request.use((config) => {
  const token = localStorage.getItem('zwp.token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 统一错误提示
http.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg = err?.response?.data?.error?.message ?? err.message ?? '请求失败'
    ElMessage.error(msg)
    return Promise.reject(err)
  }
)

export default http
