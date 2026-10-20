# T-Verify · 工程化收口（prettier + verify 一把跑通）

> 归属：**月月** · 状态：**✅ 已完成**（2026-10-20）
> 验收记录：[`docs/交付记录/2026-10-20-verify-首次通过.md`](../交付记录/2026-10-20-verify-首次通过.md)

---

## 一、目标

让仓库有一把能跑的验收命令：`npm run verify` 一次跑完 lint + typecheck + 格式检查，不用记三条命令。

## 二、契约（根 `package.json` scripts）

| 脚本 | 作用 |
|---|---|
| `format` | `prettier --write`，全仓格式化 |
| `format:check` | `prettier --check`，只检查不改 |
| `typecheck:frontend` | 只跑前端 `vue-tsc` |
| `verify` | **日常用**：`lint(--workspaces) + typecheck:frontend + format:check` |
| `verify:all` | **完整体检**：含 backend typecheck（当前会有 Prisma 旧账报错，见下） |

`verify` 默认跳过 backend typecheck 的原因：`backend/src/chat/store.ts` 用了 `prisma.conversation` / `prisma.message`，但 Prisma schema 缺这两个 model。这是**先前就存在的旧账**，与本卡无关，已另记待办。

## 三、实现落点

| 文件 | 改动 |
|---|---|
| `package.json`（根） | 装 `prettier@^3.x`；新增 4 个脚本；重写 `verify` |
| `frontend/package.json` | 装 `eslint-config-prettier@^9.1.0` |
| `frontend/.eslintrc.json` | extends 末尾加 `"prettier"` |
| `.prettierignore` | 扩展：加 `coverage` / `docs/shots` / `.workbuddy` / `*.log` |
| 84 个源码文件 | `prettier --write` 统一格式（**仅风格，无逻辑改动**） |

## 四、验收命令

```bash
npm run verify
```

期望输出：

| 关 | 期望 |
|---|---|
| frontend lint | 静默（0 错误 0 警告） |
| backend lint | 静默 |
| frontend typecheck | 静默（0 报错） |
| format:check | `All matched files use Prettier code style!` |

## 五、已知坑（本卡最大的坑）

**prettier 与 eslint 会打架。** 首跑 `prettier --write` 后，出现了 **64 条 eslint 警告**：prettier 把多行的 `<el-button>` / `<el-radio>` 折回单行，触发 `vue/html-closing-bracket-newline` 与 `vue/multiline-html-element-content-newline`。

**解法**：装 `eslint-config-prettier`，并把它放在 `extends` 数组的**最后一位**——顺序不能错，它必须覆盖前面的风格规则。

```json
"extends": ["eslint:recommended", "plugin:vue/vue3-recommended", "@vue/eslint-config-typescript", "prettier"]
```

若顺序写错（放中间或开头），冲突规则不会被关掉，警告依旧。

## 六、墓碑候选

本卡未产生临时脚本或调试接口。`.prettierignore` 属正式配置，**不删**。
