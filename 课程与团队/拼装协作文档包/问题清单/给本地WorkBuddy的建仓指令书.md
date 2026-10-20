# 建仓指令书（交给本地 WorkBuddy 执行）

> **给谁执行**：用户本地电脑上的 WorkBuddy（走本机通道，有 GitHub 权限）
> **目标**：一次性建好拼装协作主仓库 `widework`，包含目录骨架、契约文档、协作规则、全部机制文档
> **执行完成后**：回报执行结果（格式见第七节）
> **重要**：以下步骤按顺序执行，某步失败不要死磕，记录报错继续下一步，最后统一回报

---

## 〇、任务背景（30 秒读懂）

用户是「AI 向善实战营」P4 组的项目 owner。四个项目组（P3-A/P3-B/P4-A/P4-B）共同拼装开发一个产品「零废弃数字化知识库·对外版」，所有成果汇入统一的 GitHub 仓库，由用户本人（集成负责人）审核合并。

你要做的就是把这个仓库完整建起来，让全组可以开始领任务干活。

**仓库信息**：
- 属主 GitHub 账号：`a3230038469`
- 仓库名：`widework`
- 可见性：**Private（私有）**
- 描述：零废弃数字化知识库-对外版 | P3P4四组拼装协作主仓库

---

## 一、第 1 步：创建仓库

**方式 A（推荐）**：如果本机装了 `gh` CLI 并已登录：

```bash
gh repo create widework --private --description "零废弃数字化知识库-对外版 | P3P4四组拼装协作主仓库" --clone=false
```

**方式 B**：如果你有 GitHub MCP 工具且具备建仓权限，直接调用（name=widework, private=true, autoInit=true）。

**方式 C（兜底）**：如果 A、B 都不行，不要卡住——跳过本步，在回报里注明"请手动在 github.com 网页上建仓库（Private + 勾选 Add a README）"，然后继续执行第二步之后的文件准备（文件先在本机备好，等仓库建好后补传）。

---

## 二、第 2 步：克隆并搭建目录骨架

```bash
git clone https://github.com/a3230038469/widework.git
cd widework
git config user.name "a3230038469"
git config user.email "a3230038469@users.noreply.github.com"
```

创建目录骨架（每个目录放一个 README.md 说明用途，内容见下）：

```
mkdir -p docs/contracts frontend/src/pages backend/app/routers content deploy stats
```

**各目录 README.md 必须写入以下说明文字**（一句都不能少，这是全组的导航）：

| 文件 | 内容 |
|---|---|
| `docs/README.md` | `# docs 目录\n存放全组共享文档：contracts/（接口契约）、教程、拼装地图。\n契约文件为全组强约束，修改需走变更流程。` |
| `frontend/README.md` | `# frontend 目录\n门户前端（Vue3 + Vite + Element Plus）。\n一个页面一个子目录（src/pages/），一个页面 = 一个任务 = 一个负责人。\n只能调用契约 C3 定义的 API，禁止直连 WeKnora 引擎。` |
| `backend/README.md` | `# backend 目录\n门户后端（Python FastAPI）。\n一个接口组一个文件（app/routers/）。\napp/rag_proxy.py 是全仓库唯一允许出现 WeKnora 引擎地址的文件。` |
| `content/README.md` | `# content 目录\n知识库内容与清洗脚本。\nraw/ 存原始资料，annotated/ 存清洗后的标准数据。\n数据字段必须符合契约 C2。` |
| `deploy/README.md` | `# deploy 目录\n部署相关：docker-compose.yml、Nginx 配置、HTTPS 证书、上线手册。` |
| `stats/README.md` | `# stats 目录\n统计看板（F5）：Umami 配置、前端埋点封装、看板页。\n事件名必须符合契约 C4。` |

---

## 三、第 3 步：上传文档包到 `docs/`

用户会提供一个文件包（zip 已下载解压，或从对话附件获得）。把以下文件复制进 `docs/` 目录：

| 来源文件 | 放到 |
|---|---|
| 00-先读我-拼装协作文档索引.md | docs/ |
| 拼装式开发方案-v1.md | docs/ |
| 成果上GitHub-WorkBuddy全员交付教程.md | docs/ |
| Git拼装工作流教程-v2.md | docs/ |
| 拼装地图-模板.md | docs/ |
| 项目指令-拼装协作提示词.md | docs/（组长部署用） |

---

## 四、第 4 步：新建 5 个核心文件（内容逐字使用）

以下文件内容**逐字写入**，不要改写、不要润色：

### 4.1 根目录 `README.md`（覆盖 autoInit 生成的默认内容）

