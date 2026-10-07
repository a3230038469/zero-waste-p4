/**
 * 用户接口封装 —— 负责人：月月（B02）
 * 路径不带 /api 前缀（http.ts 的 baseURL 已含）；字段名照 docs/接口约定.md。
 */
import http from './http'
import type { CurrentUser } from './types'

/** 注册入参（五个字段 + 密码，字段名照契约） */
export interface RegisterPayload {
  name: string
  org: string
  occupation: string
  topics: string[]
  phone: string
  password: string
}

/** 登录入参 */
export interface LoginPayload {
  phone: string
  password: string
}

/** 注册：成功后端返回 201 + { user } */
export async function register(payload: RegisterPayload): Promise<CurrentUser> {
  const res = await http.post<{ user: CurrentUser }>('/auth/register', payload)
  return res.data.user
}

/** 登录：成功返回 { token }（由调用方经 useAuth().setToken 保存） */
export async function login(payload: LoginPayload): Promise<string> {
  const res = await http.post<{ token: string }>('/auth/login', payload)
  return res.data.token
}
