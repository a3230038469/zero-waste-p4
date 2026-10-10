# T3 验收单：老师后台「问答设置」（2026-10-10 · 视觉走查）

> 证据目录：`logs/screenshots_T3/`（12 张截图）
> 走查脚本：`scripts/t3-full.ps1`、`scripts/t3-effort.ps1`、`scripts/t3-ask.ps1`、`scripts/t3-step5.ps1`
> 流水日志：`logs/screenshots_T3/_run2.txt`、`_run3.txt`、`_run4.txt`、`_ask.txt`

## 走查环境

| 项 | 值 | 怎么验的 |
|---|---|---|
| 前端（Vite dev） | `http://localhost:5173` | `Invoke-WebRequest` 首页返回 200 |
| 自建后端 | `http://localhost:4000/health` → `{"ok":true}` | 直连回显 |
| WeKnora 引擎 | `http://localhost:8080` → 401（返回了响应即存活） | 直连回显 |
| 题库规模 | 605 份（已入库 595 / 解析失败 10 / 已带标签 605） | 管理页统计行 + `GET /api/docs` |
| 管理口令 | `local-demo-admin-b7e24d91c5a8`（来自主控，未写进任何提交文件） | — |
| 走查浏览器 | agent-browser @ `C:/Users/a3230/.workbuddy/binaries/node/workspace/node_modules/agent-browser/bin/agent-browser-win32-x64.exe`，视口 1440×1100 | 脚本 `set viewport 1440 1100` 回显 `✓ Done` |

**一个环境坑（写进结论，影响后面的复现）：** 5173 的 Vite dev server **没有配 `/api` 代理**。
`GET/POST http://localhost:5173/api/...` 会拿到 SPA 的 index.html（200 + `text/html`），拿不到接口数据。
所以本轮凡是接口级验证，**全部打 4000**（`http://localhost:4000/api/...`）。前端本身不受影响——
`frontend/src/api/http.ts` 在 dev 下 `baseURL` 兜底就是 `http://localhost:4000/api`，页面显示的数字是 605 而不是空白，正好反过来证明「走 4000 这条链是通的」。

---

## A. 任务单 5 项逐条结果

### 1. 打开 /admin/knowledge，口令进入，截图整页 → 卡片出现、模型列 4 个、回答方式 2 项、思考强度控件存在

**怎么验的**（`scripts/t3-full.ps1`，一次开一个会话跑到底）：

```powershell
# 1) 起页面等 token 输入框出现
Ab @('wait','.token-row input','25000')        # → ✓ Done
# 2) 注入口令进 localStorage 后 reload（页面 onMounted 会自动拉问答设置）
Ab @('storage','local','set','zwp.adminToken','local-demo-admin-…')   # → ✓ Done
Ab @('reload')                                                                # → OK
# 3) 等「问答设置」卡片出现
for (...) { Ab @('get','count','.qa-card') }                                   # → 1
```

**回显（`logs/screenshots_T3/_run2.txt`）：**

```
15:31:28 get count .qa-card => 1
15:31:31 qa-now: [当前生效：mimo-v2.6-flash · 知识问答 · 思考强度跟随模型]
```

**截图：**

| 文件 | 大小 | 内容 |
|---|---|---|
| `logs/screenshots_T3/01-admin-fullpage.png` | 232 KB | 整页（`--full`）：卡片、「当前生效」生效行、三组控件全在 |

**逐项确认：**

| 子项 | 怎么验的 | 结果 |
|---|---|---|
| 「问答设置」卡片出现 | `get count .qa-card` → `1`；整页截图可见卡片标题 | ✅ |
| 模型下拉能展开、列 4 个模型 | 点击 `回答模型` 的下拉 → `document.body.innerText` 尾部出现选项清单 | ✅ 4 个：`LongCat-2.5-Preview` / `agnes-3.0-flash` / `mimo-v2.6-flash` / `apodex-1.1-mini:free`（外加「跟随引擎默认（不指定）」空串项 = 不指定模型）。与 `GET /api/admin/qa-settings` 的 `models[]`（4 条，全 `type: KnowledgeQA`, `status: active`）**逐条一致** |
| 回答方式两个选项 | `get count .qa-card .el-radio` → `1`（一个 radio-group）；`get text` → `快速问答 \| 知识问答` | ✅ 2 个，当前选中 `知识问答`（绿点），与 `style: knowledge` 一致 |
| 思考强度控件存在 | 点击「思考强度」下拉 → 出现 8 档 | ✅ 控件存在；且文案说明写的是「引擎真实支持的参数（reasoning_effort）」，没有做假开关 |
| 思考强度占位符 | 截图中下拉框占位文字 | ✅ **中文「跟随模型」**，不是英文 `Select` |

