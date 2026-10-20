# docs/shots/ — 验收截图存档

> 用途：把验收证据沉淀进仓，交付时能直接对答"这一项验收过了吗"。
> 规范见 [`docs/task-cards/QA-Snapshot-截图存档.md`](../task-cards/QA-Snapshot-截图存档.md)。
> **截图与交付记录属过程证据，永不删**（AGENTS.md 墓碑守则）。

---

## 截图清单（2026-10-20 拍摄）

| 文件 | 内容 | 路由 | 覆盖的状态 |
|---|---|---|---|
| `01-home.png` | 首页 | `/` | 正常 |
| `02-shelf.png` | 资料库（617 份，卡片网格） | `/shelf` | 正常 |
| `03-doc-detail.png` | 资料详情 | `/doc/k-16` | 正常 |
| `04-auth.png` | 注册 / 登录 | `/auth` | 正常 |
| `05-contribute.png` | 我要投稿 | `/contribute` | 正常（空态：还没投过稿） |
| `06-insights.png` | 数据概览 | `/insights` | 正常 |
| `07-404.png` | 404 空态 | `/404-not-exist` | 空态 |
| `08-state-hover.png` | 首页类型卡片悬停 | `/` | 悬停 |
| `09-state-focus.png` | 资料库类型标签键盘焦点 | `/shelf` | 键盘焦点 |
| `10-state-empty.png` | 资料库搜索无结果 | `/shelf?q=zzzzzznotfound` | 空态 |
| `11-mobile-home.png` | 移动端首页（375×812） | `/` | 正常 · 响应式 |
| `12-mobile-shelf.png` | 移动端资料库（375×812） | `/shelf` | 正常 · 响应式 |

未覆盖（需后端制造故障才能拍，留待 QA 批次）：接口失败的错误态、表单校验失败态、加载骨架屏的定格。

## 怎么复现

### 前置

```bash
npm run dev:backend    # 必须先起，否则页面全是错误态
npm run dev:frontend   # 默认 http://localhost:5173
```

### 拍摄

**不要用 `chrome --headless --screenshot`。** 这种方式不推进 `requestAnimationFrame`，
Vue 的页面过渡会卡在 `fade-slide-enter-from`（`opacity: 0`），拍出来是一片空白
（2026-10-20 实际踩过，404 页当时就是这么拍成空白的）。

用 Puppeteer 驱动本机 Chrome，等 `networkidle` + 动画结束后再截：

```bash
npm i puppeteer-core            # 装在仓库外即可，不污染项目依赖
node scripts-local/shots.js     # 逐页 goto -> 等 <main> 有内容 -> sleep 1.2s -> screenshot
```

脚本要点：

- `executablePath` 指向本机 Chrome，不用下载 Chromium（国内拉 `storage.googleapis.com` 经常超时）
- 每页 `waitForFunction(() => document.querySelector('.app-main').children.length > 0)`
- 截图前 `sleep(1200)`，等 `<transition>` 的进场动画跑完
- 交互态用 `element.hover()` / `keyboard.press('Tab')` 真实触发，不要用 CSS 伪造

## 目录结构

```
docs/shots/
├─ README.md
├─ 01-home.png … 10-state-empty.png
└─ QA01/          # 按 QA 批次归档
   └─ QA01FIX/    # 修复轮，与 QA01 对照
```

## 纪律

- 命名：两位序号 + 短横线（`03-doc-detail.png`），交互态用 `state-` 前缀
- Markdown 引用用**相对路径**：`../shots/03-doc-detail.png`
- 单张 ≤ 400KB（1440×900 PNG 实测 130–380KB，属于正常范围）；超了先压再传
- 需要更小体积时统一压到 1280 宽：`npx -p sharp-cli sharp -i in.png -o out.png resize 1280`
- 别把大二进制拖进仓——portal 根目录那个 55MB `cloudflared.exe` 就是教训
