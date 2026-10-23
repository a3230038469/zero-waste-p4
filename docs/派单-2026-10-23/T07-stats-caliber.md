# T07 统计口径：去重数字与看板漏斗

## 背景
项目根：`D:\projects\zero-waste-p4`。先读 `AGENTS.md`。
这是交付前验收发现的 P1 与 P2 问题。

## 允许修改的文件（白名单）
- `backend/src/routes/overview.ts`
- `backend/src/data/duplicates.ts`
- `frontend/src/views/AdminStatsView.vue`

## 问题 1：对外“去重后 591 份 / 重复副本 11 组 12 份”与实库不符（P1）
现状：`GET /api/overview` 返回 `total=603, uniqueTotal=591, duplicateGroups=11, duplicateCopies=12`；但遍历 603 条公开资料，按精确 `size` 分组没有任何重复。
根因：`overview.ts:169` 用 `total - duplicateCopyCount()`，而 `duplicateCopyCount()` 读的是 2026-10-10 的 `backend/data/kb-duplicates.json`（键是本地索引 `k-*`，引擎数据是 UUID，早已对不上）。
要求：
- 改为**基于当前实际资料列表**计算重复：用 `listFiles()` 返回的 docs，按精确 `size` 分组（字节级相同的强信号）；`duplicateCopies = Σ(组内数量-1)`，`duplicateGroups = 重复组数`，`uniqueTotal = total - duplicateCopies`。
- 不要再用 `kb-duplicates.json` 的 12 份做减法；如果 `duplicates.ts` 因此不再被 overview 使用，可以保留文件但不要删（其他模块可能引用）。
- 当前数据应得到：`total=603, uniqueTotal=603, duplicateGroups=0, duplicateCopies=0`。
- 首页/看板的口径说明是读这些字段渲染的，不要写死数字。

## 问题 2：看板“使用漏斗”出现 217%、924%（P2）
现状：`AdminStatsView.vue` 的漏斗按“相对上一步”算，步骤之间不是同一条递减链路，所以百分比可以 >100%，标题叫“漏斗”名不副实。
要求（前端改）：
- 把每一步的百分比改成**相对 PV**：`该步数量 / PV * 100`，展示为“占 PV 3%”这类；
- 删除“相对上一步”的措辞与“流失最大的一步”里基于上一步的说法，改为“转化最低的一步：用搜索找资料（占 PV 3%）”；
- 所有百分比必须 ≤100%；
- 计数本身不变，不要改后端 analytics 接口。

## 禁止事项
- 不要改 `/api/admin/analytics` 的返回结构。
- 不要删 `backend/data/kb-duplicates.json`。
- 不要运行 `npm run build`、不要启动 dev server。
- 不要执行任何 git 写操作。
- 不要动白名单外的文件。

## 验收标准（写进回执）
- `GET /api/overview` 当前返回 `total=603, uniqueTotal=603, duplicateGroups=0, duplicateCopies=0`。
- 首页口径弹窗不再出现“去重后 591 / 重复 12 份”的错误数字。
- 看板漏斗所有百分比 ≤100%，文案不再说“相对上一步”。
- 运行 `cd backend && npx tsc --noEmit` 与 `cd frontend && npx vue-tsc --noEmit`，报告与本次改动相关的错误（白名单外并发报错可忽略并注明）。

## 完成后
回执写到 `docs/派单-2026-10-23/回执-T07.md`：文件清单、改法（带行号）、命令与结果、遗留。不要写 `logs/opencode_log.md`。