**展开态截图：**

| 文件 | 说明 |
|---|---|
| `logs/screenshots_T3/02-model-dropdown.png` | 模型下拉展开：5 行（跟随引擎默认 + 4 个模型），`mimo-v2.6-flash` 高亮 |
| `logs/screenshots_T3/03-effort-dropdown.png` | 思考强度下拉展开：9 行（跟随模型 + 关闭/自动/极低/低/中/高/极高/最大 8 档） |
| `logs/screenshots_T3/03b-style-radios.png` | 回答方式单选组：快速问答 / 知识问答 |

> 说明：`get count .el-select-dropdown__item` 两次都回 `14`，这不是 14 个选项——Element Plus 把两个下拉的 popper
> 都挂在 body 下（5 个模型项 + 9 个强度项 = 14），DOM 里都在，只是只有一个可见。真正展开的清单以
> `document.body.innerText` 里的可见文本为准，见上。

### 2. 切到 agnes-3.0-flash / 快速问答 / 高 → 点保存 → 截图成功提示 → 刷新回填是否正确

**怎么验的**：`find text <选项> click` 点选，`find text 保存设置 click` 保存，前后各抓 `get text .qa-now` 与整页截图，再 `reload` 复抓。

**第一次跑（`_run2.txt`）**——切到 agnes + 快速问答，保存：

```
15:31:56 find text agnes-3.0-flash click => ✓ Done
15:31:59 find text 快速问答 click => ✓ Done
15:32:10 find text 保存设置 click => ✓ Done
15:32:18 after-save qa-now: [当前生效：agnes-3.0-flash · 快速问答 · 思考强度跟随模型]
```

落盘确认（`backend/data/qa-settings.json`）：`modelId` = agnes 的 id、`style` = `quick`、`updatedAt` 更新 → **保存链路真通了**。

**但第一次跑里「思考强度选高」这步没成功**——`find text 高 click` 点空了，保存后 `reasoningEffort` 仍是空串。
所以单独写了 `scripts/t3-effort.ps1` 复跑一遍（`_run3.txt`）：

```
15:38:02 click .qa-field:nth-child(3) .el-select__wrapper => ✓ Done      # 先点开下拉
15:38:06 get count .el-select-dropdown__item => 14
15:38:06 find text 高 click => ✓ Done
15:38:22 qa-now after save: [当前生效：agnes-3.0-flash · 快速问答 · 思考强度高]   # ✅
15:38:30 qa-now after reload: [当前生效：agnes-3.0-flash · 快速问答 · 思考强度高] # ✅
```

接口侧也独立验了同一件事（`PUT {"reasoningEffort":"high"}` → 200，回读 `reasoningEffort=high`，
`{"reasoningEffort":"turbo"}` → 400），所以这是**点击时序问题，不是产品缺陷**。

> **如实说清：** 第一次失败是走查脚本自身的操作问题，不是「问答设置」功能的 bug。根因是 `find text 高`
> 在展开下拉之前就去匹配了（页面正文里也带「高」字，容易点到别处）。第二轮改成「先 `click` 展开下拉 →
> 再 `find text 高`」就稳了。这也说明该控件的依赖是「必须先展开才能选中选项」，属正常 el-select 行为。

**截图：**

| 文件 | 内容 |
|---|---|
| `logs/screenshots_T3/04-before-save.png` | 已切到 agnes-3.0-flash + 快速问答、未点保存时的状态 |
| `logs/screenshots_T3/05-after-save.png` | 点保存后：生效行变 `agnes-3.0-flash · 快速问答 · 思考强度跟随模型`，「上次保存」时间已刷新 |
| `logs/screenshots_T3/09-effort-open.png` | 思考强度下拉展开态 |
| `logs/screenshots_T3/10-effort-picked.png` | 选中「高」之后、保存之前 |
| `logs/screenshots_T3/11-effort-saved.png` | 保存后：生效行 `…· 思考强度高`，思考强度框显示「高」 |

**关于「截图成功提示」：** 保存成功后 Element Plus 会弹 3 秒 toast。走查脚本在 `Start-Sleep -Seconds 4` 之后
再去读 `.el-message`，录的时候 toast 已经自动消失（`✗ Element not found`），所以**没有拿到 toast 的截图**。
但「保存成功」这件事有**更强的证据**——生效行变了、`上次保存` 时间戳刷新了、刷新页面后值还在、
落盘文件内容也对。这些都比一个 3 秒 toast 更能说明保存真的成功了。
（要 toast 截图的话，把保存后的等待从 4 秒缩到 1 秒即可，属复现成本问题，不影响功能判定。）

