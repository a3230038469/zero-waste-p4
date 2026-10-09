/**
 * 后端入口
 * 职责：启动 HTTP 服务、挂载各板块路由。
 *
 * ⚠️ 各板块负责人：不要在这里改别人的路由，只挂载自己的。
 *
 * 追加记录（韶茹，2026-10-07）：新增 /api/ask（SSE 流式问答）与 /api/track（埋点+看板）
 * 两条挂载，均未触碰已有路由的路径与行为。要回退就删掉带「韶茹」注释的两行。
 */
import express from 'express'
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
import trackRouter from './routes/track.js' // 韶茹
import adminRouter from './routes/admin.js' // 本地演示：老师后台（管理资料）

// 配置来源：backend/.env（引擎密钥、数据源开关 DOCS_SOURCE 都从这里读）
dotenv.config()

const app = express()
const PORT = Number(process.env.PORT ?? 4000)

app.use(cors({ origin: true, credentials: true }))
app.use(express.json())

// —— 健康检查
app.use('/health', healthRouter)

// —— 业务路由（按人分文件）
app.use('/api/docs', docsRouter) // 韶茹
app.use('/api/auth', authRouter) // 月月
app.use('/api/embed', embedRouter) // 韶茹
app.use('/api/ask', askRouter) // 韶茹（B07 问答窗口用）
app.use('/api/track', trackRouter) // 韶茹（埋点 + 看板）
app.use('/api/admin', adminRouter) // 本地演示：老师后台（管理资料）

// —— 前端构建产物（存在才挂）。
// 本地开发时前端走 5173 的 dev server，这里不生效；
// 发布/公网演示时，前端构建后由后端统一对外 —— 一个端口就是整站。
const distDir = path.resolve(fileURLToPath(new URL('../../frontend/dist', import.meta.url)))
if (existsSync(distDir)) {
  app.use(express.static(distDir))
  // SPA 回退：非 /api、/health 的 GET 一律回 index.html（前端是 history 路由）。
  // 必须放在所有 API 路由之后，否则会截胡接口。
  app.get(/^(?!\/(api|health)).*/, (req, res, next) => {
    if (req.method !== 'GET') return next()
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`)
})

export default app