```markdown
# widework · 零废弃数字化知识库「对外版」

AI 向善实战营第四期 · P3P4 四组拼装协作主仓库。

四个项目组（P3-A / P3-B / P4-A / P4-B）共同开发同一个产品：把钉钉里的零废弃知识库（400+ 份公开资料 + AI 问答）搬到可对外分享的 Web 站点。

## 架构一句话

门户（自研 Vue3 + FastAPI）+ RAG 引擎（腾讯开源 WeKnora，对接阿里云百炼 Qwen），公网只暴露门户，引擎藏内网。

## 目录导航

| 目录 | 放什么 | 谁维护 |
|---|---|---|
| docs/ | 契约、教程、拼装地图 | 集成负责人 |
| frontend/ | 门户前端（一个页面一个任务） | 前端任务领取人 |
| backend/ | 门户后端 API（一个接口组一个任务） | 后端任务领取人 |
| content/ | 知识库内容与清洗脚本 | 内容任务领取人 |
| deploy/ | 部署配置与上线手册 | 部署任务领取人 |
| stats/ | 统计看板 | 看板任务领取人 |

## 开工三步

1. 领任务：Issues 页签 → 筛选「待领取」→ assign 自己 + 标签改「进行中」+ 评论"我认领"
2. 干活：在 WorkBuddy 项目对话里让 Agent 按任务要求干活（用文档包里的标准交付指令）
3. 交付：网页上传（见 docs/成果上GitHub-WorkBuddy全员交付教程.md）→ 发 PR，标题带 #任务号

## 铁律

- 提交信息必须带 #任务号
- 只改自己任务目录内的文件
- 字段名 / API 路径 / 事件名以 docs/contracts/ 契约为准，禁止自造
- main 分支受保护，只能通过 PR 合并
```

### 4.2 根目录 `CONTRIBUTING.md`（拼装规则）

```markdown
# 拼装协作规则（CONTRIBUTING）

本仓库的交付纪律。所有贡献者必须遵守。

## 1. 任务从哪来

所有任务 = GitHub Issues。标签体系：
- 板块：F0地基 / F1前端 / F2后端 / F3引擎 / F4内容 / F5看板 / F6部署
- 优先级：P0（demo必须）/ P1（结项前）/ P2（有余力）
- 状态：待领取 → 进行中 → 待评审（PR已发）→ 已合并

领取规则：assign 自己 + 状态标签改「进行中」+ 评论"我认领"。
一人同时最多 2 个「进行中」。72 小时无提交自动释放。

## 2. 分支与提交

- 分支命名：feat/{任务号}-{板块}-{简述}，例 feat/12-F1-login-page
- 提交信息：Conventional Commits + 任务号，例 feat: 完成登录页表单校验 #12
- 禁止直接 push 到 main，一律走 PR

## 3. PR 三道闸

1. CI 自动检查通过（红叉 = 修完再提）
2. 契约对照：PR 描述中勾选所用字段名与 docs/contracts/ 一致
3. 集成负责人审批

三关全过才能合并。

## 4. 契约变更流程（契约冻结后）

提出（Issue 中说明改什么为什么）→ 影响评估（列出受影响任务）→ 集成负责人拍板 → 广播全员。

契约冻结前（2026-10-04）可直接提修改建议；冻结后必须走此流程。

## 5. 红线

- 不改自己任务目录之外的文件（CI 会拦截越界引用）
- frontend 禁止出现 WeKnora 内网地址（只准走 /api/ask）
- backend 中 weknora 字样只允许出现在 app/rag_proxy.py 一个文件
- 字段名、API 路径、事件名不自造

## 6. 遇到问题

把报错原文（截图）发群里，@集成负责人。不要自己硬试。
```

### 4.3 `docs/contracts/C2-字段映射表.md`

```markdown
# C2 数据契约 · 文档（Document）字段映射表

> 状态：草案（2026-10-02），计划 2026-10-04 冻结
> 冻结后修改必须走 CONTRIBUTING.md 第 4 节变更流程
> 一致性要求：字段名必须与 C3 API 协议、C4 埋点事件表完全一致

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| doc_id | string | 是 | 文档唯一 ID，全局不变 |
| title | string | 是 | 文件名（检索的主对象，即文件名检索的匹配字段） |
| category | enum | 是 | 研究报告 / 政策法规 / 案例工具 / 各类标准（四选一，对齐 PRD 四大类） |
| topic | string[] | 否 | 主题标签（人工标注，供 R07 筛选用） |
| source | string | 是 | 来源机构 |
| year | int | 否 | 年份（筛选用） |
| file_url | string | 是 | 原文件地址（PDF/Word） |
| file_type | enum | 是 | pdf / word / other |
| upload_time | datetime | 是 | ISO 8601 格式 |
| status | enum | 是 | online（上架）/ offline（下架） |

## 待确认（10/4 冻结前）

- [ ] category 四分类与基金会 Excel 的现有分类如何映射（找 F4 内容管道负责人核对）
- [ ] topic 主题枚举清单（PRD R07 标注"待核对 Excel"）
- [ ] doc_id 生成规则（建议：系统自动生成，不携带业务含义）
```

### 4.4 `docs/contracts/C3-API协议.md`