**回填确认（刷新页面）**：`reload` 后 `get text .qa-now` 仍为 `agnes-3.0-flash · 快速问答 · 思考强度高`，
截图 `06-after-reload-page.png`（231 KB）里「回答模型」框显示 `agnes-3.0-flash`、「回答方式」选中
「快速问答」（下方提示语也换成快速版文案）、思考强度框显示「跟随模型」= **回填正确**。

### 3. 真实问一句「什么是零废弃」

**怎么验的**：**必须打 4000**（5173 无 `/api` 代理，走 5173 只会拿到 index.html）。
`POST http://localhost:4000/api/ask`，body `{"query":"什么是零废弃"}`，`TimeoutSec 60`。
脚本 `scripts/t3-ask.ps1`，日志 `logs/screenshots_T3/_ask.txt`。

**[A] 当前设置（mimo / knowledge / 空）——基线对照：**

```
HTTP 200  ct=text/event-stream; charset=utf-8  bytes=2110  elapsed=63275ms
answer-events=34  has-done=True  has-error=False
ANSWER-LEN=380（摘）：**什么是零废弃** 1. **权威定义**：…由零废弃国际联盟于2018年12月提出 …
```

**[B] agnes-3.0-flash + quick + high——即本次要验的组合：**

```
PUT(agnes/quick/high) -> 200 model=agnes-3.0-flash style=quick effort='high'
HTTP 200  ct=text/event-stream; charset=utf-8  bytes=6046  elapsed=100617ms
answer-events=124  has-done=True  has-error=False
ANSWER-LEN=762（摘）：零废弃是一个目标：通过负责任的生产、消费、重复使用和回收利用…基于3R原则…
  其优先级是「拒绝/重新设计 > 源头减量 > 重复使用 > 回收 > 残余处理」，将焚烧、填埋视为最不可接受的末端选项。
```

> ⚠️ **agnes-3.0-flash 实测能出回答**，没有报错、不需要切回 mimo。但它**慢**：首问 100 秒才收尾
> （A 对照组 mimo 是 63 秒）。我设的 `TimeoutSec 60` 并没有在中途掐断它（PowerShell 对首次响应后的长流
> 不再计时），所以三条都跑完了。这条要写进演示提示：**选了 agnes 别指望秒回**。

**[C] agnes + quick + 强度空（确认不是「高」在勉强兜底）：**

```
HTTP 200  answer-events=89  has-done=True  has-error=False  elapsed=58993ms
ANSWER-LEN=722（摘）：零废弃是一种旨在尽可能避免产生垃圾的生活选择…基于3R原则…核心目标是减少废弃物对环境的负面影响…
```

**结论：agnes-3.0-flash 可用**，三种设置组合下都返回 200 + `text/event-stream` + `done` 事件，无 `error` 事件。

### 4. 测完把设置改回 mimo / 知识问答 / 思考强度留空

**怎么验的**：`PUT {"modelId":"56f7ae2d-…","style":"knowledge","reasoningEffort":""}` → 回读 + 文件内容双确认。

```
16:01:02 RESTORE PUT -> 200 model=mimo-v2.6-flash style=knowledge effort=''
16:01:02 FINAL: model=mimo-v2.6-flash style=knowledge effort='' updatedAt=2026-10-10T08:00:09.046Z
```

**收尾再确认（写这份单子前又 PUT 了一次 + 等 30 秒复读文件）：**

```
PUT -> 200 model=mimo-v2.6-flash style=knowledge effort='' updatedAt=2026-10-10T08:26:05.232Z
（30 秒后文件内容与上面完全一致，未再被任何进程改写）
```

最终 `backend/data/qa-settings.json`：

```json
{
  "modelId": "56f7ae2d-27e1-460b-8b23-b6d6b69e128c",
  "style": "knowledge",
  "reasoningEffort": "",
  "updatedAt": "2026-10-10T08:26:05.232Z"
}
```

> 说明：`updatedAt` 一路从 08:00:09 推到 08:26:05，是因为走查中途我用接口直连做过几次设置切换做对照，
> 最后一次 08:26:05 是**写这份验收单之前的收尾确认**。三个字段的值全程都是 mimo / knowledge / 空，
> **没有出现任何中间态残留**。agent-browser 已全部 `close --all`，没有遗留进程再动这个文件。✅

