# scripts/ —— 视觉与交互的自查工具

这里放的检查脚本，用来回答两个问题：

> 我这次改动有没有违反视觉规范？交互态是不是齐的？

自己先跑一遍，比提交后等 review 时被人指出来省事得多。

---

## 零、一行速查

| 命令 | 干什么 | 依赖 |
|---|---|---|
| `npm run audit:interaction` | 交互态是否配齐（悬停/焦点/按下） | Python |
| `npm run audit:tokens` | 设计令牌覆盖率、硬编码残留 | Python |
| `npm run qa:shots` | 拍 12 张验收截图（含错误态）| 服务在跑 + puppeteer-core |
| `npm run qa:e2e` | 端到端 9 项验收 | 服务在跑 + puppeteer-core |
| `npm run qa:overflow` | 单个页面窄屏溢出定位 | 服务在跑 + puppeteer-core |
| `npm run qa:responsive` | **全部 12 页 × 3 个宽度**批量体检 | 服务在跑 + puppeteer-core |

前两个是 Python 写的（标准库，无需装包）；后四个要开浏览器。

> Windows 上提示「python 不是内部或外部命令」= PATH 里没有 Python。
> 装一个就行；不想装的话，只用 `qa:*` 那四个也够验收了。

---

## 一、Python 工具（标准库即可）

### `audit-interaction-states.py` —— 交互态审计

扫出「看着能点、但没配齐悬停/焦点/按下」的元素。

```bash
python scripts/audit-interaction-states.py              # 默认扫 frontend/src
python scripts/audit-interaction-states.py frontend/src --json audit.json
```

退出码 `0` = 全部配齐，`1` = 有要补的（可直接接 CI）。

判定取三条线的并集，所以报「缺」= 连全站兜底都罩不住：

1. 同文件内有无同名 `:hover` / `:focus*` / `:active`
2. 该 class 是否挂在原生可聚焦标签（`button` / `a` / `input` …）上
3. `global.css` 里 `:where(...):focus-visible` / `:active` 兜底是否真实存在

### `analyze-style-coverage.py` —— 令牌覆盖度量

统计硬编码字号/色值、令牌用量、七种交互态覆盖率。

```bash
python scripts/analyze-style-coverage.py                       # 默认扫 frontend/src
python scripts/analyze-style-coverage.py before frontend/src stat-before.json
```

改造前后各跑一次，两份 JSON 放一起对比才有说服力。

---

## 二、Node 工具（需要 puppeteer-core）

### 一次性准备

`puppeteer-core` 已在根 `devDependencies` 里，`npm i` 之后直接可用。

> 用的是 **core** 版 —— 它不自带浏览器，所以不会被几百 MB 的
> Chromium 下载卡住（国内网络经常下不动）。

### 通用前置

三个脚本都要求**前后端在跑**：

```bash
npm run dev:backend     # 4000
npm run dev:frontend    # 5173
```

浏览器不用另外装，脚本会按顺序自动探测：

```
环境变量 CHROME_PATH → Windows Chrome → Edge → macOS Chrome → Linux chrome
```

探测不到会给出提示，照着设一下 `CHROME_PATH` 即可。

### `qa-shots.js` —— 截图存档

产出 `docs/shots/*.png`，7 个页面 + 悬停/焦点/空态共 10 张。

```bash
node scripts/qa-shots.js
```

**别用 `chrome --headless --screenshot`**：那个方式不推进 `requestAnimationFrame`，
Vue 的页面过渡会卡在 `fade-slide-enter-from`（`opacity:0`），拍出来一片空白。
必须用 puppeteer 驱动，让动画真的走完。

### `qa-e2e.js` —— 端到端验收

真实浏览器跑完整流程，9 项检查，失败以退出码 `1` 结束。

```bash
node scripts/qa-e2e.js
```

| # | 检查项 |
|---|---|
| 1 | 首页搜索 → 结果页有卡片 |
| 2 | 点开第一条 → 详情页标题正确 |
| 3 | 键盘 Tab 走查：焦点环真的可见（读 `computedStyle.boxShadow`） |
| 4 | 登录空提交 → 前端拦截并给文案 |
| 5 | UI 登录成功 → 导航显示问候 |
| 6 | 刷新不掉登录态 |
| 7 | 404 兜底渲染 |
| 8-9 | 移动端首页/资料库无横向溢出 |

结果写入 `docs/shots/e2e-report.json`。

> ⚠️ 会往**开发库**注册/复用一个测试账号（默认 `13900002020`）。别对着生产库跑。

### `diag-overflow.js` —— 横向溢出定位

窄屏下页面左右能划时，用它抓元凶。

```bash
node scripts/diag-overflow.js            # 默认 375 宽扫 /shelf
node scripts/diag-overflow.js / 320      # 指定路径与宽度
```

会列出超框元素，并带上 `flex-wrap` 与 `min-width`，
一眼看出是「没换行」还是「写死了最小宽度」。

装饰层（光晕、背景）常常故意超框但被 `overflow` 裁掉，
这类元素单独归到「无害」组，不混进元凶里报警。

---

## 三、环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `CHROME_PATH` | 自动探测 | 浏览器可执行文件路径 |
| `QA_BASE` | `http://localhost:5173` | 前端地址 |
| `QA_API` | `http://localhost:4000` | 后端地址 |
| `QA_OUT` | `docs/shots` | 截图输出目录 |
| `QA_PHONE` / `QA_PWD` / `QA_NAME` | 见 `qa-e2e.js` | 测试账号 |

---

## 四、什么时候该跑

| 场景 | 该跑什么 |
|---|---|
| 新增了可点元素 | `audit:interaction` |
| 改了字号/颜色/间距 | `audit:tokens` |
| 改了公共样式 | `qa:shots` + 看一眼 10 张图 |
| 提 PR 前 | `npm run verify` + `qa:e2e` |
| 页面在手机上能左右划 | `qa:overflow` |
