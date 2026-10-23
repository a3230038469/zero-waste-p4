/**
 * 统一错误信封与对外口径 —— T5（2026-10-21 新增）
 *
 * 契约 C6：任何失败都返回
 *   { success: false, error: { code, message, requestId } }
 *   - code     稳定的机器可读错误码（前端可按码分支，不要解析 message）
 *   - message  **只面向公众的中文**：不出现内部地址、引擎原文、英文堆栈
 *   - requestId 本次请求的追踪号，同时写进响应头 X-Request-Id；报障时直接报这个号
 *
 * 分层原则（对外 / 对内分离）：
 *   对外 = errorEnvelope(...)：只有 code + 公众文案 + requestId
 *   对内 = detail：异常原文、堆栈、内部地址 —— 只进服务端日志，永远不进响应体
 */
import { randomUUID } from 'node:crypto'

export interface PublicError {
  /** HTTP 状态码 */
  status: number
  /** 稳定的机器可读错误码 */
  code: string
  /** 面向公众的中文文案（不含任何内部细节） */
  message: string
  /** 内部细节，只写日志 */
  detail: string
}

export interface ErrorEnvelope {
  success: false
  error: {
    code: string
    message: string
    requestId: string
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** 本次请求的追踪号（由 src/index.ts 的 requestId 中间件写入） */
      requestId?: string
    }
  }
}

/** 生成一次请求的追踪号（16 位十六进制，够短好抄写） */
export function newRequestId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

/** 取本次请求的追踪号（没有中间件时退回空串，不报错） */
export function requestIdOf(req: { requestId?: string } | undefined): string {
  return req?.requestId ?? ''
}

/**
 * 统一的错误响应体 —— 全站只有这一处拼信封。
 * 任何地方要回错误，都用这个函数，不要自己 json({ success:false, error:{...} })。
 */
export function errorEnvelope(code: string, message: string, req?: { requestId?: string }): ErrorEnvelope {
  return {
    success: false,
    error: { code, message, requestId: requestIdOf(req) }
  }
}

/**
 * 已知错误码的对外口径表。
 * 键是错误码，值是「对外状态码 + 公众文案」。表里没有的码走下面的兜底逻辑。
 */
const PUBLIC_MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: '接口不存在' },
  DOC_NOT_FOUND: { status: 404, message: '这份资料不存在或已被删除' },
  ENGINE_UNAVAILABLE: { status: 502, message: '资料库引擎暂时不可用，请稍后重试' },
  ENGINE_NOT_CONFIGURED: { status: 503, message: '资料库引擎还没配置好，请稍后重试' },
  ENGINE_UNAUTHORIZED: { status: 502, message: '资料库引擎暂时不可用，请稍后重试' },
  ENGINE_NOT_FOUND: { status: 404, message: '没有找到对应的内容' },
  INTERNAL_ERROR: { status: 500, message: '服务器出了点问题，请稍后重试' },
  VALIDATION_FAILED: { status: 400, message: '请求内容格式不对，请检查后重试' },
  PAYLOAD_TOO_LARGE: { status: 413, message: '一次提交的内容太多了，请分几次发' },
  CONTRIBUTION_STORE_UNAVAILABLE: { status: 500, message: '投稿数据暂时读不出来，请稍后重试' }
}

/** 引擎类错误码统一对外成 502 ENGINE_UNAVAILABLE（契约 C6） */
function isEngineCode(code: string): boolean {
  return code.startsWith('ENGINE_')
}

interface CodedError {
  code: string
  status: number
}

function isCodedError(err: unknown): err is Error & CodedError {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  const status = (err as { status?: unknown }).status
  return typeof code === 'string' && code.length > 0 && typeof status === 'number'
}

/**
 * 把任意异常翻译成「对外口径」。
 * 内部细节（异常原文、堆栈）一律进 detail，由调用方写日志，不进响应体。
 */
export function toPublicError(err: unknown): PublicError {
  if (isCodedError(err)) {
    const code = err.code
    const detail = err.stack || err.message

    if (code === 'DOC_NOT_FOUND') {
      return { status: 404, code, message: PUBLIC_MESSAGES.DOC_NOT_FOUND.message, detail }
    }
    if (code === 'ENGINE_NOT_CONFIGURED') {
      return { status: 503, code, message: PUBLIC_MESSAGES.ENGINE_NOT_CONFIGURED.message, detail }
    }
    if (code === 'ENGINE_NOT_FOUND') {
      return { status: 404, code, message: PUBLIC_MESSAGES.ENGINE_NOT_FOUND.message, detail }
    }
    if (isEngineCode(code)) {
      // 引擎故障（连不上、超时、返回异常、鉴权失败）对外一律 502 ENGINE_UNAVAILABLE，
      // 内部 URL / 引擎原文只留在 detail 里。
      return { status: 502, code: 'ENGINE_UNAVAILABLE', message: PUBLIC_MESSAGES.ENGINE_UNAVAILABLE.message, detail }
    }

    const known = PUBLIC_MESSAGES[code]
    if (known) {
      return { status: known.status, code, message: known.message, detail }
    }

    const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500
    return { status, code, message: '请求没能完成，请稍后重试', detail }
  }

  const detail = err instanceof Error ? (err.stack || err.message) : String(err)
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: PUBLIC_MESSAGES.INTERNAL_ERROR.message,
    detail
  }
}
/* ------------------------------------------------------------------ *
 * 响应体统一规整（T5 追加）
 * ------------------------------------------------------------------ *
 *
 * 为什么还要这一层：
 *   契约 C6 要求「所有失败都长成 { success:false, error:{ code, message, requestId } }」。
 *   后台/引擎相关的路由有几十处各自 json({ success:false, error:{...} })，
 *   逐个改容易漏，而且以后新增路由还会再犯。
 *   所以在中间件里统一收口：成功失败都过一遍，
 *   - 补上 requestId（前端报障时能直接报这个号）
 *   - 引擎类错误码（ENGINE_*）的 message 换成公众文案，内部地址不外泄
 *   - message 里带 URL / 堆栈的，换成通用中文
 *   - 多余字段（detail 等可能含引擎原文）不外发
 *   原始内容写进服务端日志。
 */

