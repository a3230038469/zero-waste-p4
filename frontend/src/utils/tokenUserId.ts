/**
 * 从登录 token 里取用户 id —— T11（埋点带上账号的前端半边）
 *
 * 口径真相在后端：`routes/auth.ts` 签发的 JWT 用 `sub` 存 `user.id`，
 * 这里只**读**、不校验（前端校验没有安全意义，权当取不到处理）。
 *
 * ⚠️ 为什么不直接用 `useAuth().user.id`：
 *   那个 ref 要等 `GET /auth/me` 回来才有值。刚登录完就切页面时，
 *   `page_view` 会先发出去 → 那一条又成了「游客」。埋点是在**唯一出口**
 *   （`api/track.ts`）注入的，那里没有 Vue 上下文，只能读 token。
 *   结果一致：两处拿的都是 `sub` = 同一个 user.id。
 *
 * 🔴 拿不到就返回 null（未登录 / token 坏了 / 不是本项目签的）。
 *    绝不猜一个 id 填上去 —— 编出来的 id 会把统计口径彻底带歪。
 *
 * 本文件**不依赖 localStorage 的键名**（`zwp.token` 由 api/http.ts 的 TOKEN_KEY 独家持有），
 * 调用方传 token 进来；所以它是一个纯函数模块，能脱离浏览器单测。
 */

/** base64url 解码成 UTF-8 文本（atob 只认标准 base64，且不吃缺 padding 的） */
function decodeBase64Url(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

/** 从一段 JWT 里取 `sub`（用户 id）；不是合法 JWT / 没有 sub / 解析失败 → null */
export function userIdFromToken(token: string | null | undefined): string | null {
  if (!token) return null
  try {
    const segment = token.split('.')[1]
    if (!segment) return null
    const payload: unknown = JSON.parse(decodeBase64Url(segment))
    if (typeof payload !== 'object' || payload === null) return null
    const sub = (payload as { sub?: unknown }).sub
    return typeof sub === 'string' && sub.trim() ? sub : null
  } catch {
    return null
  }
}