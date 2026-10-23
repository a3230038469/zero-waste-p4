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

/* ---------------------------------------------------------------------------
 * 面向公众的错误文案（2026-10-21 · task-18 B-1）
 *
 * 背景：原来响应拦截器把后端返回的 message 原样弹给用户。后端 message 里会带上
 * 内部引擎地址（实测出现过 http://127.0.0.1:8081 这类），对公众没有意义，
 * 也不该出现在页面上。
 *
 * 规矩（以后照这个做）：
 *   1. toast 一律用**前端本地固定中文**，不透传后端原文；
 *   2. 后端原文只进 console.warn，方便排查；
 *   3. 确实要把后端原因给操作者看，必须先过 sanitizePublicMessage 清洗
 *      （拒 URL / IP / 端口 / 英文堆栈 / 超过 60 字），过不了就不显示。
 * ------------------------------------------------------------------------- */

/**
 * 后端错误码 → 面向公众的固定中文。
 *
 * 白名单：只有登记在这里的错误码才允许有自己的说法；没登记的一律走状态码兜底。
 */
const PUBLIC_ERROR_BY_CODE: Record<string, string> = {
  ADMIN_LOGIN_REQUIRED: '请先用管理员账号登录。',
  ADMIN_FORBIDDEN: '当前账号不是管理员，没有权限做这个操作。',
  AUTH_RATE_LIMITED: '尝试太频繁了，请过一会儿再试。',
  DOC_NOT_FOUND: '这份资料不存在，可能已下架，或者链接有误。',
  GUEST_DOWNLOAD_CLOSED: '下载原件需要先登录。',
  NOT_FOUND: '没找到对应的内容。',
  RATE_LIMITED: '操作太频繁了，请稍后再试。',
  VALIDATION_FAILED: '提交的内容没通过校验，请检查后重试。'
}

/** HTTP 状态码 → 面向公众的固定中文 */
const PUBLIC_ERROR_BY_STATUS: Record<number, string> = {
  400: '请求内容不太对，请检查后重试。',
  401: '登录没通过：手机号或密码不对，或者登录已过期，请重新登录后再试。',
  403: '当前账号没有权限做这个操作。',
  404: '没找到对应的内容。',
  409: '这个信息跟已有记录冲突了（比如手机号已注册），请检查后再试。',
  413: '文件太大，超出了限制。',
  422: '提交的内容没通过校验，请检查后重试。',
  429: '操作太频繁了，请稍后再试。',
  500: '服务器出错了，请稍后再试。',
  502: '服务器暂时出了点问题，请稍后再试。',
  503: '服务暂时不可用，请稍后再试。',
  504: '请求超时，请稍后再试。'
}

/** 后端错误信封里的状态码 / 错误码 / 原文（不保证存在） */
function readErrorEnvelope(err: unknown): {
  status: number
  code: string
  message: string
} {
  const response = (
    err as {
      response?: { status?: number; data?: { error?: { code?: string; message?: string } } }
    }
  ).response
  const envelope = response?.data?.error
  return {
    status: typeof response?.status === 'number' ? response.status : 0,
    code: typeof envelope?.code === 'string' ? envelope.code : '',
    message: typeof envelope?.message === 'string' ? envelope.message : ''
  }
}

/**
 * 把后端原文过一道「面向公众」的清洗：
 * 拒掉 URL（含内部引擎地址）、IP、端口、英文堆栈、超过 60 字的整段话。
 *
 * 合格才返回原文；不合格返回 null —— 调用方必须换成本地固定中文。
 */
export function sanitizePublicMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text || text.length > 60) return null
  if (/https?:\/\//i.test(text)) return null
  if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(text)) return null
  if (/:\d{2,5}\b/.test(text)) return null
  if (/[A-Za-z]{6,}/.test(text)) return null
  if (!/[\u4e00-\u9fa5]/.test(text)) return null
  return text
}

/**
 * 面向公众的错误文案：任何情况下都只给**本地固定中文**，不端后端原文。
 *
 * 思路沿用 api/docs.ts 的 describeDocDetailError：把「读不出来」分成几种情况，
 * 但绝不让内部地址、端口、英文堆栈跑到用户眼前。
 */
export function publicErrorText(err: unknown, fallback = '操作没成功，请稍后再试。'): string {
  const { status, code } = readErrorEnvelope(err)
  if (code && PUBLIC_ERROR_BY_CODE[code]) return PUBLIC_ERROR_BY_CODE[code]
  if (status > 0 && PUBLIC_ERROR_BY_STATUS[status]) return PUBLIC_ERROR_BY_STATUS[status]
  if (status === 0) return '连不上服务器，请检查网络后重试。'
  return fallback
}

/**
 * 后端原文（已清洗）—— 只在「确实需要给操作者看原因」的地方用，
 * 比如管理员后台的入库失败提示；不合格（带地址、英文堆栈）就返回 null。
 */
export function publicErrorDetail(err: unknown): string | null {
  return sanitizePublicMessage(readErrorEnvelope(err).message)
}

const http = axios.create({
  // 接口前缀统一见 docs/接口约定.md：所有业务接口都在 /api 下
  //
  // ⚠️ 2026-10-21（T3 · P2-12）：回落地址**不再写死 localhost:4000**。
  //   之前写死，本地换个端口/部署到别的域名就全挂；现在回落成**同源 /api**
  //   （生产构建 .env.production 里 VITE_API_BASE=/api，前后台同源部署）。
  //   开发态 vite dev server（5173）用 vite.config.ts 里的 server.proxy 转发到 4000，
  //   所以同源写法在开发与生产都成立。
  baseURL: import.meta.env.VITE_API_BASE ?? '/api',
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
// ⚠️ 2026-10-21（task-18 B-1）：文案一律用**前端本地固定中文**，
//   不再把后端 message 原样弹给用户（那里面可能带内部引擎地址 / 端口 / 英文堆栈）。
//   后端原文只进 console.warn；silent 请求仍然不弹 toast。
http.interceptors.response.use(
  (res) => res,
  (err) => {
    const { status, code, message } = readErrorEnvelope(err)
    if (message) {
      console.warn('[http] 请求失败：', status || '-', code || '-', message)
    }
    if (!err.config?.silent) {
      ElMessage.error(publicErrorText(err))
    }
    return Promise.reject(err)
  }
)

export default http