```markdown
# C3 API 契约 · 门户后端接口协议

> 状态：草案（2026-10-02），计划 2026-10-04 冻结
> 统一约定：所有接口返回 {code, message, data} 包裹；code=0 成功
> 错误码段：1001 参数错误 / 2001 未登录 / 2002 无权限 / 2004 资源不存在 / 5000 服务端错误

| 方法 | 路径 | 用途 | 关键入参 | 关键出参 | 对应需求 |
|---|---|---|---|---|---|
| POST | /api/auth/register | 注册（5类信息+隐私提示） | phone, nickname, user_type, org, reason | token, user | R01 |
| POST | /api/auth/login | 登录 | phone, code | token, user | R01 |
| GET | /api/documents | 列表+文件名检索 | q, category, year, page, page_size | total, items[Document] | R02 R03 R07 |
| GET | /api/documents/{doc_id} | 文档详情 | - | Document + related[] | R08 |
| POST | /api/documents/{doc_id}/download | 下载（并计数） | - | file_url | R09 |
| POST | /api/ask | AI 问答（代理 WeKnora，唯一 AI 入口） | question, session_id | answer, citations[{doc_id,title,snippet}] | R05 R06 |
| POST | /api/events | 埋点上报 | event, props | ok | R04 |
| GET | /api/stats/summary | 看板聚合数据 | date_range | 按 C4 事件聚合的指标 | R04 |
| POST | /api/upload | 用户提交文件（进审核队列） | file, meta | ticket_id | R11 |
| POST | /api/feedback | 反馈提交 | content, contact | ok | R12 |

## 关键约束

- /api/ask 是门户唯一暴露的 AI 入口；前端永远不直连 WeKnora；引擎变更只改 backend/app/rag_proxy.py
- Document 结构以 C2 字段映射表为准
- 接口负责人：待集成负责人指派（每个接口写明负责人后在此补充）
```

### 4.5 `docs/contracts/C4-埋点事件表.md`

```markdown
# C4 埋点契约 · 事件表

> 状态：草案（2026-10-02），计划 2026-10-04 冻结
> 统一封装：前端 track(event, props)，props 字段名以本表为准
> 采集方式：Umami 自托管（无 Cookie，隐私友好），自建事件走 POST /api/events

| 事件名 | 触发时机 | 参数 | 对应看板指标 | 对应需求 |
|---|---|---|---|---|
| page_view_home | 进入首页 | referrer | 首页 PV/UV | §8 |
| search_submit | 提交检索 | query | 检索次数、关键词分布 | R03 |
| search_zero_result | 检索零结果 | query | 零结果率（目标 100% 有兜底） | R03 |
| doc_preview | 预览文档 | doc_id, from | 预览转化率 | R08 |
| doc_download | 下载文档 | doc_id | 下载转化率 | R09 |
| ai_ask | 发起 AI 问答 | question, session_id | 问答使用率 | R05 |
| ai_answer_view | 查看 AI 回答 | answer_id, latency | 平均响应延迟 | R05 |
| login_success | 登录成功 | user_type | 登录转化率 | R01 |
```

---

## 五、第 5 步：提交并推送

```bash
git add .
git commit -m "feat: 仓库初始化——目录骨架、契约三件套、协作规则、机制文档包"
git push origin main
```

---

## 六、第 6 步（可选，能做就做）

### 6.1 main 分支保护（防止直推）

```bash
gh api -X PUT repos/a3230038469/widework/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f 'required_pull_request_reviews[required_approving_review_count]=1' \
  -F 'enforce_admins=false' \
  -F 'required_status_checks[strict]=false' \
  -F 'restrictions=null' -F 'allow_force_pushes=false' -F 'allow_deletions=false'
```

失败不阻塞，回报里注明"分支保护未设置，请网页操作：Settings → Branches → Add rule → 勾 Require a pull request"。

### 6.2 拉协作者（拿到队友用户名清单后执行）

```bash
gh api -X PUT repos/a3230038469/widework/collaborators/{队友用户名} -f permission=push
```

---

## 七、完成后回报格式（发给用户）

```
【建仓结果】
1. 仓库创建：成功/失败（失败原因）
2. 目录骨架：已建 docs/contracts, frontend, backend, content, deploy, stats（列出实际完成项）
3. 文档上传：已传 X/6 份（列出缺的）
4. 核心文件：README / CONTRIBUTING / C2 / C3 / C4 已就位（是/否）
5. 推送：成功/失败
6. 分支保护：已设置/未设置
7. 仓库地址：https://github.com/a3230038469/widework
8. 遇到的问题与建议
```

---

## 八、验收标准（用户会用这个检查你的活）

- [ ] 打开 https://github.com/a3230038469/widework 能看到仓库
- [ ] 根目录有 README.md、CONTRIBUTING.md
- [ ] docs/ 下有契约三件套 + 6 份机制文档
- [ ] frontend/backend/content/deploy/stats 各有说明 README
- [ ] 提交记录显示初始化 commit

全部满足 = 完成。
