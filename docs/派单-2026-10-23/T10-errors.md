# T10 错误收口：统一错误结构 + 去掉内部原文外泄

## 背景
项目根：`D:\projects\zero-waste-p4`。先读 `AGENTS.md`。
这是交付前错误处理专项。只改后端，不动前端。

## 允许修改的文件（白名单）
- `backend/src/errors/types.ts`
- `backend/src/routes/feedback.ts`
- `backend/src/routes/ask.ts`
- `backend/src/routes/chat.ts`
- `backend/src/routes/overview.ts`

> 注意：`routes/auth.ts` 由另一张单（T09）负责，**不要动**。

## 要修的三件事

### 1. 错误结构三套并存（中）
现状：
- 反馈：`{code, message, requestId}`（扁平，没有 success/error 包）
- 投稿/资料：`{success:false, error:{code,message,requestId}}`
- 问答开流前：`{success:false, type:'error', content:'...'}`
- 登录：`{error:{message}}`（T09 负责）

要求：
- `routes/feedback.ts` 的所有错误响应改成标准结构：`{success:false, error:{code,message}}`（中间件会补 requestId）。
- `routes/ask.ts` 的开流前错误：**保留** `type:'error'` 与 `content`（前端在读它），同时补一个 `error:{code,message}` 字段，做到“老字段不删、新字段齐全”。
- `errors/types.ts` 的 `normalizeErrorBody` 增加兼容：
  - 扁平 `{code,message}`（没有 success 字段）→ 转成 `{success:false,error:{code,message,requestId}}`；
  - `{success:false,type:'error',content}` → 保留 `type/content`，并补 `error:{code:'ASK_ERROR',message:content}` 与 requestId；
  - 原有的 `{success:false,error:{...}}` 行为不变。
- 不要改变成功响应。

### 2. 500 错误把内部原文返回浏览器（中）
现状：
- `routes/chat.ts` 的 catch 返回 `err.message`；
- `routes/overview.ts` 的 catch 返回 `err.message`（这是**公开接口**，local 模式可能带绝对路径）。
要求：
- 两处 500 都改成通用中文：聊天“聊天服务暂时不可用，请稍后再试”；概览“资料统计暂时不可用，请稍后再试”。
- 原始错误 + requestId 用 `console.error` 打到服务端日志（保留排障能力）。
- 不要吞掉状态码（仍 500）。

### 3. 业务字段不要被错误中间件误删（低）
现状：`normalizeErrorBody` 重建对象时只保留 code/message/requestId，会丢掉 `issues[]` 等业务字段。
要求：
- 在保证安全的前提下，保留白名单内的附加字段：`issues`、`changed`、`ignored`、`checks`（这些是前端要用的结构化信息）。
- 仍然不要保留 `detail`、`stack`、`engine` 等可能含内部原文的字段。
- 如果判断某个字段可能带内部信息，宁可丢掉，不要为了“完整”外泄。

## 禁止事项
- 不要改前端、不要改 auth.ts、不要改成功响应。
- 不要引新依赖。
- 不要运行 `npm run build`、不要启动 dev server。
- 不要执行任何 git 写操作。
- 不要动白名单外的文件。

## 验收标准（写进回执）
- `POST /api/feedback` 参数错误 → `{success:false,error:{code,message,requestId}}`。
- `POST /api/ask` 空 query → 仍有 `type:'error'` 与 `content`，同时有 `error:{code,message}`。
- `GET /api/overview` 的 500 分支不再返回 `err.message`（代码检查）。
- `normalizeErrorBody` 对三种输入形状的转换结果写进回执（给例子）。
- `cd backend && npx tsc --noEmit` 通过。

## 完成后
回执写到 `docs/派单-2026-10-23/回执-T10.md`：文件清单、改法（带行号）、三种错误结构的转换例子、命令与结果、遗留。不要写 `logs/opencode_log.md`。
