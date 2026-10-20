# 核心功能体验审查：资料库「预览/下载」+「AI 问答」

审查员：core-flows ｜ 站点：http://127.0.0.1:4000/（已实测 HTTP 200）
用户验收标准（原话，不可动摇）：「让资料库预览下载与 AI 问答这两个核心功能在页面中处于最突出位置」。
本文只回答这两件事够不够突出、为什么不够、怎么改；全站其他问题不在本文范围。

取证方式：① 读代码（路径:行号）② 读截图 `.agent/audit/shots/home-1440.png`（1440×2521）与 `home-390.png`
③ 对已跑的 4000 端口打真实接口（**游客身份、不带 token**）。
一屏 = 1440×900。截图各区块 y 坐标取自 `.agent/audit/shots/home-1440.dump.json`（vp=1440x900、docH=2521、hOverflow=false、brokenImgs=[]）。

---

## 1. 资料库预览与下载 —— 入口盘点

| # | 入口 | 文件:行 | 视觉位置 | 到能用几步 |
|---|---|---|---|---|
| 1 | 「在线预览」按钮 | `frontend/src/views/DocDetailView.vue:331-339`（文案 :338） | 详情页正文上方按钮行第 1 个，primary 实心 | 首页最短 **3 步**：输入→搜索→点卡片→点预览 |
| 2 | 「下载原件」按钮 | `frontend/src/views/DocDetailView.vue:340-347`（文案 :346） | 同上，紧邻第 2 个，primary **plain**（浅色描边，比预览更弱） | 3 步 **+ 注册/登录全流程**（游客被拦，见 §3） |
| 3 | 「在线预览」面板 | `frontend/src/views/DocDetailView.vue:376-382`（标题 :378、iframe :381） | 点按钮后才出现，详情页下半部，固定 660px 高 | 预览按钮之后 |
| 4 | 首页搜索框 | `frontend/src/views/HomeView.vue:119-133` | 首屏 hero 正中，全站最显眼 | **不是**预览入口，只把用户送去 `/shelf`（:31） |
| 5 | 最近收录卡片 | `frontend/src/views/HomeView.vue:211-213` → `frontend/src/components/DocCard.vue:38` | 第 2 屏，整卡是 RouterLink | 点卡片 1 步进详情，**卡上无预览/下载** |
| 6 | 资料库列表卡片 | `frontend/src/components/DocCard.vue:38`（全站唯一卡片组件） | `/shelf` 列表 | 同上，**列表页零预览/下载入口** |
| 7 | 顶部导航 | `frontend/src/components/SiteNav.vue:32-41` | 页面最顶 | 无预览/下载任何入口 |
| 8 | 页脚 | `frontend/src/components/SiteFooter.vue` | 页脚三列 | 无预览/下载任何入口 |

**结论：公众端真正的预览/下载入口只有 1 个 —— 资料详情页的按钮组。**
全前端 grep「预览|下载」命中 62 处，公众侧（非 admin）**只有 `DocDetailView.vue:338/346/378` 三处是按钮/面板**，
其余全是说明文案：`AboutView.vue:211`、`AboutView.vue:281`、`ShareDialog.vue:132`、`ChatBubble.vue:64`、`ChatBubble.vue:249`。

---

## 2. AI 问答 —— 入口盘点

| # | 入口 | 文件:行 | 视觉位置 | 到能用几步 |
|---|---|---|---|---|
| 1 | 全站浮动圆形气泡 | `frontend/src/components/HomeAskWidget.vue:218-228`（fixed :233-238、56×56 :239-243、气泡内只有「AI」两字 :227） | 每个页面**视口右下角**，任何滚动位置都在 | **1 步**：点气泡→面板自动展开（:84）→输入→发送 |
| 2 | 顶部导航第 6 项「AI 问答」 | `frontend/src/components/SiteNav.vue:40` | 导航最右（排最后） | 1 步进 `/chat`；页面自动静默建会话（`ChatView.vue:281-297`）→输入框在面板底部（:373-383）→发送 |
| 3 | 首页底部卡「不确定怎么找？直接问」+4 个示例+「打开 AI 助手」 | `frontend/src/views/HomeView.vue:232-248`（h2 :233、示例 :236-245、按钮 :247） | **第 3 屏** y≈1884，且只占右侧 1fr | **滚 2 屏 + 1 步**（全站成本最高） |
| 4 | 资料库零结果引导 | `frontend/src/views/ShelfView.vue:258-261` | 只有搜到 0 条时才出现 | 2 步，不可作为常规入口 |
| 5 | 页脚 | `frontend/src/components/SiteFooter.vue:62` | 页脚 | **只有一句文案，没有链接** |
| 6 | 关于页文案 | `frontend/src/views/AboutView.vue:212`、`:277` | 关于页正文 | 无按钮 |

