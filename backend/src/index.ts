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
 *
 * 追加记录（T5 后端安全与错误治理，2026-10-21）：本文件有四处改动，均为本任务契约要求：
 *   1) CORS 从 `origin: true`（反射任意来源）改成**站点白名单**（可用环境变量
 *      SITE_ORIGINS 覆盖，默认放行 localhost/127.0.0.1 的 4000 与 5173）。
 *   2) 新增 requestId 中间件：每个请求生成一个短 ID，写进 `req.requestId` 与响应头
 *      `X-Request-Id`，错误信封里的 requestId 就是它，方便对日志。
 *   3) 错误信封统一（契约 C6）：body 解析失败/体积超限也改用同一套
 *      { success:false, error:{ code, message, requestId } }。
 *   4) 新增 `GET /api/ai/status`（契约 C3，公开只读）：{ available, reason, messageZh }，
 *      探测逻辑与后台 selfcheck 复用同一份（见 routes/admin.ts 的 probeAiAvailability）。
 *   5) 不存在的路径改为真 404（契约「公-8」）：SPA 已知路由仍回首页，
 *      未知路径回 404 状态的首页壳（前端 NotFoundView 照常渲染，搜索引擎能读到 404）。
 *   6) 全部 router 统一套 guardRouter：Express 4 不接 async 处理器的 rejection，
 *      不套的话请求会挂死（验收项 P1-7）。要回退就删掉 guardRouter 那些行。
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
import adminRouter, { probeAiAvailability } from './routes/admin.js' // 本地演示：老师后台（管理资料）
import { adminContributionsRouter, contributionsRouter } from './routes/contributions.js' // B09：公众投稿与审核
import guestRouter from './routes/guest.js' // T11：游客权限的公开只读口径（GET /api/guest/permissions）
import overviewRouter from './routes/overview.js' // 对外展示站：整库数据概览
import feedbackRouter from './routes/feedback.js' // 对外展示站：访客反馈（2026-10-14）
import { adminSiteInfoRouter, siteInfoRouter } from './routes/site.js' // 管理台改造：站点信息（机构对外口径）
import adminModelsRouter from './routes/models.js' // 管理台：模型管理（2026-10-22）
import { asyncHandler, errorEnvelopeGuard, errorHandler, guardRouter, notFound } from './middleware/error.js' // 地基自带（2026-10-10 起真正挂上）
import { errorEnvelope, newRequestId } from './errors/types.js' // T5：统一错误信封（契约 C6）
import { GUEST_DEVICE_COOKIE, cookieValue, newGuestDeviceId } from './guest/ask-usage.js' // T5：设备标识 cookie（P2-2）
import { renderSpaHtml, siteOrigin } from './share/meta.js' // B09：分享卡片 meta 注入

// 配置来源：backend/.env（引擎密钥、数据源开关 DOCS_SOURCE 都从这里读）
dotenv.config()

const app = express()
const PORT = Number(process.env.PORT ?? 4000)

/* ------------------------------------------------------------------ *
 * T09：trust proxy 与 X-Powered-By
 * ------------------------------------------------------------------ *
 * 只有显式设置 TRUST_PROXY 环境变量时才开启 trust proxy：
 *   TRUST_PROXY=true   → app.set('trust proxy', 1)
 *   TRUST_PROXY=数字   → app.set('trust proxy', 数字)
 *   其他/未设置      → 不信任代理（默认），req.ip = 直连客户端 IP
 * 部署到 nginx 后**必须**设置 TRUST_PROXY=1（或对应的跳数），
 * 否则限流会把所有人当成同一个 IP；不设置时不能信任 XFF。
 * 关闭 X-Powered-By 响应头，减少指纹暴露。
 */
app.disable('x-powered-by')

