/**
 * 统一错误处理 —— 地基自带，可复用
 * 目标：任何错误都返回统一 JSON 信封，不泄露内部报错原文
 *   { "success": false, "error": { "code": "...", "message": "..." } }
 */
import type { NextFunction, Request, Response } from 'express'

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: '接口不存在' }
  })
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const message = err instanceof Error ? err.message : '服务器内部错误'
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message }
  })
}
