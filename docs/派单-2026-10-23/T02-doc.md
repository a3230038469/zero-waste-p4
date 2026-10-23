# T02 资料详情：关闭游客预览时不要把读者踢去登录

## 背景
项目根：`D:\projects\zero-waste-p4`。先读 `AGENTS.md`。
这是交付前验收发现的 P1 问题。

## 允许修改的文件（白名单）
- `frontend/src/views/DocDetailView.vue`
- `frontend/src/components/DocCard.vue`
- `frontend/src/composables/useDocActions.ts`

## 问题
管理员把「游客在线预览」关掉后，游客打开 `/doc/:id`：
- 页面还没显示标题/机构/年份，就被 `requireAccess('preview')` 跳到 `/auth?redirect=...`；
- 用户连“这是什么资料”都看不到。

根因：
- `DocDetailView.vue` 的 `canPreview` 只判断“不是超大文件 + 是 PDF”（约 :127），不含权限；
- `onMounted` 拉到资料后无条件 `void preview(doc.value)`（约 :252-253），`preview()` 内部才做权限判断并跳转；
- `initGuestPermissions()` 是 `void` 调用，没有等权限读完。

## 要求
1. 进详情页时先 `await initGuestPermissions()`，再决定是否自动预览。
2. 自动预览条件 = 文件可预览（PDF、未超限）**且**当前身份有预览权限。没有权限时：
   - **不要跳转**；
   - 页面正常显示标题、机构、年份、主题等元数据；
   - 预览区域改成一句清楚的中文提示 + 一个“去登录”按钮（带 `redirect` 回当前页），例如“登录后可在线预览这份资料”。
3. `DocCard.vue` 的「预览」按钮：除了体积/PDF 判断，还要在 `locked('preview')` 时置灰/不可点，并给 title 说明（与「下载」按钮的置灰口径保持一致）。
4. 已登录用户行为不变：进页仍自动预览。

## 禁止事项
- 不要改后端、不要改游客权限的默认值、不要新增接口。
- 不要运行 `npm run build`、不要启动 dev server。
- 不要执行任何 git 写操作。
- 不要动白名单外的文件。

## 验收标准（写进回执）
- 关闭游客预览后：游客打开详情页**停留在详情页**，能看到标题/机构/年份，预览区显示登录提示；点“去登录”才跳 `/auth?redirect=...`。
- 打开游客预览后：游客进详情页仍自动加载 PDF。
- 已登录用户进详情页仍自动预览。
- 资料库卡片的「预览」按钮在游客无权限时不可点，有权限时可点。
- 运行 `cd frontend && npx vue-tsc --noEmit`，报告与本次改动相关的错误（白名单外并发报错可忽略并注明）。

## 完成后
回执写到 `docs/派单-2026-10-23/回执-T02.md`：文件清单、改法（带行号）、命令与结果、遗留。不要写 `logs/opencode_log.md`。
