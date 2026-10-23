/**
 * 统一错误处理 —— 2026-10-21 重写（契约 C6）
 *
 * 对外只给：{ code, message(公众中文), requestId }；
 * 内部细节（异常原文、堆栈、引擎地址）只写进服务端日志。
 *
 * 本文件另外提供两样东西：
 *   1. asyncHandler：Express 4 不接 async 处理器抛出的 rejection，
 *      不套它的话请求会挂住、不给响应（前端看着就是「转圈到超时」）。
 *   2. guardRouter：给一整个 router 的所有路由处理器统一补上兜底，
 *      免得每加一条 async 路由都要记得手写包装。
 */
import type { NextFunction, Request, Response, Router } from 'express'

import { errorEnvelope, normalizeErrorBody, requestIdOf, toPublicError } from '../errors/types.js'

/** 未匹配到任何路由 */
export function notFound(req: Request, res: Response): void {
  res.status(404).json(errorEnvelope('NOT_FOUND', '接口不存在', req))
}

/** 兜底错误处理：把异常翻译成对外口径，细节只进日志 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const pub = toPublicError(err)
  const requestId = requestIdOf(req)
  const line = `[error] ${requestId} ${req.method} ${req.originalUrl} -> ${pub.code} (${pub.status})`
  if (pub.status >= 500) {
    console.error(`${line}\n${pub.detail}`)
  } else {
    console.warn(`${line}: ${pub.detail.split('\n')[0] ?? ''}`)
  }
  if (res.headersSent) return
  res.status(pub.status).json(errorEnvelope(pub.code, pub.message, req))
}

export type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>

/**
 * async 路由处理器保护壳。
 * 用法：router.get('/x', asyncHandler(async (req, res) => { ... }))
 * 出错时交给末尾的 errorHandler 统一翻译，不再出现「请求挂死不回话」。
 */
export function asyncHandler(handler: AsyncHandler): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

/* ------------------------------------------------------------------ *
 * 全量兜底：给 router 里所有处理器补上 rejection 捕获
 * ------------------------------------------------------------------ *
 *
 * 为什么需要（验收项：任意 async 路由出错都要返回 5xx JSON，不能挂死）：
 *   Express 4 只有「handler 同步 throw」才会进错误中间件。
 *   async handler 里 await 失败时抛的是 **rejection**，Express 4 根本不看，
 *   请求就永远不结束 —— 前端只能等到 axios 超时，服务端连日志都没有。
 *
 * 为什么放在 middleware 而不是每条路由手写：
 *   后台路由有二十多条，漏一条就漏一个挂死的接口；
 *   而这些路由分属不同负责人（ask/chat/auth 是别人的文件），不能逐个去改。
 *   在 index.ts 挂载时统一套一层，谁的路由都被盖住。
 */

/** 处理器返回值是不是一个 Promise（thenable） */
function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

type AnyHandler = (...args: unknown[]) => unknown

/**
 * 包一层：同步 throw 与 async rejection 都会走到 next(err)。
 *
 * ⚠️ 必须保持原来的参数个数（fn.length）：
 *    Express 用「参数个数是否等于 4」来判断这是不是错误中间件，
 *    改成 rest 参数会把错误中间件误判成普通中间件（错误就没人接了）。
 */
function wrapHandler(handler: unknown): unknown {
  if (typeof handler !== 'function') return handler
  const fn = handler as AnyHandler
  const arity = fn.length
  if (arity >= 4) return handler // 错误中间件（4 个参数）保持原样

  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    let result: unknown
    try {
      result = fn.apply(this, args)
    } catch (err) {
      const next = args[2]
      if (typeof next === 'function') {
        const forward = next as (e: unknown) => void
        forward(err)
        return undefined
      }
      throw err
    }
    if (isThenable(result)) {
      Promise.resolve(result).catch((err: unknown) => {
        const next = args[2]
        if (typeof next === 'function') {
          const forward = next as (e: unknown) => void
          forward(err)
        }
      })
    }
    return result
  }

  // 把参数个数补回去（Express 靠它区分错误中间件）
  Object.defineProperty(wrapped, 'length', { value: arity, configurable: true })
  return wrapped
}

interface LayerLike {
  route?: { stack?: LayerLike[] }
  handle?: unknown
}

function wrapStack(stack: unknown): void {
  if (!Array.isArray(stack)) return
  for (const raw of stack) {
    const layer = raw as LayerLike
    if (layer.route) {
      // 路由层：处理器在 route.stack 里
      if (Array.isArray(layer.route.stack)) {
        for (const routeLayer of layer.route.stack) {
          routeLayer.handle = wrapHandler(routeLayer.handle)
        }
      }
      continue
    }
    // 挂载的子 router：继续往下钻
    // 注意：只能按 unknown 收窄后再断言；直接 typeof 判断会把类型收窄成 never
    const handle = layer.handle
    if (typeof handle === 'function') {
      const childStack = (handle as { stack?: unknown }).stack
      if (Array.isArray(childStack)) {
        wrapStack(childStack)
      }
    }
  }
}

/**
 * 给整个 router（含它内部挂载的子 router）套上 async 兜底。
 * 用法：guardRouter(someRouter) —— 必须在该 router 全部路由注册完之后调用。
 */
export function guardRouter(router: Router): Router {
  const stack = (router as unknown as { stack?: unknown }).stack
  wrapStack(stack)
  return router
}
/* ------------------------------------------------------------------ *
 * 错误信封统一收口（契约 C6）
 * ------------------------------------------------------------------ *
 *
 * 背景：后台/引擎相关路由有几十处各自 json({ success:false, error:{...} })，
 * 逐个改容易漏，而且以后新增路由还会再犯同样的毛病（把内部地址、引擎原文
 * 直接拼进 message 回给浏览器）。
 *
 * 这里在中间件层统一收口：
 *   - 补 requestId；
 *   - 引擎类错误码（ENGINE_*）的 message 换成固定的中文公众文案；
 *   - message 里带 URL / 堆栈痕迹的，换成通用中文；
 *   - detail 这类可能含引擎原文的字段不外发。
 * 原始内容照旧写进服务端日志。
 */
export function errorEnvelopeGuard(req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res)
  res.json = ((body: unknown) => {
    const normalized = normalizeErrorBody(body, req, res.statusCode)
    if (normalized !== body) {
      const err = (body as { error?: { message?: unknown } } | null)?.error
      const detail = typeof err?.message === 'string' ? err.message : ''
      if (detail) {
        console.warn(`[error] ${requestIdOf(req)} ${req.method} ${req.originalUrl}: ${detail}`)
      }
    }
    return originalJson(normalized)
  }) as Response['json']
  next()
}