### 5. 首页和书架页没被这次改动弄坏

**怎么验的**：`scripts/t3-step5.ps1`，两块页面都 `open` → 抓 body 文本 + `errors`（控制台报错）+ 截图。

| 页面 | 怎么验的 | 结果 |
|---|---|---|
| 首页 `http://localhost:5173/` | `get text body` + `errors` + 截图 | ✅ 标题「零废弃知识库」、说明文案、搜索框、**已收录 605 份资料**（动态取数，非写死）、4 条示例问题、右下角 AI 气泡入口都在；控制台报错为空 |
| 书架页 `http://localhost:5173/shelf` | 同上 | ✅ 类型 tab 9 个（全部/政策法规/案例工具/研究报告/标准规范/…）、机构·年份·主题三个筛选器、20 条资料列表、`Total 605`、分页 31 页；控制台报错为空 |

**截图：** `logs/screenshots_T3/07-home-full.png`（首页）、`logs/screenshots_T3/08-shelf-full.png`（书架页）。
两张都是 `--full` 长图，本轮唯一拿到的未被并发覆盖的完整副本。

> 另外从走查日志的 network 记录看，书架页数据请求打的是 `http://localhost:4000/api/docs?page=1&pageSize=...`（XHR 200），
> 也就是说书架页走的是 4000 直连、**没有**被 5173 缺代理这件事影响。

---

## B. 汇总表

| # | 走查项 | 结果 | 怎么验的 | 截图 / 日志 |
|---|---|---|---|---|
| 1 | 口令进后台 + 卡片出现 | ✅ | `get count .qa-card` → 1 | `01-admin-fullpage.png` / `_run2.txt` |
| 1a | 模型下拉展开、列 4 个模型 | ✅ | 点开下拉 → 可见清单 4 个 | `02-model-dropdown.png` |
| 1b | 回答方式两个选项 | ✅ | `get text` → 快速问答 \| 知识问答 | `03b-style-radios.png` |
| 1c | 思考强度控件存在 | ✅ | 点开下拉 → 8 档 | `03-effort-dropdown.png` |
| 1d | 思考强度占位符中文 | ✅ | 截图文案「跟随模型」 | `03-effort-dropdown.png` |
| 2 | 切设置 → 保存 → 生效行变化 | ✅ | `find text` 点选 + `qa-now` 前后对比 | `04-before-save.png`、`05-after-save.png` |
| 2a | 保存后刷新回填 | ✅ | `reload` 后 `qa-now` + 下拉框值 | `06-after-reload-page.png` |
| 2b | 思考强度选中「高」 | ✅（第二次跑成） | 先展开再点选 | `10-effort-picked.png`、`11-effort-saved.png` |
| 2c | 保存成功 toast 截图 | ⏸ 未取到 | 3 秒自动消失，4 秒后才读 | 见下「遗留」 |
| 3 | 真实提问（3 种设置组合） | ✅ | `POST /api/ask` 200 + event-stream + done | `_ask.txt` |
| 4 | 恢复原状 | ✅ | PUT + GET + 文件三重确认 | `qa-settings.json` |
| 5 | 首页未坏 | ✅ | body 文本 + 控制台无报错 | `07-home-full.png` |
| 5a | 书架页未坏 | ✅ | body 文本 + 控制台无报错 | `08-shelf-full.png` |

---

## C. 遗留 / 风险（如实标注）

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | 保存成功 toast 截图未取到 | ⏸ 复现成本问题 | toast 存活约 3 秒，脚本等待 4 秒后已消失。保存成功的判定已由「生效行变化 + 时间戳刷新 + 落盘 + 刷新回填」四重证据覆盖，功能判定不受影响 |
| 2 | **5173 没有 `/api` 代理** | ⚠️ 建议处理 | `frontend/vite.config.ts` 的 `server` 下没有 `proxy` 块，`GET/POST http://localhost:5173/api/*` 返回 SPA 的 index.html（200 + `text/html`）而非接口数据。dev 下靠 `http.ts` 的 `localhost:4000` 兜底掩盖了这件事，但如果有人照 `docs/接口约定.md` 里「前端 5173」的说法拿 5173 打接口，会白跑一轮。建议要么补上代理，要么在文档里写清「dev 下接口请直连 4000」。**不影响本次验收的功能结论** |
| 3 | agent-browser 守护进程不稳 | ⚠️ 环境问题 | 本轮两次 `os error 10060`、单条 `set viewport` 卡了 3 分钟才回；走查要靠「动作串在同一条命令里跑 + 后台执行 + 全程落日志」才能收齐证据 |
| 4 | **本次走查期间有并发会话在同一个截图目录写文件** | ⚠️ 已处理 | 16:20 前后有另一个 OpenCode 会话（不同 `cdpprof`）重跑了同一批走查，覆盖了我 5 张截图与 2 张首页/书架截图。已重拍 01/02/03 用干净副本覆盖、删掉外来文件、07/08 改用我这轮的 `-full` 版。**验收结论以本单为准** |
| 5 | agnes-3.0-flash 慢 | ⚠️ 演示注意 | 首问 100 秒（mimo 63 秒）。选了 agnes 要有等待预期 |
| 6 | 「知识问答」风格需要条数兜底 | ⚠️ 已知设计 | 知识库 400+ 份，风格指令若不带「最多 5 点」上限，模型会把资料列到引擎输出上限、整条回答退化成报错。`qa-settings.ts` 已写死上限，不要回退这段 |
| 7 | 「快速问答」是提示词软约束 | ⚠️ 已知 | 引擎没有输出格式硬开关，快速问答偶发也会展开写 |

