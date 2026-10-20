# T-VisualSys · 视觉系统设计（交互）

> 归属：**月月** · 状态：**✅ 阶段①②③ 已完成**（分支 `feat-yuey-visual`）
> 规范原文：[`docs/视觉系统规范-2026-10-13.md`](../视觉系统规范-2026-10-13.md)

---

## 一、目标

把颜色 / 字号 / 间距 / 圆角 / 动效刻度定死，补齐七种交互态，让全站视觉有统一语言、不靠个人手感。

## 二、契约（对外暴露什么）

### 设计令牌（`frontend/src/styles/tokens.css`）

只放变量，零侵入，不写任何选择器：

| 类别 | 令牌示例 |
|---|---|
| 字号 8 档 | `--zw-fs-xs`(12) / `sm`(13) / `body`(15) / `lg` / `h2` / `h1` / `display`(40) |
| 间距 10 档 | `--zw-space-1` … `--zw-space-10` |
| 圆角 / 阴影 | `--zw-radius-*` / `--zw-shadow-*` |
| 动效时长 + 缓动 | `--zw-dur-fast` / `--zw-dur-base` / `--zw-ease-*` |
| 语义状态色 | `--zw-danger` / `--zw-success` / `--zw-warn` / `--zw-info` |
| 其他 | 焦点环 `--zw-focus-ring`、z-index 层级 |

### 七种交互态（`frontend/src/styles/global.css`）

| 态 | 落地 |
|---|---|
| 悬停 | `.zw-card--clickable`、`.zw-link` |
| 键盘焦点 | 全站 `:focus-visible` 焦点环 |
| 按下 | 全站 `:active` |
| 禁用 | `.zw-disabled` |
| 加载 | `.zw-skeleton` 骨架屏 |
| 空态 | `.zw-empty` |
| 错误 | `.zw-error` + 重试按钮 |

配套：`prefers-reduced-motion` 降级、Element Plus 焦点 / 悬停 / 表单错误态对齐。

## 三、实现落点

| 文件 | 内容 |
|---|---|
| `frontend/src/styles/tokens.css` | 新建，令牌定义层 |
| `frontend/src/styles/global.css` | 追加交互态公共类（**未动瑞泽原有规则**） |
| `frontend/src/main.ts` | 加一行 `import './styles/tokens.css'` |
| `frontend/src/views/NotFoundView.vue` | 重写为 `zw-empty` 规范 |
| `DocDetailView.vue` / `ShelfView.vue` | 加 `errorMessage` + try/catch，失败走 `zw-error`（原接口挂掉会误显示 404） |
| 全站 20 个文件 | 硬编码字号 / 动效批量换令牌 |

## 四、验收命令

```bash
# 度量（改造前 / 后 对比）
python ../../2026-10-06-23-47-36/analyze-style-coverage.py

# 质量关
npm run verify
```

量化结果：

| 指标 | 改造前 | 改造后 |
|---|---:|---:|
| 硬编码 `font-size` | 153 | **1**（仅剩 `AboutView` 移动端 22px 响应式降档，属预期例外） |
| 硬编码 hex | 117 | 45（组件 18 + 全局 25 + 令牌 2） |
| `var(--zw-*)` 用量 | 480 | **706** |
| 全站 `:active` | 0 | 5 |

## 五、已知坑

- **度量脚本必须同时扫 `<style scoped>` 和 `styles/*.css`**——早期版本只扫前者，得出"字号已清零"的错误结论。
- 批量替换会产生嵌套兜底 `var(--x, var(--x))`，事后要用正则清一遍：
  `re.compile(r'var\((--zw-[a-z0-9-]+),\s*var\(\1\)\)')` → `var(\1)`
- Admin 类四页（`AdminContributionsView` / `AdminKnowledgeView` / `AdminStatsView` / `AdminUsersView`）令牌化**尚未彻底扫**，是 Day 3 收尾项。

## 六、墓碑候选

- `apply-visual-tokens.py`、`analyze-style-coverage.py`——**不删**，是可复用度量工具，建议沉淀为 skill。
