# QA-Snapshot · 截图存档

> 归属：**月月** · 状态：**✅ 已完成**（2026-10-20，12 张存档进仓）
> 存档目录：[`docs/shots/`](../shots/) · 拍摄方法见 [`docs/shots/README.md`](../shots/README.md)

---

## 一、目标

把验收证据沉淀进仓库，不再只躺在飞书群消息和个人笔记里——交付时能直接对答"这一项验收过了吗"。

## 二、契约（`docs/shots/` 目录约定）

```
docs/shots/
├─ README.md              # 清单 + 拍摄方法
├─ 01-home.png            # 首页
├─ 02-shelf.png           # 资料库
├─ 03-doc-detail.png      # 资料详情
├─ 04-auth.png            # 注册/登录
├─ 05-contribute.png      # 我要投稿
├─ 06-insights.png        # 数据概览
├─ 07-404.png             # 404 空态
├─ 08-state-hover.png     # 悬停态
├─ 09-state-focus.png     # 键盘焦点态
├─ 10-state-empty.png     # 空态（搜索无结果）
├─ 11-mobile-home.png     # 移动端首页 375×812
├─ 12-mobile-shelf.png    # 移动端资料库 375×812
└─ QA01/                  # 按 QA 批次归档（修复轮对比，尚未启用）
   └─ QA01FIX/
```

命名规范：

| 规则 | 说明 |
|---|---|
| 两位序号 + 短横线 | `03-doc-detail.png`，序号保证按浏览顺序排列 |
| 交互态加 `state-` 前缀 | `08-state-hover.png`，与页面截图区分 |
| 移动端加 `mobile-` | `11-mobile-home.png` |
| 批次进子目录 | 修复轮对比放 `QA01FIX/`，与 `QA01/` 对照 |
| 单张 ≤ 400KB | 1440×900 PNG 实测 130–380KB；超了 `sharp-cli resize 1280` 压 |

## 三、四种态的覆盖情况（2026-10-20）

| 态 | 覆盖 | 说明 |
|---|---|---|
| 正常 | ✅ 7 张 | 首页 / 资料库 / 详情 / 登录 / 投稿 / 概览 / 移动端 ×2 |
| 空 | ✅ 2 张 | 404 页、搜索无结果 |
| 悬停 / 焦点 | ✅ 2 张 | 真实 `element.hover()` / `keyboard.press('Tab')` 触发 |
| 加载（骨架屏） | ⬜ 待补 | 需节流 Slow 3G 抓拍 |
| 错误（`zw-error`） | ⬜ 待补 | 需停掉 backend 再刷新 |

未覆盖的两态属 QA 批次，做法已写进 `docs/shots/README.md`。

## 四、验收命令

```bash
npm run dev:backend   # 终端 1（必须先起，否则满屏错误态）
npm run dev:frontend  # 终端 2

ls -lh docs/shots/*.png   # 单张应 ≤ 400KB
```

## 五、已知坑

- **截图前必须确认 backend 在跑**，否则页面全是 `zw-error`，会误判成"页面坏了"。
- **不要用 `chrome --headless --screenshot`**：它不推进 `requestAnimationFrame`，
  Vue 的页面过渡会卡在 `fade-slide-enter-from`（`opacity: 0`），拍出来是整片空白。
  2026-10-20 实际踩过，404 页第一次就这么拍成了白图。改用 `puppeteer-core` 驱动本机 Chrome，
  `waitForFunction` 等 `<main>` 有内容 + `sleep(1200)` 等过渡结束。
- **不要下载 Chromium**：`agent-browser install` 拉 `storage.googleapis.com` 在国内经常超时
  （三次重试全失败）。本机已有 Chrome，`executablePath` 指过去即可。
- 不要把截图存成绝对路径引用——Markdown 里用相对路径 `../shots/01-home.png`。
- 截图属**过程证据，永不删**（AGENTS.md 墓碑守则明确写了）。
- 别把 55MB 级的二进制拖进仓——portal 根目录那个 `cloudflared.exe` 就是教训。

## 六、墓碑候选

无。截图与交付记录属过程证据，**不删**。
