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

import docsRouter from './routes/docs.js'
import authRouter from './routes/auth.js'
import embedRouter from './routes/embed.js'
import healthRouter from './routes/health.js'
import askRouter from './routes/ask.js' // 韶茹
import trackRouter from './routes/track.js' // 韶茹

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

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`)
})

export default app