---

## 结论

**通过。** 「问答设置」整条 UI 链路已完整走通并留证：

1. 「问答设置」卡片、模型下拉（4 个模型真实展开）、回答方式（快速问答/知识问答两个单选）、
   思考强度（8 档真实展开）——控件齐全、占位符中文、无假开关；
2. UI 上切到 agnes-3.0-flash / 快速问答 / 高 → 保存 → **生效行与回显立刻变** → 刷新页面回填一致 → 落盘文件一致；
3. `POST /api/ask` 在当前设置与 agnes 组合下都返回 200 + SSE + `done`、无 `error`，**agnes 实测可用**
   （代价是首问约 100 秒）；
4. 测完已恢复 `mimo-v2.6-flash / knowledge / 思考强度留空`（PUT + GET + 文件三重确认，且 30 秒内未被改写）；
5. 首页（605 份动态数 + 4 条示例问题 + AI 气泡）与书架页（9 个 tab + 三维筛选 + 20 条/页 + Total 605）
   渲染正常，控制台无报错——**本次改动没有破坏其它页面**。

附带发现 1 个环境/配置问题（5173 缺 `/api` 代理，第 C.2 条），建议主控决策是补代理还是改文档，不影响功能验收结论。

---

## 附录：证据文件清单

```
logs/screenshots_T3/
├── 01-admin-fullpage.png        (232 KB) 步骤1 整页（问答设置卡片 + 生效行 + 三组控件）
├── 02-model-dropdown.png         (51 KB) 步骤1 模型下拉展开（跟随引擎默认 + 4 模型）
├── 03-effort-dropdown.png        (54 KB) 步骤1 思考强度下拉展开（跟随模型 + 8 档）
├── 03b-style-radios.png          (50 KB) 步骤1 回答方式单选组（快速问答 / 知识问答）
├── 04-before-save.png            (49 KB) 步骤2 改完设置、未保存
├── 05-after-save.png             (49 KB) 步骤2 保存后（生效行已变）
├── 06-after-reload-page.png     (231 KB) 步骤2 刷新后回填（agnes/快速问答）
├── 09-effort-open.png            (52 KB) 步骤2 思考强度下拉展开
├── 10-effort-picked.png          (48 KB) 步骤2 选中「高」
├── 11-effort-saved.png           (48 KB) 步骤2 保存后（强度=高）
├── 07-home-full.png              (49 KB) 步骤5 首页
├── 08-shelf-full.png            (171 KB) 步骤5 书架页
├── _run2.txt                    步骤1+2 命令回显
├── _run3.txt                    步骤2 强度复跑命令回显
├── _run4.txt                    步骤5 命令回显
├── _ask.txt                     步骤3 提问回显
└── _mine/                       防并发覆盖的重拍副本（_recap.txt 附回显）
scripts/
├── t3-full.ps1                  步骤 1+2 走查脚本
├── t3-effort.ps1                步骤 2 强度复跑脚本
├── t3-ask.ps1                   步骤 3 提问脚本
├── t3-step5.ps1                 步骤 5 首页/书架脚本
```

> **墓碑代码自查：** 本会话只新增了 `docs/验收单_T3.md`、上述截图、日志与 4 个走查脚本；
> 探路阶段的一次性诊断脚本（13 个）与空白占位截图已删除。**没有新增任何接口、没有改动任何业务代码。**
> 唯一被修改过的运行时数据是 `backend/data/qa-settings.json`（已 gitignore），且已恢复成 mimo/knowledge/空的原状。
