# T03 资料级反馈：允许只选问题类型不写说明

## 背景
项目根：`D:\projects\zero-waste-p4`。先读 `AGENTS.md`。
这是交付前验收发现的 P1 问题：弹窗标“详细说明（选填）”，但后端强制必填。

## 允许修改的文件（白名单）
- `frontend/src/components/FeedbackDialog.vue`
- `frontend/src/constants/feedback.ts`
- `backend/src/feedback/store.ts`
- `backend/src/routes/feedback.ts`

## 现状
- `FeedbackDialog.vue:93-98` 只对站点级校验文字，资料级允许空；
- 弹窗里资料级文案是“详细说明（选填）”；
- `backend/src/feedback/store.ts:207-208` 一律 `if (!message) return [null, '请写一下反馈内容']`。
结果：只勾“文件打不开 / 无法预览下载”不写字，提交必然 400。

## 要求
1. 资料级反馈（`scope === 'doc'`）：只要选了问题类型（`reason` 非空），允许 `message` 为空。后端落库时 `message` 可以为空串，但 `reason` 必须保留。
2. 站点级反馈（`scope === 'site'`）：仍然必须写文字，前端与后端都保持拦截。
3. 前端不要放宽站点级校验；资料级保持“选填”文案。
4. 不新增字段、不改接口路径；`docs/接口约定.md` 如果已有“message 必填”的描述，只改必要的措辞（允许的话优先不改文档，避免并发冲突）。

## 禁止事项
- 不要改反馈的限流、埋点、权限开关逻辑。
- 不要运行 `npm run build`、不要启动 dev server。
- 不要执行任何 git 写操作。
- 不要动白名单外的文件。

## 验收标准（写进回执）
- `POST /api/feedback` 带 `{kind, scope:'doc', reason:'broken', docId, message:''}` → 201，落库 `message` 为空、`reason` 保留。
- 同样的请求 `scope:'site'`、`message:''` → 400（或前端先拦），文案仍是“请写一下反馈内容”。
- 详情页反馈弹窗：只选原因直接提交成功，弹窗关闭并提示成功。
- 运行 `cd backend && npx tsc --noEmit` 与 `cd frontend && npx vue-tsc --noEmit`，报告与本次改动相关的错误（白名单外并发报错可忽略并注明）。

## 完成后
回执写到 `docs/派单-2026-10-23/回执-T03.md`：文件清单、改法（带行号）、命令与结果、遗留。不要写 `logs/opencode_log.md`。