const trustProxyRaw = (process.env.TRUST_PROXY ?? '').trim()
if (trustProxyRaw.length > 0) {
  if (trustProxyRaw === 'true') {
    app.set('trust proxy', 1)
  } else if (/^\d+$/.test(trustProxyRaw)) {
    app.set('trust proxy', Number(trustProxyRaw))
  } else {
    app.set('trust proxy', trustProxyRaw)
  }
}

/* ------------------------------------------------------------------ *
 * T5：站点白名单（替代原来的 origin: true）
 * ------------------------------------------------------------------ */
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]

/** 允许跨域访问的来源：环境变量 SITE_ORIGINS（逗号分隔）覆盖默认值 */
function allowedOrigins(): Set<string> {
  const raw = (process.env.SITE_ORIGINS ?? '').trim()
  const list = raw
    ? raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
    : DEFAULT_ALLOWED_ORIGINS
  return new Set(list)
}

const ALLOWED_ORIGINS = allowedOrigins()

app.use(
  cors({
    origin: (origin, callback) => {
      // 没有 Origin 头 = 同源请求或命令行工具（curl），放行
      if (!origin) {
        callback(null, true)
        return
      }
      if (ALLOWED_ORIGINS.has(origin)) {
        callback(null, true)
        return
      }
      // 不在白名单：不给 CORS 头（浏览器自己会拦掉），不报错也不落日志噪音
      callback(null, false)
    },
    credentials: true
  })
)

/* ------------------------------------------------------------------ *
 * T5：requestId（契约 C6）——每个请求一个短 ID，错误信封与响应头都带它
 * ------------------------------------------------------------------ */
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = newRequestId()
  req.requestId = requestId
  res.setHeader('X-Request-Id', requestId)
  next()
})

/* ------------------------------------------------------------------ *
 * T5：设备标识 cookie（契约 P2-2）
 * ------------------------------------------------------------------ *
 * 游客额度的指纹要用「IP + User-Agent + 随机设备 cookie」三个维度：
 * 只用前两个，同一单位出口 IP 的所有人共用额度、换个 UA 就能重置额度。
 * 这里给没有该 cookie 的请求发一个随机设备 ID，并挂到 req 上，
 * 让同一次请求内（算额度、写 cookie）用的是同一个 ID。
 * 生产环境 HTTPS 时请设置 COOKIE_SECURE=1，Set-Cookie 会带上 Secure 属性。
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const existing = cookieValue(req, GUEST_DEVICE_COOKIE)
  const deviceId = existing || newGuestDeviceId()
  req.guestDeviceId = deviceId
  if (!existing) {
    const cookieSecure = (process.env.COOKIE_SECURE ?? '').trim() === '1' ? '; Secure' : ''
    res.append(
      'Set-Cookie',
      `${GUEST_DEVICE_COOKIE}=${encodeURIComponent(deviceId)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${cookieSecure}`
    )
  }
  next()
})

/* ------------------------------------------------------------------ *
 * T5：错误信封统一收口（契约 C6）
 * ------------------------------------------------------------------ *
 * 后台/引擎相关路由有几十处各自 json({ success:false, error:{...} })，
 * 逐个改容易漏。在这里统一收口：补 requestId、引擎类错误码换成公众中文、
 * message 里带内部地址/堆栈的换成通用文案，detail 这类内部字段不外发。
 */
app.use(errorEnvelopeGuard)

app.use(express.json({ limit: '1mb' }))

/* ------------------------------------------------------------------ *
 * T5：body 解析失败 / 体积超限 → 同一套错误信封（带 requestId）
 * ------------------------------------------------------------------ */
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  const type = (err as { type?: string } | null)?.type
  if (err instanceof SyntaxError && type === 'entity.parse.failed') {
    res.status(400).json(errorEnvelope('VALIDATION_FAILED', '请求体不是合法的 JSON', req))
    return
  }
  if (type === 'entity.too.large') {
    res.status(413).json(errorEnvelope('PAYLOAD_TOO_LARGE', '一次提交的内容太多了，请分几次发', req))
    return
  }
  next(err)
})