**结论：AI 问答共 4 个真入口。** 唯一「最突出」的是右下角气泡（1 步、全站常驻），但它只有 56px、
只有「AI」两个字；首页里最正式的那个入口（有标题+示例+整宽绿按钮）被排到第 3 屏。

---

## 3. 预览/下载实现方式与功能残缺

**实现方式**
- 前端点按钮 → `frontend/src/api/docs.ts:394-408` `getPreviewUrl()` 取回 blob → `URL.createObjectURL` → 塞进 iframe（`DocDetailView.vue:381`）；
  下载走 `frontend/src/api/docs.ts:364-381` `downloadDoc()`，文件名前端拼「年份-机构-标题」（:276-283）。
  不用直链的原因写在 `frontend/src/api/docs.ts:384-393`：iframe/浏览器拿不到 HTTP 状态码，错误 JSON 会被当成文件存下来。
- 后端 `backend/src/routes/docs.ts:410-429` preview（`Content-Disposition: inline`）、`:437-458` download（attachment）；
  游客门禁 `backend/src/routes/docs.ts:306-318` `allowGuest()`：登录过→放行，否则读权限位，拒绝时 403 `GUEST_PREVIEW_CLOSED` / `GUEST_DOWNLOAD_CLOSED`。
- 权限默认值 `backend/src/guest/permissions.ts:131-142`；download 默认 false 的理由在 `backend/src/guest/permissions.ts:61-118`（「下载是『拿走』，且要留痕引导注册」）。

**实测（游客、无 token）**
- `GET /api/docs/eb85d5d0-ad7c-42ab-b7f5-d207287a1d83/preview` → **200**，`application/pdf`，**7,121,306 字节**，
  `Content-Disposition: inline` → **游客能直接预览** ✅
- `GET /api/docs/eb85d5d0-ad7c-42ab-b7f5-d207287a1d83/download` → **403**，
  `{"code":"GUEST_DOWNLOAD_CLOSED","message":"下载原件需要登录后使用，请先登录"}` → **游客下载被拦** ❌
- 运行时配置 `backend/data/guest-permissions.json`：`{aiAsk:true, aiAskDailyLimit:5, preview:true, share:true, feedback:true, download:false}`（2026-10-14 更新）
- 其余接口均 200：`/api/overview`（4944B）、`/api/docs?page=1&pageSize=3`（1087B）、`/api/docs/:id`（309B）

**功能残缺（6 条）**
1. **列表层零入口**：首页卡片与 `/shelf` 卡片上完全没有预览/下载按钮（`DocCard.vue` 全文无此字样）→ 想下载必须先进详情页。
2. **格式死路**：预览只有 iframe，Word/Excel 会空白——站点自己承认（`DocDetailView.vue:236-238`「若预览空白，请直接下载原件」），
   可游客点下载正好 403 → 这条路对游客是断的。
3. **大文件死路**：>20MB 直接拒绝预览（`DocDetailView.vue:165-171`；阈值 `frontend/src/api/docs.ts:261` = 20MB）并提示「建议下载后查看」，
   而下载对游客 403 → 第二条断头路。
4. 预览无翻页/缩放/全屏/页码，容器固定 660px（`DocDetailView.vue:647-653`），长文档只能在 iframe 里滚。
5. 下载无进度条、无断点续传、失败只靠一句 ElMessage（`DocDetailView.vue:200-202`）。
6. **对外口径写错自己**：`AboutView.vue:281` 与 `ShareDialog.vue:132` 都写「在线预览与下载原件需登录（注册免费）」，
   但运行配置 `preview:true`，游客实测能预览；`AuthView.vue:133` 的「提问无需注册；下载资料等操作需要登录」才是对的。

