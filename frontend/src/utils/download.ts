/**
 * 浏览器下载 & blob 错误解析 —— 公共小工具（2026-10-14 新增）
 *
 * 为什么单独抽出来：
 *   「资料下载」（api/docs.ts）和「数据导出」（api/admin.ts）要做同一件麻烦事 ——
 *   用 blob 方式请求，然后（a）触发浏览器下载、（b）把失败的响应体从二进制里读回中文提示。
 *   尤其 (b)：`responseType: 'blob'` 时 axios 会把错误体也当二进制，
 *   统一拦截器读 `err.response.data.error.message` 只会拿到 undefined，
 *   最后弹给用户的是 `Request failed with status code 403` 这种没法看的文案。
 *   这段逻辑不应该有第二份实现。
 *
 * ⚠️ 2026-10-21（task-20）：这里读出来的后端原文**不再**直接返回给用户 ——
 *    原文可能带内部引擎地址、英文堆栈。原文只进 console.warn；
 *    给操作者看的是前端本地固定中文（publicErrorText），
 *    想带原因时只取过了清洗的那份（publicErrorDetail）。
 */

import { publicErrorDetail, publicErrorText } from '../api/http'

/** 触发浏览器下载一个 Blob */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * 把「blob 方式请求失败」的响应翻译成**给操作者看的中文**。
 *
 * ⚠️ 2026-10-21（task-20）：后端原文**不再**直接返回 —— 原文可能带
 *    内部引擎地址、英文堆栈。原文只进 console.warn；展示的是前端本地
 *    固定中文（publicErrorText），带原因时只取过了清洗的那份（publicErrorDetail）。
 */
export async function describeBlobError(err: unknown, fallback: string): Promise<string> {
  const response = (err as { response?: { status?: number; data?: unknown } })?.response
  const status = typeof response?.status === 'number' ? response.status : 0
  let code = ''
  let message = ''
  const data = response?.data
  if (data instanceof Blob) {
    try {
      const text = await data.text()
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
      code = typeof parsed?.error?.code === 'string' ? parsed.error.code : ''
      message = typeof parsed?.error?.message === 'string' ? parsed.error.message : ''
    } catch {
      // 不是 JSON（可能真是二进制内容）—— 走下面的兜底
    }
  }
  if (message) console.warn('[download] blob 请求失败：', status || '-', code || '-', message)
  // 拼成 axios 形状，交给统一文案表翻译（后端原文只用来查错误码）
  const shaped = { response: { status, data: { error: { code, message } } } }
  const detail = publicErrorDetail(shaped)
  const base = publicErrorText(shaped, fallback)
  return detail ? `${base}（原因：${detail}）` : base
}
