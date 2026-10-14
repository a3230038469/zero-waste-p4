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
 */

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
 * 把「blob 方式请求失败」的响应还原成后端给的中文提示。
 * 拿不到就退回 fallback（一句人话），绝不把 axios 的英文原文抛给用户。
 */
export async function describeBlobError(err: unknown, fallback: string): Promise<string> {
  const data = (err as { response?: { data?: unknown } })?.response?.data
  if (data instanceof Blob) {
    try {
      const text = await data.text()
      const parsed = JSON.parse(text) as { error?: { message?: string } }
      const message = parsed?.error?.message
      if (typeof message === 'string' && message.trim()) return message
    } catch {
      // 不是 JSON（可能真是二进制内容）—— 走下面的兜底
    }
  }
  return fallback
}