---

## 4. AI 问答实现方式与首屏可用性

- 前端**两套界面、共用渲染**：首页浮动气泡 `HomeAskWidget.vue`（面板 `v-show` :170、自动展开 :84）与独立页 `/chat`
  `ChatView.vue`（左 264px 会话列表 + 右对话流，:393-401，高 `calc(100vh - 132px)` :399）；气泡与等待文案共用
  `ChatBubble.vue`（:6 注释「复制一份必然漂移」）。
- 传输：原生 `fetch` + `getReader()` 解析 SSE（`frontend/src/api/ask.ts:78-148`；为什么不能用 axios 见 :5-7）；后端 `POST /api/ask`。
- 游客门禁 `backend/src/routes/ask.ts:97-118`：`aiAsk` 关 → 403 `GUEST_ASK_CLOSED`；超每日次数 → 403 `GUEST_ASK_LIMIT_REACHED`。
- **游客实测可用**：配置 `aiAsk:true, aiAskDailyLimit:5`；`backend/data/guest-ask-usage.json` 有真实用量
  （2026-10-15 两个访客 2 次 / 1 次，2026-10-14 1 次）。
- 首页气泡**不落库**（`frontend/src/api/ask.ts:55-61`：不传 conversationId = 一次性问答），`/chat` 才落库、可接着聊（`frontend/src/api/chat.ts:4-7`）。
- **官方嵌入挂件没接**：`backend/src/routes/embed.ts:15` 只有 `// TODO(韶茹): 实现 token 交换`（B08 空壳）；
  `HomeAskWidget.vue` 头注释已写明改走自建 `/api/ask`。
- **首屏可用性：首屏没有提问输入框。** 要提问只有三条路：(a) 点右下角 56px 气泡（1 步，但看不出是干什么的）；
  (b) 滚到第 3 屏点「打开 AI 助手」；(c) 走导航进 `/chat`（1 步，但要离开首页）。
- `/chat` 落地体验：会话在 `onMounted` 自动静默新建（`ChatView.vue:281-297`），输入框固定在对话面板**底部**（:373-383），
  空态只有 3 个 link 小字示例（:363-367）→ 首屏没有「这里可以提问」的主视觉。

---

## 5. 两者在首页视觉层级中的位置（截图佐证）

截图 `.agent/audit/shots/home-1440.png`（1440×2521，视口 1440×900）实测分屏：

- **屏 1（y 0–900）**：导航(47–112) → hero(93–539，H1 40px，**全场最大**) → 数据速览四数字条(567–661) → 「按主题找资料」(669–925，已被挤出屏底)
  - 首屏内可操作项只有：搜索框 + 「搜索」按钮 + 5 个常见检索标签（`HomeView.vue:119-140`）
  - **首屏没有任何预览/下载按钮，也没有任何 AI 提问输入框**
- **屏 2（y 900–1800）**：「按资料类型找」(925–1239) → 最近收录 6 张卡(1239–1817)
  - 这正是用户最想「预览/下载」的地方，而两个功能在这里**存在感为 0**（卡片只是链接，`DocCard.vue:38`）
- **屏 3（y 1800–2521）**：「关于这个知识库」+「不确定怎么找？直接问」(1861–2142，AI 卡 h2 y=1884) → 页脚(2230–2521，高 291px)
- **浮动「AI」气泡**：代码是 `position:fixed; right:24px; bottom:24px`（`HomeAskWidget.vue:233-238`），真实位置是**视口右下角**，任何滚动位置都在。
  ⚠️ 截图里它出现在整页 y≈650（页面 26% 处），这是 `.agent/audit/tools/audit.mjs:221-224` 用 `captureBeyondViewport:true` 抓整页造成的假象，
  **不代表真实位置**；按 900px 视口它应落在 y≈820–876，即**首屏底部右下角**。（取证教训：整页截图不能用来判断 fixed 元素在第几屏。）
- **视觉权重对比**：H1 40px vs 三个板块 H2 26px；AI 卡片 H2 也是 26px，但排在第 3 屏且只占右侧 1fr
  （`.about-ask` 栅格 1.25fr : 1fr，`HomeView.vue:656-661`）→ **"关于这个知识库"（左侧、更宽）反而比 AI 更突出**。
