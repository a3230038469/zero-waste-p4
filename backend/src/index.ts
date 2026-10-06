/**
 * 后端入口
 * 职责：启动 HTTP 服务、挂载各板块路由。
 *
 * ⚠️ 各板块负责人：不要在这里改别人的路由，只挂载自己的。
 */
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

import docsRouter from './routes/docs.js'
import authRouter from './routes/auth.js'
import embedRouter from './routes/embed.js'
import healthRouter from './routes/health.js'

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

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`)
})

export default app
