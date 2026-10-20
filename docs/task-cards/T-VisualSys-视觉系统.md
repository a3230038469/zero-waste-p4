# T-VisualSys · 视觉系统设计（交互）

> 归属：**月月** · 状态：**✅ 全部完成**（2026-10-20，分支 `feat-yuey-visual`）
> 规范原文：[`docs/视觉系统规范-2026-10-13.md`](../视觉系统规范-2026-10-13.md)
> 验收记录：[`docs/交付记录/2026-10-20-交互态与证据链.md`](../交付记录/2026-10-20-交互态与证据链.md)

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
| 按下 | 全站 `:active` 兜底（`:where(a,button,…)`，2026-10-20 补齐） |
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

| 指标 | 改造前 | 完成 |
|---|---:|---:|
| 硬编码 `font-size` | 153 | **1**（`AboutView` 移动端 22px 响应式降档，属预期例外） |
| 硬编码 hex | 117 | 45（**全部在 `:root` 定义处**：global.css 25 + tokens.css 2；组件内 18 为装饰性渐变/阴影，无需令牌化） |
| `var(--zw-*)` 用量 | 480 | **706** |
| 可点元素交互态覆盖 | 0（无全站 `:active`） | **20/20** hover + focus + active |
| Element 默认空态 / 结果页 | 5 处 | **0 处**（全走 `zw-empty` / `zw-error`） |
| 端到端验收 | 未做 | **9/9** |

交互态审计（`audit-interaction-states.py`，2026-10-20）：

```
全站兜底：焦点环 有 / 按下态 有
可点元素(cursor:pointer) 共 20 处，真正要补的 0 处
```

端到端（Puppeteer，真实浏览器）：搜索→结果→详情、键盘焦点 10/10 可见、
登录空提交拦截、UI 登录显示「XX，你好」、刷新保持登录态、404 兜底、移动端 375 无横向溢出。

## 五、已知坑

- **度量脚本必须同时扫 `<style scoped>` 和 `styles/*.css`**——早期版本只扫前者，得出"字号已清零"的错误结论。
- 批量替换会产生嵌套兜底 `var(--x, var(--x))`，事后要用正则清一遍：
  `re.compile(r'var\((--zw-[a-z0-9-]+),\s*var\(\1\)\)')` → `var(\1)`
- Admin 类四页令牌化已在 2026-10-20 复查：字号硬编码 0，仅各余 1 处 hex（装饰色），无需再动。
- **不要用 `chrome --headless --screenshot` 做验收截图**：不推进 rAF，Vue 过渡卡在
  `fade-slide-enter-from`，拍出全白。用 puppeteer 驱动本机 Chrome，详见 `docs/shots/README.md`。
- 移动端 375 宽曾因分页条 469px 撑出 47px 横向滚动（连带 `MouseGlow` 的 fixed 包含块被撑宽）。
  已用 `pager-count=5` + 窄屏隐藏总数修复；改分页相关样式后请复测 `scrollWidth`。

## 六、墓碑候选

- `apply-visual-tokens.py`、`analyze-style-coverage.py`——**不删**，是可复用度量工具，建议沉淀为 skill。
