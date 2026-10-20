# T13 · 挑选合并丁梓柔 UI 改动（任务单）

> 派给：OpenCode（执行方）
> 主控：本对话（验收方，不信汇报，亲跑）
> 工作分支：`feat/merge-dingzi-ui`（基线 = main `60a7951`）
> 回退点：tag `backup-before-dingzi-merge-20261015`（= 60a7951）；任何一步坏了都能整支回退

---

## 〇、背景（一句话）

队友**丁梓柔**把她 10-12～10-13 的 UI 迭代推在分支 `feat/dingzi-frontend` 上（9 个提交、14 个文件），
**一直没合进 main**（她那条分支落后 main 29 个提交）。她这版从很早的位置分出去，**不能整分支 merge**，
必须**按文件挑选**合并。她的完整源码快照已下载到本地：

```
D:\projects\zero-waste-p4\.tmp\dingzi-src\a3230038469-zero-waste-p4-dac7637\
```
（下称 `<她>`，例如 `<她>\frontend\src\components\ChatBubble.vue`）

逐文件 diff 留档在 `D:\projects\zero-waste-p4\.tmp\dingzi-patches\*.patch`（可参照，但**以快照文件为准**）。

---

## 一、红线（违反即返工，不许商量）

1. ❌ **禁止 `git merge feat/dingzi-frontend`**，禁止整分支合并/整文件覆盖式替换（除下面写"直接复制"的 4 个新文件）。
2. ❌ **不许动 `backend/**`**（本轮 100% 前端）。
3. ❌ **不许动**：`frontend/src/views/Admin*.vue`、`frontend/src/api/**`、`frontend/src/utils/qrcode.ts|download.ts|tokenUserId.ts`、`frontend/src/components/FeedbackDialog.vue|FeedbackForm.vue`、`frontend/src/composables/**`、`frontend/src/router/**`。
4. ❌ **不许把她的 `SiteFooter.vue`「意见反馈」弹窗搬进来**（页脚已有 B09 的反馈入口且已接 T11 游客开关；她那个是第三份重复，且没接开关 → 会产生"假成功"）。→ **`SiteFooter.vue` 本次一行都不改**。
5. ❌ **不许丢我们已有的功能**（改完必须逐条 grep 证明还在）：
   - T9/T9b：`ChatBubble.vue` 里的 `const SOURCE_TAG` 正则、`cleanDisplayName`、`kb-link` 胶囊渲染、`INLINE_CITE`；`<kb … />` 必须仍能渲染成可点胶囊、不许原样漏出
   - T12：`ShelfView.vue` 里的 `directionTabs` / `activeDirection`（顶部方向标签）整套结构
   - T11：`AboutView.vue` 里的 `guestAllowed('feedback')` + `<FeedbackForm v-if="feedbackAllowed" />`
   - B09：`site-footer` 的反馈入口、`DocDetailView` 的「反馈这份资料」
6. ❌ 不许新增依赖（`package.json` / `package-lock.json` 不动）。
7. ❌ 不许改数据、不许改 `.env`。
8. ✅ 每一步改完都要能过 `npm run verify`（后端 lint+typecheck、前端 lint+vue-tsc 四条，**零错误零警告**）。

---

## 二、逐文件任务（这就是全部范围，不要自行扩大）

### A 组：直接要

| # | 文件 | 动作 |
|---|---|---|
| 1 | `frontend/public/favicon.ico` | **直接复制** `<她>\frontend\public\favicon.ico` |
| 2 | `frontend/public/zero-logo.png` | **直接复制** |
| 3 | `frontend/public/zero-logo-192.png` | **直接复制** |
| 4 | `frontend/src/utils/askCopy.ts` | **直接复制**（新文件；问答对外文案单一来源：免责/作答范围/固定拒答/无来源提示） |
| 5 | `frontend/src/utils/typeTone.ts` | **直接复制**（新文件；资料分类配色+图标体系）。复制后**先通读一遍**，确认它没有 import 任何不存在的模块；若引用了 main 里没有的东西，改为本地等价实现并在交付说明里写明 |

### A 组：改 `frontend/index.html`

在 `<head>` 内、`<meta name="viewport">` 之后加 3 行（位置照她那样）：

```html
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="192x192" href="/zero-logo-192.png" />
<link rel="apple-touch-icon" href="/zero-logo-192.png" />
```

🔴 **`<!-- share-meta:start --> … <!-- share-meta:end -->` 整段一个字都不许动**（B09 分享卡片靠它做后端替换）。

### A 组：`frontend/src/components/HomeAskWidget.vue`

照她那份（`<她>\...\HomeAskWidget.vue`）改三处：
1. 引入 `ASK_DISCLAIMER` / `ASK_SCOPE_NOTE` / `NO_ANSWER_TEXT`（来自 `../utils/askCopy`）
2. `send()` 里 `if (msg && !msg.text)` 分支：**不再**设 `failed` + "AI 没有返回内容，请稍后再试"，改为 `msg.noAnswer = true` + `msg.text = NO_ANSWER_TEXT`
3. 输入框那一行下面加常驻说明 `<p class="ask-note">{{ ASK_SCOPE_NOTE }} · {{ ASK_DISCLAIMER }}</p>` + 对应样式

### B 组：`frontend/src/components/ChatBubble.vue`（手工挑，两段都不同区域）

1. `BubbleMessage` 加可选字段 `noAnswer?: boolean`（注释说清"这不是故障，是库内确实没有"）
2. 加 `showNoSourceNote` computed（条件照她那份：assistant + 非 streaming + 非 failed + 非 noAnswer + 正文非空 + sources 为空）
3. 模板：根 div 的 class 加 `'no-answer': message.noAnswer`；正文后加拒答标签 `<p v-if="message.noAnswer" class="no-answer-label">` 与无来源提示 `<p v-if="showNoSourceNote" class="no-source">`
4. 样式：`.bubble.no-answer` / `.no-answer-label` / `.no-source` 三段照她那份抄

