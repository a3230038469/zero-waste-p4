/**
 * 后端入口
 * 职责：启动 HTTP 服务、挂载各板块路由。
 *
 * ⚠️ 各板块负责人：不要在这里改别人的路由，只挂载自己的。
 *
 * 追加记录（韶茹，2026-10-07）：新增 /api/ask（SSE 流式问答）与 /api/track（埋点+看板）
 * 两条挂载，均未触碰已有路由的路径与行为。要回退就删掉带「韶茹」注释的两行。
 *
 * 追加记录（巡检，2026-10-10）：把地基自带的 middleware/error.ts 挂到路由链末尾
 * （此前从未挂载，未匹配路径回的是 HTML 404）。要回退就删掉 `app.use(notFound)` 与
 * `app.use(errorHandler)` 两行及其上方注释。
 *
 * 追加记录（B09 分享功能，2026-10-13）：SPA 回退从 sendFile 改为「按路径注入分享 meta
 * 再回 HTML」（见 src/share/meta.ts）。原因：微信/QQ 转发链接的抓取程序不执行 JS，
 * 纯 SPA 的 index.html 标题永远是站名，卡片没有信息量。注入失败时原样 sendFile 兜底，
 * 行为与改动前完全一致。要回退就把 `renderSpaHtml` 那段换回 `res.sendFile(...)` 一行。
 *
 * 追加记录（B09 公众上传，2026-10-13）：新增两条挂载 —— /api/contributions（投稿人侧，
 * 登录态）与 /api/admin/contributions（审核队列，X-Admin-Token）。均只新增，未触碰
 * 任何已有路由的路径与行为。要回退就删掉带「B09：公众投稿与审核」与「B09：审核队列」
 * 「B09：投稿」注释的三行 import / app.use。
 *
 * 追加记录（T11 游客权限，2026-10-14）：新增一条挂载 —— /api/guest（公开只读，
 * 游客开关的当前值，供公众页面决定要不要把按钮置灰）。只新增，未触碰任何已有路由。
 * 要回退就删掉带「T11」注释的 import 与 app.use 两行。
 *
 * 追加记录（管理台改造，2026-10-19）：管理侧鉴权从「共用口令 X-Admin-Token」换成
 * **管理员账号**（User.role === 'admin'，见 src/admin/guard.ts）；新增两条挂载 ——
 * /api/site-info（公开只读，站点对外口径）与 /api/admin/site-info（管理员写）。
 * 挂载顺序：`/api/admin/site-info` 必须在 `/api/admin` **之前**，否则会被老师后台
 * 那个 catch-all 风格的路由器先接走。要回退就删掉带「管理台改造」注释的 import
 * 与 app.use，并把 guard.ts 里的 requireAdminGuard 换回旧口令实现。
 *
 * 追加记录（管理台自测加固，2026-10-19）：`express.json()` 显式限 1MB，并在其后补一个
 * 只认「body 解析失败 / 体积超限」的错误中间件（400 / 413 + 中文），避免坏 body 变成
 * 500 INTERNAL_ERROR 并漏出英文解析原文。要回退就删掉那段 `app.use((err …))` 与 limit 参数。
 */
import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import docsRouter from './routes/docs.js'
import authRouter from './routes/auth.js'
import embedRouter from './routes/embed.js'
import healthRouter from './routes/health.js'
import askRouter from './routes/ask.js' // 韶茹
import chatRouter from './routes/chat.js' // 韶茹（T5：独立问答页的会话接口）
import trackRouter from './routes/track.js' // 韶茹
import adminRouter from './routes/admin.js' // 本地演示：老师后台（管理资料）
import { adminContributionsRouter, contributionsRouter } from './routes/contributions.js' // B09：公众投稿与审核
import guestRouter from './routes/guest.js' // T11：游客权限的公开只读口径（GET /api/guest/permissions）
import overviewRouter from './routes/overview.js' // 对外展示站：整库数据概览
import feedbackRouter from './routes/feedback.js' // 对外展示站：访客反馈（2026-10-14）
import { adminSiteInfoRouter, siteInfoRouter } from './routes/site.js' // 管理台改造：站点信息（机构对外口径）
import { errorHandler, notFound } from './middleware/error.js' // 地基自带（2026-10-10 起真正挂上）
import { renderSpaHtml, siteOrigin } from './share/meta.js' // B09：分享卡片 meta 注入

// 配置来源：backend/.env（引擎密钥、数据源开关 DOCS_SOURCE 都从这里读）
dotenv.config()

const app = express()
const PORT = Number(process.env.PORT ?? 4000)

