# T04 投稿审核：原件能打开 + 队列加分页

## 背景
项目根：`D:\projects\zero-waste-p4`。先读 `AGENTS.md`。
这是交付前验收发现的 P1 与 P2 问题。

## 允许修改的文件（白名单）
- `frontend/src/views/AdminContributionsView.vue`
- `frontend/src/api/contributions.ts`

## 问题 1：点「原件」没有任何反应（P1）
现象：管理员点待审稿件的原件文件名，不打开新标签、不报错、无提示。
证据：接口 `GET /api/admin/contributions/:id/file` 用 curl 返回 200 / application/pdf；问题在前端。
根因：`api/contributions.ts:198-206` 先 `await` 取 blob，再 `window.open(url)`；异步之后开新窗口会被浏览器弹窗拦截。

要求：
- 点击时**同步**先开一个空白窗口（`const w = window.open('', '_blank')`），拿到 blob 后再把 `w.location.href` 指向 objectURL；
- 如果 `w` 为 null（被拦截），不要静默失败：给中文提示，例如“浏览器拦截了新窗口，请允许本站弹窗后重试”；
- 成功打开后 60 秒回收 objectURL；失败时也要回收；
- 不要改成下载，审核员需要在线看。

## 问题 2：审核队列最多 100 条且无分页（P2）
现状：`AdminContributionsView.vue:69-73` 固定 `pageSize:100`，模板没有分页器；后端已支持 `page/pageSize`。
要求：
- 加页码状态与 `el-pagination`，默认每页 20 条，显示总数；
- 切换状态筛选、搜索、刷新时重置到第 1 页；
- 翻页调用现有 `fetchAdminContributions` 的 `page` 参数，不要新增接口；
- 空状态、加载态、错误态保持现有样式。

## 禁止事项
- 不要改审核通过/退回的业务逻辑。
- 不要改后端。
- 不要运行 `npm run build`、不要启动 dev server。
- 不要执行任何 git 写操作。
- 不要动白名单外的文件。

## 验收标准（写进回执）
- 点原件能打开 PDF（或明确提示弹窗被拦截），不再“点了没反应”。
- 待审超过 20 条时出现分页；翻页后列表变化；筛选/搜索后回到第 1 页。
- 运行 `cd frontend && npx vue-tsc --noEmit`，报告与本次改动相关的错误（白名单外并发报错可忽略并注明）。

## 完成后
回执写到 `docs/派单-2026-10-23/回执-T04.md`：文件清单、改法（带行号）、命令与结果、遗留。不要写 `logs/opencode_log.md`。
