# T09 安全加固：埋点身份、游客额度、代理信任、Cookie

## 背景
项目根：`D:\projects\zero-waste-p4`。先读 `AGENTS.md`。
这是交付前安全专项。只改后端，不动前端。

## 允许修改的文件（白名单）
- `backend/src/index.ts`
- `backend/src/guest/ask-usage.ts`
- `backend/src/routes/track.ts`
- `backend/src/track/store.ts`
- `backend/src/routes/auth.ts`

## 要修的五件事

### 1. 游客额度可被 X-Forwarded-For 绕过（高）
现状：`guest/ask-usage.ts` 的 `clientIp()` 无条件读 `X-Forwarded-For` 第一个值；任何人换一个 XFF 就换一个额度桶（实测 3 个 IP 都得到 remaining:5）。
要求：
- 不再手工信任 XFF。`clientIp(req)` 改为返回 `req.ip || req.socket.remoteAddress || ''`（由 Express 按 `trust proxy` 计算）。
- 在 `index.ts` 增加 `TRUST_PROXY` 环境变量支持：只有显式设置时才 `app.set('trust proxy', ...)`（`'true'` → 1；数字 → 数字；其他字符串原样）。默认不信任代理。
- 在 `index.ts` 注释里写清：部署到 nginx 后必须设置 `TRUST_PROXY=1`，否则限流会把所有人当成同一个 IP；不设置时不能信任 XFF。
- `routes/auth.ts`、`routes/feedback.ts` 已经用 `req.ip`，不需要改逻辑，但要在回执里确认它们与新的 trust proxy 口径一致。

### 2. 埋点可伪造任意 userId（高）
现状：`track/store.ts` 的 `buildEvent` 采用请求体里的 `userId`；`routes/track.ts` 没做身份绑定。
要求：
- `routes/track.ts` 用现成的 `userIdFromRequest(req)`（`backend/src/guest/identity.ts`）解析登录用户；对每条通过校验的事件，**覆盖** `event.userId`：登录用户 = 真实 userId，未登录 = null。客户端传来的 `userId` 一律忽略。
- 客户端传来的 `ts` 也一律忽略，落库时间用服务端当前时间（避免写未来/历史时间）。
- 保持 `sessionId` 现状（匿名会话标识，不作为身份）。
- 不要改 `recordEvent` 的调用方（服务端事件仍可显式传 userId）。

### 3. `/api/track` 无限流（中）
要求：在 `routes/track.ts` 加一个简单的内存限流，按 `req.ip` 计数，例如 240 次/分钟；超限返回 429 JSON（`{success:false,error:{code:'RATE_LIMITED',message:'埋点提交太频繁，请稍后再试'}}`）。不要引新依赖。

### 4. Cookie 没有 Secure（低）
要求：登录 cookie 与游客设备 cookie 都支持 `COOKIE_SECURE=1` 时加 `secure: true`；默认不加（本地 HTTP 演示不受影响）。在注释里写清生产 HTTPS 要设置。

### 5. 关闭 X-Powered-By + auth 500 原文外泄
要求：
- `index.ts` 加 `app.disable('x-powered-by')`。
- `routes/auth.ts` 的兜底 catch 不再把 `err.message` 返回浏览器；改成通用中文“服务器内部错误，请稍后再试”，并把原始错误 + requestId 打到服务端日志。

## 禁止事项
- 不要改前端、不要改数据库 schema、不要引新依赖。
- 不要改成功响应结构。
- 不要运行 `npm run build`、不要启动 dev server。
- 不要执行任何 git 写操作。
- 不要动白名单外的文件。

## 验收标准（写进回执）
- 同一请求换不同 `X-Forwarded-For`，`/api/guest/ask-usage` 返回同一个 used/remaining（未设置 TRUST_PROXY 时）。
- 用假 `userId` POST `/api/track`，落库事件里不是假 id（未登录为 null）。
- 快速 POST `/api/track` 超过阈值返回 429。
- 响应头没有 `X-Powered-By`。
- `COOKIE_SECURE=1` 时 Set-Cookie 带 `Secure`。
- `cd backend && npx tsc --noEmit` 通过。

## 完成后
回执写到 `docs/派单-2026-10-23/回执-T09.md`：文件清单、改法（带行号）、命令与结果、遗留。不要写 `logs/opencode_log.md`。
