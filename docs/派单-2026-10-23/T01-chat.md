# T01 问答页体验修复（次数刷新 / 禁止超限发送 / 兜底不挂引用 / 分享文案）

## 背景
项目根：`D:\projects\zero-waste-p4`。先读 `AGENTS.md`。
这是交付前验收发现的 P1 问题，只修现有逻辑，不加新功能。

## 允许修改的文件（白名单，其他文件一律不许动）
- `frontend/src/views/ChatView.vue`
- `frontend/src/composables/useChatStreamStore.ts`

## 要修的四件事

### 1. 游客次数不刷新
现象：问完一次后，后端 `/api/guest/ask-usage` 已返回 `remaining:4`，页面仍显示“还能问 5 次”；换新对话才更新。
现状：`ChatView.vue` 只在进页时 `fetchAskUsage()`（约 :209），提问结束后没有再拉。
要求：每次提问流结束（成功、失败、取消都算）后，如果未登录，重新调用 `/api/guest/ask-usage` 并更新 `guestUsage`。不要改成轮询。

### 2. 次数用完 / 游客问答关闭时仍能点发送
现状：发送按钮 `:disabled="!draft.trim() || busy || !activeId || overLimit"`（约 :1044），不看游客开关与剩余次数。
要求：
- 未登录且（`guestAiOpen === false` 或 `guestUsage.remaining <= 0`）时，发送按钮禁用；
- 回车发送也要拦（`onKeydown` / `send` 入口给一句中文提示，例如“游客今日提问次数已用完，登录后不受限制”），不要只靠按钮禁用；
- 已登录用户不受影响。

### 3. 答不上来时仍挂 3 份不相关引用
现象：回答明确说“资料中没有找到能回答这个问题的内容”，下方仍显示“3 份资料”，点开是与问题无关的资料。
现状：`useChatStreamStore.ts` 在 `!live.text` 时只设 `live.noAnswer = true`（约 :248-251），没有清空 `live.sources`；`ChatView.vue` 的 `paintLive` 仍会写入 sources，引用条 `v-if="!m.failed && m.sources.length > 0"`（约 :947）也不看 `noAnswer`。
要求：
- 兜底/无答案时清空 sources（流内 `!live.text` 分支；`paintLive` 在 `live.noAnswer` 时不要挂 sources）；
- 引用条条件加 `&& !m.noAnswer`；
- 历史消息从 `parseStoredAnswer` 读出 `noAnswer` 的，也不要显示引用条。
注意：正常有答案的回答必须保留引用，不要误伤。

### 4. 分享对话文案误导
现象：按钮提示“打开就是这条对话”，但会话有归属校验，别人打开是 403。
要求：不改后端、不做公开分享。把按钮 title 与成功提示改成诚实的说法，例如“复制本机对话链接（仅本机可打开）”。不要新增接口。

## 禁止事项
- 不要改后端、不要改 `docs/接口约定.md`、不要新增依赖。
- 不要运行 `npm run build`、不要启动 dev server（并发任务会抢构建产物）。
- 不要执行任何 git 写操作（add/commit/push/checkout）。
- 不要动白名单外的文件。

## 验收标准（写进回执）
- 未登录问一次后，页面次数数字自动减 1（不用刷新/换会话）。
- `remaining<=0` 或 `guestAiOpen=false` 时发送按钮禁用，回车也被拦并提示。
- 无答案回答下方没有“N 份资料”引用条；正常回答仍有。
- 分享按钮文案不再承诺“别人打开就是这条对话”。
- 运行 `cd frontend && npx vue-tsc --noEmit`，报告与本次改动相关的错误（白名单外文件的并发报错可忽略并注明）。

## 完成后
把回执写到 `docs/派单-2026-10-23/回执-T01.md`：改了哪些文件、每个问题怎么改的（带行号）、跑了什么命令、结果、有无遗留。不要写 `logs/opencode_log.md`（并发会冲突）。
