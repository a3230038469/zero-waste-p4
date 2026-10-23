# T05 资料管理：操作列「预览 / 下载 / 更多」排版对齐

## 背景
项目根：`D:\projects\zero-waste-p4`。先读 `AGENTS.md`。
用户反馈：管理台资料管理列表里，操作列的「预览 / 下载 / 更多」不在一条线上。

## 允许修改的文件（白名单）
- `frontend/src/views/AdminKnowledgeView.vue`

## 实测数据（1280px 视口）
操作列 `width="156"`，第一行三个按钮的实测位置：
- 预览：x=1097, y=275, w=30
- 下载：x=1139, y=275, w=30
- 更多 ▾：x=1168, y=271, w=43
说明：下载右边缘 1169 与「更多」左边缘 1168 重叠 1px；「更多」比另外两个高 4px（el-dropdown 包裹层基线不同）。

## 要求
1. 把三个操作包进一个容器（例如 `<div class="row-acts">`），使用 `display:flex; align-items:center; justify-content:center; gap:6px; white-space:nowrap;`。
2. 清掉 el-button 默认的 `margin-left`（相邻按钮默认 12px），避免重叠；确保 el-dropdown 的触发按钮与另外两个垂直居中。
3. 操作列宽从 156 调到能容纳三者且不换行的值（建议 168），并在 1280 / 1440 宽度下都不换行。
4. 顺手修一个视觉 bug：行内「预览」按钮绑了 `:loading="reuploadingId === scope.row.id"`（约 :1003），但该按钮只是 `window.open`，不需要 loading。改成独立的 `previewingId`（如果确实需要加载态）或直接去掉 loading；不要复用 `reuploadingId`。
5. 不改其他列宽、不改表格其他样式、不改业务逻辑。

## 禁止事项
- 不要改后端、不要改上传/删除/重传逻辑。
- 不要运行 `npm run build`、不要启动 dev server。
- 不要执行任何 git 写操作。
- 不要动白名单外的文件。

## 验收标准（写进回执）
- 在 1280 与 1440 宽度下，预览/下载/更多三者的垂直中心线一致（误差 ≤1px），无重叠、无换行。
- 重传某一行时，该行「预览」按钮不再出现转圈。
- 运行 `cd frontend && npx vue-tsc --noEmit`，报告与本次改动相关的错误（白名单外并发报错可忽略并注明）。

## 完成后
回执写到 `docs/派单-2026-10-23/回执-T05.md`：文件清单、改法（带行号与关键 CSS）、命令与结果、遗留。不要写 `logs/opencode_log.md`。
