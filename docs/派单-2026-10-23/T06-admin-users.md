# T06 后台用户：中文错误提示 + 角色变更保护

## 背景
项目根：`D:\projects\zero-waste-p4`。先读 `AGENTS.md`。
这是交付前验收发现的 P2 问题。

## 允许修改的文件（白名单）
- `frontend/src/views/AdminUsersView.vue`
- `frontend/src/api/admin.ts`
- `backend/src/routes/admin.ts`（**只改 PATCH /users/:id 这一段**）

## 问题 1：清空机构/职业会看到英文报错
现象：编辑用户时把「机构」清空后保存，页面显示 `Request failed with status code 400`。
根因：后端已返回中文 400（`backend/src/routes/admin.ts` 的 `INVALID_USER_FIELD`：“姓名、机构、职业都不能留空”），但 `frontend/src/api/admin.ts:489-495` 对 400 直接 `throw err`，页面用 `err.message` 展示。
要求：在 `updateAdminUser` 的 catch 里，400 时读取 `err.response.data.error.message`（中文）并 `throw new Error(该中文)`；读不到再回退到通用中文“保存失败，请检查填写内容”。不要展示 axios 英文原文。

## 问题 2：角色可被随意改成管理员，且能把最后一位管理员降级
现状：`AdminUsersView.vue:334-343` 角色下拉；`backend/src/routes/admin.ts:1140-1151` 直接接受 role；CLI 只提醒不阻止。
要求：
- 前端：提交前如果角色发生变化，弹二次确认（例如“确认把「张三」设为管理员？”/“确认取消「张三」的管理员身份？”），取消则不提交。
- 后端：在 PATCH `/users/:id` 改 role 时，如果目标当前是 admin、新角色是 user，且数据库里 admin 总数 ≤ 1，返回 400，中文文案“不能撤销最后一位管理员，否则管理台将没人能进”。
- 不要阻止把普通用户提升为管理员（这是现有功能），只加确认与最后一位保护。
- 不要改 CLI 脚本。

## 禁止事项
- 不要改 `PATCH /users/:id` 之外的任何后端路由。
- 不要改用户列表的导出/脱敏逻辑。
- 不要运行 `npm run build`、不要启动 dev server。
- 不要执行任何 git 写操作。
- 不要动白名单外的文件。

## 验收标准（写进回执）
- 清空机构保存 → 页面显示中文“姓名、机构、职业都不能留空”，不再出现英文 axios 文案。
- 改角色时出现二次确认；取消不保存。
- 当只有 1 位管理员时，把它降级 → 后端 400 + 中文提示，角色不变。
- 运行 `cd backend && npx tsc --noEmit` 与 `cd frontend && npx vue-tsc --noEmit`，报告与本次改动相关的错误（白名单外并发报错可忽略并注明）。

## 完成后
回执写到 `docs/派单-2026-10-23/回执-T06.md`：文件清单、改法（带行号）、命令与结果、遗留。不要写 `logs/opencode_log.md`。
