/**
 * 问答凭证接口 —— 负责人：韶茹
 *
 * 本文件要提供的接口（详见 docs/接口约定.md）：
 *   POST /api/embed/token   前端来要临时钥匙
 *                           → 校验来源合法 → 调引擎换 30 分钟临时钥匙 → 返回
 *
 * 开关：REQUIRE_LOGIN_FOR_ASK（默认 false = 访客免登录可问）
 * 注意：长期凭证只放 .env，绝不返回给前端
 *
 * ⚠️ 当前状态（2026-10-21 · T6 墓碑代码清理核对结论：保留，不要当垃圾删）：
 *    本路由**没有任何子路由**，调 POST /api/embed/token 会落到全局 404「接口不存在」；
 *    问答链路早已改走 POST /api/ask（SSE，见 routes/ask.ts），本文件无任何调用方。
 *    这是「成规格但未实现」，不是一次性临时代码，处置依据见
 *    docs/墓碑代码清理清单-2026-10-10.md 第 92 行（结论：保留）。
 *
 *    若主控决定彻底砍掉 B08（问答钥匙），必须**三处同时改**，缺一处后端就起不来：
 *      ① 删本文件 backend/src/routes/embed.ts
 *      ② 摘 backend/src/index.ts:48 的 import 与 :108 的 app.use('/api/embed', embedRouter)
 *      ③ 一并处理 backend/src/weknora/index.ts 的 exchangeEmbedToken()（唯一调用方本应是本文件）
 *    契约缺口已在文档里写明：docs/接口约定.md:32 标了「尚未实现（仍是空壳，调用会 404）」，
 *    :1310 也标了「本项目的 /api/embed/token 仍是空壳」——主控若真删接口，再把这两行一并摘掉。
 */
import { Router } from 'express'

const router = Router()

// TODO(韶茹): 实现 token 交换

/**
 * 2026-10-23：空壳也要说人话。
 *
 * 以前这里没有任何子路由，`/api/embed/*` 会落到全局 404「接口不存在」——
 * 调用方分不清「路径写错」还是「功能没做」。现在明确回 501：
 * 接口成规格但未实现，问答请走 POST /api/ask。
 */
router.all('*', (req, res) => {
  res.status(501).json({
    success: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: '嵌入凭证接口尚未实现；问答请走 POST /api/ask',
      requestId: req.requestId
    }
  })
})

export default router