/** 内部地址 / 堆栈的痕迹：出现即视为「不该给公众看」 */
const INTERNAL_LEAK_RE = /https?:\/\/|localhost|127\.0\.0\.1|\b0\.0\.0\.0\b|at [A-Za-z_$][\w$]*\s*\(|Error:|\n\s*at\s/i

/** 引擎类错误码的对外统一文案 */
export const ENGINE_PUBLIC_MESSAGE = '资料库引擎暂时不可用，请稍后重试'

/** 判断一个错误码是不是引擎类 */
export function isEngineErrorCode(code: string): boolean {
  return code.startsWith('ENGINE_')
}

/**
 * 把一条对外错误 message 收拾干净：
 *   - 引擎类错误码 → 固定文案（内部 URL、引擎原文都不出现）
 *   - message 里带内部地址 / 堆栈痕迹 → 通用中文
 *   - 其余保持原样（这些都是我们自己写的中文）
 */
export function publicMessageFor(code: string, message: string, status: number): string {
  if (isEngineErrorCode(code)) {
    if (code === 'ENGINE_NOT_CONFIGURED') return PUBLIC_MESSAGES.ENGINE_NOT_CONFIGURED.message
    if (code === 'ENGINE_NOT_FOUND') return PUBLIC_MESSAGES.ENGINE_NOT_FOUND.message
    return ENGINE_PUBLIC_MESSAGE
  }
  if (INTERNAL_LEAK_RE.test(message)) {
    return status >= 500
      ? PUBLIC_MESSAGES.INTERNAL_ERROR.message
      : '请求没能完成，请稍后重试'
  }
  return message
}

/**
 * 统一规整错误响应体。
 * 返回 undefined 表示这不是错误响应体，不用动。
 *
 * 兼容三种输入形状：
 *   1. 扁平 {code,message}（无 success 字段）→ 转成 {success:false,error:{code,message,requestId}}
 *   2. {success:false,type:'error',content} → 保留 type/content，并补 error:{code:'ASK_ERROR',message:content} 与 requestId
 *   3. 原有 {success:false,error:{...}} 行为不变
 */
export function normalizeErrorBody(
  body: unknown,
  req: { requestId?: string } | undefined,
  status = 0
): unknown {
  if (typeof body !== 'object' || body === null) return body
  const record = body as Record<string, unknown>

  // --- 形状1：扁平 {code,message}（没有 success 字段）---
  if (
    typeof record['code'] === 'string' &&
    typeof record['message'] === 'string' &&
    record['success'] !== false
  ) {
    return {
      success: false,
      error: { code: record['code'], message: publicMessageFor(record['code'], record['message'], status), requestId: requestIdOf(req) }
    }
  }

  // --- 形状2：{success:false,type:'error',content} ---
  if (record['success'] === false && record['type'] === 'error' && typeof record['content'] === 'string') {
    const existingError =
      typeof record['error'] === 'object' && record['error'] !== null
        ? (record['error'] as Record<string, unknown>)
        : null
    const rawCode =
      typeof existingError?.['code'] === 'string' && existingError['code'] ? existingError['code'] : 'ASK_ERROR'
    const rawMessage =
      typeof existingError?.['message'] === 'string' ? existingError['message'] : record['content']
    return {
      success: false,
      error: { code: rawCode === 'ASK_ERROR' ? 'ASK_ERROR' : rawCode, message: rawMessage, requestId: requestIdOf(req) },
      type: 'error',
      content: record['content']
    }
  }

  // --- 形状3：原有 {success:false,error:{...}} 行为不变 ---
  const error = record['error']
  if (typeof error !== 'object' || error === null) return body
  const err = error as Record<string, unknown>
  const rawCode = typeof err['code'] === 'string' && err['code'] ? err['code'] : 'INTERNAL_ERROR'
  const rawMessage = typeof err['message'] === 'string' ? err['message'] : ''
  const code = rawCode
  const message = publicMessageFor(code, rawMessage, status)
  return {
    success: false,
    error: { code, message, requestId: requestIdOf(req) }
  }
}