app.use(cors({ origin: true, credentials: true }))
// 请求体上限显式写成 1MB：默认只有 100KB，而 POST /api/track 一次最多收 100 条事件、
// 每条 payload 上限 4000 字符 —— 一批大事件就会顶到默认上限被 413 掉（属于合法请求）。
app.use(express.json({ limit: '1mb' }))

/**
 * 请求体不是合法 JSON 时，`express.json()` 会抛 SyntaxError（type=entity.parse.failed）
 * 交给错误中间件；不拦的话它会一路走到末尾的 errorHandler，变成 **500 INTERNAL_ERROR**，
 * 还把英文解析原文（`Unterminated string in JSON at position 31`）漏给调用方。
 *
 * 对公开写入点（/api/feedback、/api/track）来说这是「客户端把 body 发坏了」，应当是 400 + 中文。
 * 只认 body 解析与体积这两类错误，其余错误一律 `next(err)` 交回末尾兜底 —— 不吞别的错。
 *
 * 2026-10-19（管理台改造期间自测发现）：`curl` 发一个转义坏掉的 JSON 就复现过。
 */
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const type = (err as { type?: string } | null)?.type
  if (err instanceof SyntaxError && type === 'entity.parse.failed') {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_FAILED', message: '请求体不是合法的 JSON' }
    })
    return
  }
  if (type === 'entity.too.large') {
    res.status(413).json({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: '一次提交的内容太多了，请分几次发' }
    })
    return
  }
  next(err)
})

// —— 健康检查
app.use('/health', healthRouter)

// —— 业务路由（按人分文件）
app.use('/api/docs', docsRouter) // 韶茹
app.use('/api/auth', authRouter) // 月月
app.use('/api/embed', embedRouter) // 韶茹
app.use('/api/ask', askRouter) // 韶茹（B07 问答窗口用）
app.use('/api/chat', chatRouter) // 韶茹（T5：/chat 页的会话增删查 + 带 conversationId 的接着聊）
app.use('/api/track', trackRouter) // 韶茹（埋点 + 看板）
// B09 公众上传（2026-10-13）：投稿人侧（登录态）与审核队列（管理员账号）分两条挂。
// 管理侧必须挂在 /api/admin 之前，避免与老师后台的其他 /api/admin/* 路由互相踩到。
// 管理台改造（2026-10-19）：/api/admin/site-info 同理，也必须排在 /api/admin 之前。
app.use('/api/admin/contributions', adminContributionsRouter) // B09：审核队列
app.use('/api/admin/site-info', adminSiteInfoRouter) // 管理台改造：机构信息（管理员写）
app.use('/api/contributions', contributionsRouter) // B09：投稿（提交 / 我的投稿）
app.use('/api/admin', adminRouter) // 本地演示：老师后台（管理资料）
app.use('/api/guest', guestRouter) // T11：游客权限（公开只读，给公众页面决定要不要置灰按钮）
app.use('/api/site-info', siteInfoRouter) // 管理台改造：站点对外口径（公开只读）
app.use('/api/overview', overviewRouter) // 对外展示站：整库数据概览（GET /api/overview）
app.use('/api/feedback', feedbackRouter) // 对外展示站：访客反馈（POST /api/feedback）

// —— 前端构建产物（存在才挂）。
// 本地开发时前端走 5173 的 dev server，这里不生效；
// 发布/公网演示时，前端构建后由后端统一对外 —— 一个端口就是整站。
const distDir = path.resolve(fileURLToPath(new URL('../../frontend/dist', import.meta.url)))
if (existsSync(distDir)) {
  app.use(express.static(distDir))
  // SPA 回退：非 /api、/health 的 GET 一律回 index.html（前端是 history 路由）。
  // 必须放在所有 API 路由之后，否则会截胡接口。
  //
  // B09（2026-10-13）：回 HTML 前按路径注入分享 meta（/doc/:id 注入资料级卡片，
  // 其他页面注入页面级默认）。任何异常都退回普通 sendFile —— 注入只是增强，
  // 绝不能因为 meta 找不到而把页面挂掉。
  app.get(/^(?!\/(api|health)).*/, async (req, res, next) => {
    if (req.method !== 'GET') return next()
    try {
      const html = await renderSpaHtml(distDir, req.path, siteOrigin(req))
      if (html) {
        res.type('html').send(html)
        return
      }
    } catch {
      // 落到下面的 sendFile 兜底
    }
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

// —— 未匹配路由 + 统一错误兜底
// `middleware/error.ts`（地基自带）此前**一直没有被挂载**：文件注释写着「任何错误都返回
// 统一 JSON 信封」，实际未匹配的路径回的是 Express 默认 HTML 404，前端拿到的不是契约信封。
// 2026-10-10 补挂。位置必须在 SPA 回退**之后**，否则会把前端路由当成 404 截掉。
app.use(notFound)
app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`)
})

export default app