🔴 **绝对不许碰**：`SOURCE_TAG`、`cleanDisplayName`、`FILE_ICON`、`findSourceUrl`、`renderAnswer`、`INLINE_CITE`、`.kb-link` 相关样式与 `onBodyClick`。她那版是在我们 T9 之前分出去的，**她那版没有 kb 胶囊**——所以**只挑上述 4 点**，不要去覆盖整个文件。

### B 组：`frontend/src/views/ChatView.vue`

照她那份改：
1. 引入 `useRoute`；`pulledKeyword` ref
2. `onMounted` 里读 `route.query.q` → 预填 `draft`，并在 finally 里 `focusInput()`
3. `!msg.text` 分支 → `noAnswer` + `NO_ANSWER_TEXT`
4. 模板：输入框下方加 `<p v-if="pulledKeyword && messages.length === 0" class="pulled">` 说明行；底部加 `<p class="foot-note">{{ ASK_SCOPE_NOTE }}；{{ ASK_DISCLAIMER }}</p>`；`main-tip` 文案改成"引用可点开原文核对"
5. 样式：`.pulled` / `.pulled strong` / `.foot-note` 三段

（注意：main 的 ChatView 可能已与她那版有差异，**逐块加**，不要整文件替换。）

### B 组：`frontend/src/views/ShelfView.vue`（只改一个函数）

`goAskAi()` 改为：把当前关键词带过去、跳 `/chat`：

```ts
function goAskAi(): void {
  const q = keyword.value.trim()
  void router.push(q ? { path: '/chat', query: { q } } : { path: '/chat' })
}
```

🔴 **不要**动：`directionTabs` / `activeDirection` / `refreshFacets` / 顶部方向标签结构。
🔴 **本轮不做**"类型标签配色/图标"（她那个落点在 T12 里已被删掉，改造属新开发，**不在本任务范围**）。

### B+D 组：`frontend/src/views/HomeView.vue`

照她那份改（D 组已获小志批准）：
1. 首屏标语 `.hero-lead` 换成她的**三行**文案（`<span class="lead-line">` × 3）+ 衬线字体/绿色/行距 2.1 那套样式
2. 首屏整体居中（`.hero` 的 `margin:0 auto; text-align:center`、`::after` 渐变分隔线、`.search-row`居中、标签行 `justify-content:center`、窄屏 `.hero-lead` 字号微调）
3. 分类卡片：`:style="cardToneVars(t.value)"`；最近收录卡片：`:style="cardToneVars(doc.type)"`；配 `.type-card` 悬停扩散、`.type-name::before` 图标、`.doc-grid .doc-card` 左色带与悬停扩散、`.doc-grid :deep(.type-badge::before)` 图标 等样式段
4. import `cardToneVars` from `../utils/typeTone`

### B 组：`frontend/src/views/AboutView.vue`（本轮最难，务必仔细）

目标 = 她的**新版卡片化版面** + 我们 main 已有的两样东西（必须都在）：
1. 套她的结构：六个板块各收进 `.panel` 圆角白卡片 + 新增 `id="foundation"`「关于基金会」板块（基金会简介 / 与知识库的关系 / 机构宗旨…）+ tab 菜单加 `{ id: 'foundation', label: '关于基金会' }`
2. 官网跳转确认：`FOUNDATION_SITE` 常量 + `openFoundationSite()`（`ElMessageBox` 确认后 `window.open`）+ 触发按钮
3. 🔴 **必须保留**：`import FeedbackForm from '../components/FeedbackForm.vue'`、`const feedbackAllowed = computed(() => guestAllowed('feedback'))`、模板里 `<FeedbackForm v-if="feedbackAllowed" />` 与"访客反馈已关闭"那句兜底提示 —— 把这一段**放进她的新结构**（原有位置/锚点对应的地方），不许丢
4. import `ElMessage, ElMessageBox` from 'element-plus'

### C 组：**不改**

`frontend/src/components/SiteFooter.vue` —— 一行都不动。

---

## 三、交付要求

1. 改完必须跑通：`npm run verify`（四条零错误零警告）+ `npm run build`
2. **自证落盘**：用 `grep`/`ls` 逐条证明给你自己的改动，并把证据贴进交付说明：
   - `ls frontend/public/` 三个新图标在
   - `grep -c "kb-link" frontend/src/components/ChatBubble.vue`（必须仍有，证明 T9 没丢）
   - `grep -c "directionTabs" frontend/src/views/ShelfView.vue`（必须仍有，证明 T12 没丢）
   - `grep -n "FeedbackForm\|guestAllowed" frontend/src/views/AboutView.vue`（必须有，证明 T11+瑞泽的表单没丢）
   - `git status --short`（列出改了哪些文件，**应只有本文档第二节列出的文件**）
3. 写一份 `docs/T13-交付说明.md`：逐条对照本任务单（做了什么/怎么验的/哪条没做及原因）
4. **不许自行扩大范围**：发现"顺手还能改"的地方 → 记进交付说明的"建议"，不要动

## 四、止损（小志点名要求）

- 任一步 `npm run verify` 修不过、或发现要动红线文件才能继续 → **立刻停手**，不要硬做
- 停手后执行：`git checkout -- .` + `git clean -fd frontend/src frontend/public` 回到本分支基线，然后在交付说明里如实写"卡在哪、什么原因"
- 主控侧的回退命令（供你理解，不用你执行）：`git checkout main && git reset --hard backup-before-dingzi-merge-20261015`