- **绿色 CTA 互相稀释**：hero 搜索按钮、AI 卡片整宽绿按钮(`HomeView.vue:247`)、浮动气泡同色；而 56×56、只有「AI」两字的那个，
  恰好是首屏唯一"看起来像 AI"的东西，也是最不说明用途的一个。

---

## 6. 改法建议

**A. 资料库预览/下载（5 条）**
1. **卡片上直接给「预览」按钮**（`/shelf` 列表 + 首页最近收录）：放在卡片底部与文件大小同一行，点击直接进详情页并自动展开预览面板。
   这是投入最小、收益最大的一条——用户最想预览的位置就是卡片本身。
2. **卡片上再给「下载」图标按钮**：登录态直接下；游客点击弹登录引导并带 `redirect` 回原页。让"下载"在列表层就可见，不必先进详情页。
3. **首屏补一句话 + 一个次级按钮**：hero 搜索框下方「常见检索」行旁写清「点开任意资料可在线预览，下载需登录」，
   消除"这个站能不能下载"的第一屏疑问（位置：`HomeView.vue:119-140` 附近）。
4. **预览面板升级**：660px 固定高改成占满剩余视口并支持全屏，面板头加「下载原件」按钮，做到"看完即存"一步到位
   （`DocDetailView.vue:647-653` / `:376-382`）。
5. **修对外口径**（二选一，别文案/配置打架）：把 `AboutView.vue:281` 和 `ShareDialog.vue:132` 改成
   「访客可直接在线预览；下载原件需登录」，与 `preview:true` 对齐；或反过来把 preview 收回登录后并同步改配置。

**B. AI 问答（5 条）**
1. **气泡改成带字胶囊**：右下角 56px 圆 +「AI」两字 → 「AI 问答」文字胶囊（或首次进入自动弹一条"可以从库里问答"的提示），
   位置不用动，可读性从"看不懂"变成"一眼知道"。
2. **把首页 AI 卡片从第 3 屏提到第 1–2 屏之间**（与数据速览条同一屏或紧随其后），并把宽度从右侧 1fr 改成与「关于」对半或更宽；
   4 个示例问题必须保留，它们是转化的关键（位置：`HomeView.vue:217-249` 整块）。
3. **hero 搜索框旁加并列入口「没找到？直接问 AI」**：把"搜索"和"提问"做成一对动作，现在搜索框是首屏唯一的动作。
4. **气泡面板补「进入完整问答页」链接**（现在从气泡进不了 `/chat`，`HomeAskWidget.vue` 没有这个跳转），
   并把游客每日 5 次的额度写在输入框旁——`backend/src/routes/ask.ts:105-115` 的限额用户现在完全看不见。
5. **`/chat` 空态改成"居中大输入框 + 3 个卡片式示例问题"**（替换 `ChatView.vue:363-367` 的 3 个小字 link），落地即可问；
   同时页脚「浏览」「使用」两列各补一条「AI 问答」「资料库」直达链接——现在页脚 0 个 AI 入口（`SiteFooter.vue:62` 只有文案）。

---

## 7. 未确认项清单

- **未确认**：登录后「下载原件」的完整链路是否真能拿到文件。我没有账号，游客态实测 403；登录后行为仅由代码推断
  （`DocDetailView.vue:184-204` → `frontend/src/api/docs.ts:364-381` → `backend/src/routes/docs.ts:437-458`），未实测。
- **未确认**：>20MB 资料在游客下载被拦时，页面是否给出比 ElMessage 更明确的下一步。
- **未确认**：Word/Excel 预览"空白"的真实表现（未实测，仅依据 `DocDetailView.vue:236-238` 的自述与 iframe+blob 实现）。
- **未确认**：手机端（`home-390.png`，390×5477）浮动气泡与「打开 AI 助手」按钮的叠压情况，未逐屏核对。
- **未确认**：`POST /api/ask` 的真实响应速度与逐字效果——未真正发问，避免消耗引擎额度与游客每日 5 次限额。
- **未确认**：首次访问首页是否会自动弹出 AI 面板/引导（`panelOpen` 默认 false，未在真机验证）。
