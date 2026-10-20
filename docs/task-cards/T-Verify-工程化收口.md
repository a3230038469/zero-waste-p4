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
| `build:frontend` | 只构建前端（`vue-tsc --noEmit && vite build`） |
| `verify` | **日常用**：`lint(--workspaces) + typecheck:frontend + build:frontend + format:check` |
| `verify:all` | **完整体检**：含 backend typecheck 与全量 build（当前会在 backend 撞 Prisma 旧账，见下） |

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
| frontend build | `✓ built in Xs`（有 chunk > 500KB 的提示属正常） |
| format:check | `All matched files use Prettier code style!` |

> `build` 关是 2026-10-20 补的，原因见下一节「第二个坑」。**没有 build 的 verify 是不完整的**。

## 五、已知坑（本卡两个坑，第二个更危险）

**prettier 与 eslint 会打架。** 首跑 `prettier --write` 后，出现了 **64 条 eslint 警告**：prettier 把多行的 `<el-button>` / `<el-radio>` 折回单行，触发 `vue/html-closing-bracket-newline` 与 `vue/multiline-html-element-content-newline`。

**解法**：装 `eslint-config-prettier`，并把它放在 `extends` 数组的**最后一位**——顺序不能错，它必须覆盖前面的风格规则。

```json
"extends": ["eslint:recommended", "plugin:vue/vue3-recommended", "@vue/eslint-config-typescript", "prettier"]
```

若顺序写错（放中间或开头），冲突规则不会被关掉，警告依旧。

### 第二个坑：prettier 折行吞掉模板里的分号（会导致整页白屏）

格式化 `.vue` 模板时，prettier 会把 `v-on` 的内联多语句折成多行，**并删掉语句间分号**：

```html
<!-- 之前（合法） -->
@click="activeType = t.value; onFilterChange()"

<!-- 之后（Vue 编译报 Unexpected token） -->
@click="
  activeType = t.value
  onFilterChange()
"
```

后果：`/shelf` 整页白屏。而当时 `verify` 只有 lint + typecheck + format:check，
**三道全绿**——`vue-tsc --noEmit` 不校验模板内联表达式语法，eslint 也不查。

补救与规矩：

1. 模板里不写多语句内联处理器，抽成方法（`@click="selectType(t.value)"`）
2. `verify` 补 `build` 关；只跑 lint 不能算验完
3. 全仓扫描同类问题：多行 `@event` 且不含分号的即嫌疑，当前仅 1 处（已修）

## 六、墓碑候选

本卡未产生临时脚本或调试接口。`.prettierignore` 属正式配置，**不删**。