// —— 健康检查
app.use('/health', healthRouter)
app.use('/api/docs', docsRouter)
app.use('/api/auth', authRouter)
app.use('/api/embed', embedRouter)
app.use('/api/ask', askRouter)
app.use('/api/chat', chatRouter)
app.use('/api/track', trackRouter)
app.use('/api/admin/contributions', adminContributionsRouter)
app.use('/api/admin/site-info', adminSiteInfoRouter)
app.use('/api/admin/models', adminModelsRouter)
app.use('/api/contributions', contributionsRouter)
app.use('/api/admin', adminRouter)
app.use('/api/guest', guestRouter)
app.use('/api/site-info', siteInfoRouter)
app.use('/api/overview', overviewRouter)
app.use('/api/feedback', feedbackRouter)

/**
 * T5：GET /api/ai/status（契约 C3，公开只读）
 * 返回 { available, reason, messageZh }：能不能用 AI 问答、为什么、给公众看的中文说明。
 * 不含任何内部地址（引擎/Ollama 的 IP 端口都不出现在响应里）。
 */
app.get(
  '/api/ai/status',
  asyncHandler(async (_req: Request, res: Response) => {
    const status = await probeAiAvailability()
    res.json(status)
  })
)

/* ------------------------------------------------------------------ *
 * T5：Express 4 的 async rejection 兜底（验收项 P1-7）
 * ------------------------------------------------------------------ *
 * 升级 Express 5 是破坏性改动，会牵连 ask/chat/auth 三条别人负责的路由线；
 * 这里改成给所有 router 统一套一层保护壳：async handler 抛错 → 进 errorHandler → 回
 * 5xx JSON，不会再出现「点一下没反应、服务端连日志都没有」的挂死。
 */
for (const router of [
  docsRouter,
  authRouter,
  embedRouter,
  healthRouter,
  askRouter,
  chatRouter,
  trackRouter,
  adminRouter,
  adminContributionsRouter,
  contributionsRouter,
  guestRouter,
  overviewRouter,
  feedbackRouter,
  adminSiteInfoRouter,
  adminModelsRouter,
  siteInfoRouter
]) {
  guardRouter(router)
}

/* ------------------------------------------------------------------ *
 * 前端静态资源 + SPA 回退
 * ------------------------------------------------------------------ */
const distDir = path.resolve(fileURLToPath(new URL('../../frontend/dist', import.meta.url)))
if (existsSync(distDir)) {
  app.use(express.static(distDir))

  /**
   * 已知的前端路由（与 frontend/src/router/index.ts 对齐）。
   * 命中 → 200 回首页；不命中 → 404 状态回首页壳（前端 NotFoundView 照常渲染，
   * 但搜索引擎/爬虫能读到 404，不再是「软 404」）。
   */
  const SPA_ROUTES: RegExp[] = [
    /^\/$/,
    /^\/shelf\/?$/,
    /^\/chat\/?$/,
    /^\/contribute\/?$/,
    /^\/doc\/[^/]+\/?$/,
    /^\/auth\/?$/,
    /^\/admin(\/.*)?$/
  ]

  app.get(/^(?!\/(api|health)).*/, async (req, res, next) => {
    if (req.method !== 'GET') return next()
    // 带文件后缀的（.js/.css/.png…）当资源请求：找不到就是 404，不回 HTML
    const lastSegment = req.path.slice(req.path.lastIndexOf('/') + 1)
    if (lastSegment.includes('.')) {
      next()
      return
    }
    const known = SPA_ROUTES.some((rule) => rule.test(req.path))
    try {
      const html = await renderSpaHtml(distDir, req.path, siteOrigin(req))
      if (html) {
        res.status(known ? 200 : 404).type('html').send(html)
        return
      }
    } catch {
      // 注入分享 meta 失败就回退到原样的 index.html（行为与改动前一致）
    }
    res.status(known ? 200 : 404).sendFile(path.join(distDir, 'index.html'))
  })
}

app.use(notFound)
app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`)
})

export default app
