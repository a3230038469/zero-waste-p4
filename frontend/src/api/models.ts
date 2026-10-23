/**
 * 模型管理接口（管理台）—— 2026-10-22 新增
 *
 *   GET    /api/admin/models              列表 + 厂商目录 + 在用标记
 *   POST   /api/admin/models              新建（对话 / 视觉 / 重排）
 *   PUT    /api/admin/models/:id          改展示名 / 地址
 *   PUT    /api/admin/models/:id/key      只换 API Key
 *   POST   /api/admin/models/:id/test     模型测试（会消耗一次厂商额度）
 *   DELETE /api/admin/models/:id          删除
 *
 * 密钥只往上传，任何响应都不回显（引擎只回「已配置 / 未配置」）。
 * 契约见 docs/接口约定.md 第三节「模型管理」。
 */
import http from './http'

export type ModelGroup = 'chat' | 'vision' | 'rerank' | 'embedding' | 'other'

/** 一张模型卡 */
export interface AdminModelItem {
  id: string
  /** 引擎里的模型名（调厂商时用的那个） */
  name: string
  displayName: string
  /** 引擎原值：KnowledgeQA / VLLM / Rerank / Embedding */
  type: string
  group: ModelGroup
  provider: string
  providerLabel: string
  baseUrl: string
  keyConfigured: boolean
  isBuiltin: boolean
  status: string
  contextWindow: number
  dimension: number
  /** 正在被谁用：['问答模型'] / [] */
  inUse: string[]
  /** 能不能在这里改 / 删（内置、向量模型都是 false） */
  editable: boolean
}

export interface ModelProviderOption {
  value: string
  label: string
  description: string
  /** 引擎的类型 → 默认地址（chat / vllm / rerank / embedding） */
  defaultUrls: Record<string, string>
  modelTypes: string[]
}

export interface ModelAdminView {
  success: boolean
  models: AdminModelItem[]
  providers: ModelProviderOption[]
  providersError: string
  bindingsError: string
}

export interface CreateModelPayload {
  /** chat / vision / rerank */
  group: 'chat' | 'vision' | 'rerank'
  name: string
  displayName: string
  provider: string
  baseUrl: string
  apiKey: string
  contextWindow: number
}

export interface ModelTestResult {
  success: boolean
  ok: boolean
  elapsedMs: number
  /** 成功时的一句话结论（回答开头 / 向量维度） */
  summary: string
  /** 失败原因（引擎或厂商原文） */
  error: string
}

export async function fetchModelAdminView(): Promise<ModelAdminView> {
  const res = await http.get<ModelAdminView>('/admin/models')
  return res.data
}

export async function createModel(payload: CreateModelPayload): Promise<string> {
  const res = await http.post<{ success: boolean; id: string }>('/admin/models', payload)
  return res.data.id
}

export async function updateModel(
  id: string,
  patch: { displayName?: string; baseUrl?: string }
): Promise<void> {
  await http.put(`/admin/models/${encodeURIComponent(id)}`, patch)
}

export async function updateModelKey(id: string, apiKey: string): Promise<void> {
  await http.put(`/admin/models/${encodeURIComponent(id)}/key`, { apiKey })
}

export async function testModel(id: string, input = ''): Promise<ModelTestResult> {
  const res = await http.post<ModelTestResult>(`/admin/models/${encodeURIComponent(id)}/test`, {
    input
  })
  return res.data
}

export async function deleteModel(id: string): Promise<void> {
  await http.delete(`/admin/models/${encodeURIComponent(id)}`)
}
