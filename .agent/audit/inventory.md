# 公众端页面模块与内容清单（只读审计）

审计人：page-inventory ｜ 依据：frontend/src 源码逐文件通读 ｜ 全部结论附 `文件路径:行号`
纪律：只列事实，不做设计建议；不确定的写「待确认」，不推测。

---

## 一、路由清单（共 15 条：14 条实际路径 + 1 条 404 兜底；其中公众页 8 条、后台页 6 条）

路由表唯一来源：`frontend/src/router/index.ts:24-52`。**全表没有任何 `beforeEach` 守卫**，
只有 `afterEach` 埋点（`frontend/src/router/index.ts:62-64`）→ 访问控制全部落在页面内部或后端。

| 路径 | 视图文件 | 标题 / 用途 | 需登录？ | 分类 | 行号 |
|---|---|---|---|---|---|
| `/` | `frontend/src/views/HomeView.vue` | 首页：定位 + 检索 + 数据速览 + 主题/类型/最新 + AI 问答 | 否 | 公众核心 | `router/index.ts:25` |
| `/shelf` | `frontend/src/views/ShelfView.vue` | 资料库：方向标签 + 五维筛选 + 卡片列表 + 分页 | 否 | 公众核心 | `router/index.ts:26` |
| `/insights` | `frontend/src/views/InsightsView.vue` | 数据概览：6 口径卡 + 年份柱图 + 类型/主题/机构条形图 | 否 | 公众次要 | `router/index.ts:27` |
| `/about` | `frontend/src/views/AboutView.vue` | 关于项目：基金会/简介/怎么用/口径/引用/联系六段 | 否 | 公众次要 | `router/index.ts:28` |
| `/chat` | `frontend/src/views/ChatView.vue` | AI 问答独立页：左会话列表 + 右对话流 | 否（前端不校验；游客额度只在后端） | 公众核心 | `router/index.ts:30` |
| `/contribute` | `frontend/src/views/ContributeView.vue` | 我要投稿 + 意见反馈（两个 Tab） | 投稿需登录；反馈不需要 | 公众次要 | `router/index.ts:32` |
| `/doc/:id` | `frontend/src/views/DocDetailView.vue` | 资料详情：元数据 + 预览/下载/分享/反馈 + 同主题推荐 | 页面可看；四个动作按游客权限 | 公众核心 | `router/index.ts:33` |
| `/auth` | `frontend/src/views/AuthView.vue` | 登录 / 注册（同一页两个 Tab） | 否 | 公众次要 | `router/index.ts:34` |
| `/admin/stats` | `frontend/src/views/AdminStatsView.vue` | 后台·访问统计与使用明细（`GET /api/track/stats`） | 无路由守卫；页面内输管理口令 | 后台内部 | `router/index.ts:36` |
| `/admin/knowledge` | `frontend/src/views/AdminKnowledgeView.vue` | 后台·资料管理（列表/上传/删除/重传/导出台账） | 同上（X-Admin-Token） | 后台内部 | `router/index.ts:38` |
| `/admin/users` | `frontend/src/views/AdminUsersView.vue` | 后台·注册用户（手机号后端脱敏） | 同上 | 后台内部 | `router/index.ts:40` |
| `/admin/feedback` | `frontend/src/views/AdminFeedbackView.vue` | 后台·访客反馈列表 + 导出 | 同上 | 后台内部 | `router/index.ts:42` |
| `/admin/contributions` | `frontend/src/views/AdminContributionsView.vue` | 后台·投稿审核队列（通过/退回） | 同上 | 后台内部 | `router/index.ts:44-48` |
| `/admin/settings` | `frontend/src/views/AdminSettingsView.vue` | 后台·智能体/解析引擎设置 + 一键自检 + 游客权限 | 同上 | 后台内部 | `router/index.ts:50` |
| `/:pathMatch(.*)*` | `frontend/src/views/NotFoundView.vue` | 404 兜底 | 否 | 公众次要 | `router/index.ts:51` |

**全局壳**：`frontend/src/App.vue:15-28` = MouseGlow 装饰层 + SiteNav + RouterView + SiteFooter，
套在所有路由外面（含后台页）。`MouseGlow` 在 `frontend/src/App.vue:16`，无 z-index 遮挡问题（`App.vue:31-37`）。

---

## 二、公众页面区块清单（从上到下）

### 2.1 顶部导航（每一页都有）`frontend/src/components/SiteNav.vue`
| 区块 | 内容 | 数据来源 | 行号 |
|---|---|---|---|
| 品牌区 | logo `zero-logo.png` + 「零废弃知识库 / 六尺巷基金会」 | 静态资源 | `SiteNav.vue:56-64` |
| 主导航 6 项 | 关于项目 / 首页 / 资料库 / 我要投稿 / 数据概览 / AI 问答 | 数组写死 | `SiteNav.vue:32-41`，渲染 `:66-76` |
| 登录态区 | 「XX，你好」+ 退出 / 「已登录」+ 退出 / 「登录 / 注册」 | `useAuth().user` | `SiteNav.vue:78-88` |
| 退出登录 | 清 token 回首页 | 本地 | `SiteNav.vue:43-46` |

### 2.2 页脚（每一页都有）`frontend/src/components/SiteFooter.vue`
| 区块 | 内容 | 数据来源 | 行号 |
|---|---|---|---|
| 站点简介 + 份数 | 一段定位描述 + 「已收录 N 份资料」 | 简介写死；份数取 `getOverview().total` | 简介 `:60-63`，份数 `:64-66`，接口 `:47-52` |
| 浏览列 | 资料库 / 我要投稿 / 数据概览 / 关于项目 | 路由写死 | `SiteFooter.vue:71-74` |
| 使用列 | 数据来源与口径 / 引用与转载 / 意见反馈 / 联系与共建 | 路由写死 | `SiteFooter.vue:79-89` |
| 站点列 | 登录注册 + **4 个「（内部）」后台链接** | 路由写死 | `SiteFooter.vue:94-98` |
| 版权与免责 | © 年份 + 「权利归原作者与发布机构所有；引用请注明原始出处」 | 写死（年份现算） | `SiteFooter.vue:102-108` |
| 站点级反馈弹窗 | `FeedbackDialog scope="site"` | `constants/feedback.ts` | `SiteFooter.vue:111` |

### 2.3 首页 `/` `frontend/src/views/HomeView.vue`
| # | 区块 | 内容 | 数据来源 | 行号 |
|---|---|---|---|---|
| 1 | 首屏 | 眉标 + 大标题 + **三行标语** + 搜索框 + 5 个常见检索 chip | 全部写死（chip 数组写死在模板里） | 眉标/标题 `:107-111`，标语 `:113-117`，搜索 `:119-133`，chip `:135-140` |
| 2 | 数据速览 | 4 格：收录资料 / 覆盖年份 / 发布机构 / 主题领域 + 「查看数据概览 →」 | `GET /api/overview` | 计算 `:49-57`，渲染 `:144-152` |
| 3 | 按主题找资料 | 前 12 个主题 chip（带份数）→ `/shelf?tag=` | `overview.topics` | `:60`、`:155-177` |
| 4 | 按资料类型找 | 库里全部类型卡（带份数、配色、图标）→ `/shelf?type=` | `overview.types` + `utils/typeTone` | `:63`、`:180-200` |
| 5 | 最近收录 | DocCard 网格 | `overview.latest` | `:65`、`:203-214` |
| 6 | 关于这个知识库 | 一段介绍 + 3 条要点 + 去关于页链接 | 写死 | `:218-230` |
| 7 | 不确定怎么找？直接问 | 4 个示例问题 chip + 「打开 AI 助手」按钮 | 问题写死 `:69-74` | `:232-248` |
| 8 | 右下角 AI 挂件 | 悬浮球 + 面板（示例问题 / 气泡流 / 输入框 / 常驻说明） | `POST /api/ask`(SSE) | `:251` |

### 2.4 资料库 `/shelf` `frontend/src/views/ShelfView.vue`
| # | 区块 | 内容 | 数据来源 | 行号 |
|---|---|---|---|---|
| 1 | 页头 | 「资料库 / 全部资料」+ 一句说明 + **共收录 N 份** | `GET /api/docs` 的 total | `:324-332` |
| 2 | 方向标签 | 全部 / 零废弃 / 化学品与健康（带份数） | 一次不带筛选的 `GET /api/docs/facets` | 计算 `:102-114`，渲染 `:337-351`，取数 `:289-291` |
| 3 | 工具栏第一行 | 机构文本输入（回车筛）/ 主题多选 / 知识类型 | `facets.tags`、`facets.types` | `:356-395` |
| 4 | 工具栏第二行 | 年份多选 / 排序（按年份、按最新收录）/ 关键词 | `facets.years` | `:400-425` |
| 5 | 当前筛选 | chip 回显 + 「全部清除」 | 本地状态 | `:130-143`、`:429-441` |
| 6 | 列表 | 8 张骨架卡 → DocCard 网格 + 分页（每页 20） | `GET /api/docs` | 骨架 `:444-448`，卡片 `:451-453`，分页 `:455-464`，PAGE_SIZE `:51` |
| 7 | 空结果 | 「没有匹配的资料」+ 清除筛选 / **试试问 AI** | 本地 | `:467-473` |
| 8 | 页脚 | 全局 SiteFooter | — | `App.vue:26` |

### 2.5 数据概览 `/insights` `frontend/src/views/InsightsView.vue`
| # | 区块 | 内容 | 数据来源 | 行号 |
|---|---|---|---|---|
| 1 | 页头 | 标题 + 明示「数字来自 `GET /api/overview`」 | 写死 | `:93-100` |
| 2 | 口径卡 6 格 | 收录资料（含去重数）/ 资料体积 / 覆盖年份 / 发布机构 / 知识类型 / 主题领域 | `overview` | `:66-77`、`:110-118` |
| 3 | 按年份分布 | CSS 柱状图 + 「收录最多：X 年」+ 图下合计 | `overview.yearBuckets` | `:36-44`、`:79-84`、`:121-148` |
| 4 | 按资料类型 / 按主题领域 | 两条横向条形榜（各前 12） | `overview.types/topics` | `:61-62`、`:151-177` |
| 5 | 发布机构 Top 10 | 横向条形榜 + 指路资料库筛选 | `overview.topOrgs` | `:63`、`:180-193` |
| 6 | 统计口径与已知局限 | 5 条：份数口径 / 去重 / 主题覆盖 / 机构计数 / 统计时间 | `overview` 计数 + 写死文案 | `:196-218` |
| 7 | 加载/失败态 | skeleton / 「暂时取不到统计数据」+ 重新加载 | — | `:102-106` |

### 2.6 关于项目 `/about` `frontend/src/views/AboutView.vue`
目录锚点 6 项：`SECTIONS` `:58-65`，渲染 `:135-137`。

| # | 区块（id） | 内容 | 数据来源 | 行号 |
|---|---|---|---|---|
| 1 | 页头 | 标题 + 一句定位 | 写死 | `:127-133` |
| 2 | 关于基金会 `#foundation` | 机构名 + 简介 / 与知识库关系 / 机构宗旨 / 核心方向 5 条 / 合作说明 + 「详情查看」 | 文案写死；「详情查看」跳 `FOUNDATION_SITE` | 区块 `:140-193`；官网常量 `:73`；跳转逻辑 `:93-122` |
| 3 | 项目简介 `#about` | 3 段正文 + **6 格事实卡** + 口径指引 | 事实卡取 `GET /api/overview` | 正文 `:199-214`，卡 `:45-55`、`:216-221` |
| 4 | 怎么用 `#use` | 4 张卡：按主题浏览 / 四维筛选 / 关键词检索 / 直接提问 + 登录提示 | 写死 | `:227-285` |
| 5 | 数据来源与口径 `#data` | 1 段 + 5 行口径表（份数/年份/主题/重复副本/来源链接） | 部分取 `overview`（yearUnknown、duplicateGroups、duplicateCopies） | 表 `:298-347` |
| 6 | 引用与转载 `#cite` | 1 段 + 4 条规则（含「不构成专业意见」） | 写死 | `:357-373` |
| 7 | 联系与共建 `#contact` | 1 段 + 反馈表单/关闭提示 + **「待基金会确认后补充（占位）」块** | 表单走 `POST /api/feedback` | 表单 `:390`，关闭提示 `:391-394`，占位块 `:396-408` |
| 8 | 页脚行 | 「本页口径说明最后更新于 2026-10-10；反馈受理方式于 2026-10-14 补充。」 | 写死（日期硬编码） | `:412` |

### 2.7 AI 问答 `/chat` `frontend/src/views/ChatView.vue`
| # | 区块 | 内容 | 数据来源 | 行号 |
|---|---|---|---|---|
| 1 | 左·会话列表 | 「我的对话」+ 新建；每条：标题/相对时间/条数/摘要 + 删除（hover 显形） | `GET /api/chat/conversations` | `:312-347` |
| 2 | 右·顶栏 | 当前会话名 + 「引用可点开原文核对」 | 本地 | `:350-356` |
| 3 | 对话流 | ChatBubble 气泡（Markdown + 来源卡片） | `POST /api/ask`(SSE) + `fetchMessages` | `:358-379` |
| 4 | 示例问题 | 3 个（与首页挂件逐字相同） | 写死 `:63` | `:381-385` |
| 5 | 资料库带词说明 | 「已把你在资料库里搜的…带过来」 | 路由 query `q` | `:388-390`、`:283-287` |
| 6 | 输入区 + 常驻口径 | 输入框/发送 + 「作答范围；免责声明」 | `utils/askCopy.ts` | `:392-403`、`:407` |

### 2.8 我要投稿 `/contribute` `frontend/src/views/ContributeView.vue`
| # | 区块 | 内容 | 数据来源 | 行号 |
|---|---|---|---|---|
| 1 | 页头 | 「我要投稿 · 意见反馈」+ 一句说明 | 写死 | `:233-239` |
| 2 | Tab1 未登录 | 「投稿需要先登录」+ 去登录 | `useAuth().isLoggedIn` | `:245-252` |
| 3 | Tab1 表单 | 说明条 + 选 PDF + 标题 + 机构/年份/类型/主题（四维 `allow-create`）+ 投稿说明 | 选项来自 `GET /api/docs/facets` | 表单 `:255-362`，facets `:70-81` |
| 4 | Tab1 我的投稿 | 计数 + 待审 tag + 表格（标题/状态/时间/审核说明） | `fetchMyContributions()` | `:365-396` |
| 5 | Tab2 意见反馈 | 说明 + 分类单选 + 详细说明 + 联系方式 + 提交 | `constants/feedback.ts` → `POST /api/track` | `:401-436` |

### 2.9 资料详情 `/doc/:id` `frontend/src/views/DocDetailView.vue`
| # | 区块 | 内容 | 数据来源 | 行号 |
|---|---|---|---|---|
| 1 | 返回资料库 | 文字按钮 | 路由 | `:269` |
| 2 | 资料头 | 类型徽标 / 年份 / 体积 + 标题 | `GET /api/docs/:id` | `:285-291` |
| 3 | 元数据表 | 发布机构 / 发布年份 / 资料类型 / 文件体积 / 原始出处（可空） | 同上 | `:293-316` |
| 4 | 主题标签 | 可点 chip → `/shelf?tag=` | 同上 | `:318-323` |
| 5 | 重复副本提示 | 「本条目与库中另一份内容完全相同」+ 查看另一份 | `doc.duplicateOf` | `:326-329` |
| 6 | 四个动作 | 在线预览 / 下载原件 / 复制分享链接 / 分享二维码（可按游客权限置灰） | `GET /api/docs/:id/preview|download` | `:331-354`，权限 `:154-163` |
| 7 | 正文 / 文件型说明 | 有 content 按段落渲染，无 content 显示「这是一份文件型资料」 | 接口可缺 content | `:365-373`、`:139-144` |
| 8 | 预览面板 | 内联 iframe（blob URL） | `getPreviewUrl()` | `:376-382`、`api/docs.ts:394-408` |
| 9 | 引用提示 | 「著作权归原发布机构所有…」+ 去引用说明 | 写死 | `:384-387` |
| 10 | 反馈入口 | 「反馈这份资料」→ 资料级弹窗 | `FeedbackDialog scope="doc"` | `:390-408` |
| 11 | 分享弹窗 | 二维码 + 链接 + 复制/存 PNG + 4 条提示 | 本地生成二维码 | `:412`、`ShareDialog.vue:102-141` |
| 12 | 同主题资料 | 最多 3 张 DocCard（按首个 tag 拉） | `GET /api/docs?tag=` | `:415-423`、`:116-128` |

### 2.10 登录注册 `/auth` `frontend/src/views/AuthView.vue`
| 区块 | 内容 | 数据来源 | 行号 |
|---|---|---|---|
| 标题区 | 「零废弃知识库 · 用户中心」+「提问无需注册；下载资料等操作需要登录」 | 写死 | `:132-133` |
| 登录 Tab | 手机号 + 密码 + 登录（支持 `?redirect=`） | `POST /api/auth/login` | `:137-171`、`:38-56` |
| 注册 Tab | 姓名/机构/职业/关注议题（7 个写死选项，可自定义）/手机号/密码/确认密码 | `POST /api/auth/register`；`TOPIC_OPTIONS` `:71` | `:174-233` |

### 2.11 404 `/404` `frontend/src/views/NotFoundView.vue:1-7`
整页仅 7 行：`el-result` 提示 + 「回到首页」按钮（与资料详情内的 404 块 `DocDetailView.vue:275-281` 是两套）。

---

## 三、跨页面重复内容证据表（本次审计核心，共 26 条）

> 判定口径：同一段意思/同一批数字/同一组入口，在两个及以上位置分别实现或分别写了一遍。

**R01 站点定位简介（7 处，措辞各异但同一段话）**
- `frontend/src/components/SiteFooter.vue:60-63`「面向公众开放的零废弃领域资料库，收录政策法规、研究报告、标准规范与实践工具，提供分类浏览、关键词检索与 AI 问答。」
- `frontend/src/views/HomeView.vue:113-117` 首屏三行标语（同一批词：政策法规/研究报告/标准规范/实践工具 + 主题浏览/关键词检索/AI 问答）
- `frontend/src/views/HomeView.vue:220-223`「关于这个知识库」段
- `frontend/src/views/AboutView.vue:130-132` 页头句
- `frontend/src/views/AboutView.vue:200-204` 项目简介第 1 段
- `frontend/src/views/AboutView.vue:157-159`「与知识库的关系」
- `frontend/index.html:20-23` 与 `:28-29` meta description / og:description

**R02 统计数字（份数/年份/机构/主题/类型/体积）在 5 处各画一遍，全部同源 `GET /api/overview`**
- `frontend/src/views/HomeView.vue:49-57` + `:144-152`（4 格）
- `frontend/src/components/SiteFooter.vue:47-52` + `:64-66`（1 格）
- `frontend/src/views/AboutView.vue:45-55` + `:216-221`（6 格）
- `frontend/src/views/InsightsView.vue:66-77` + `:110-118`（6 格）
- `frontend/src/views/ShelfView.vue:327-331`（份数，另取 `GET /api/docs` 的 total）

**R03 「访客无需注册即可提问」4 处**
- `frontend/src/views/HomeView.vue:234`
- `frontend/src/views/AboutView.vue:277`
- `frontend/src/views/AuthView.vue:133`
- `frontend/src/components/HomeAskWidget.vue:10`（注释口径，同时是产品口径）

**R04 「在线预览 / 下载需登录」4 处（本轮改版后口径已不一致，见 R05）**
- `frontend/src/views/AboutView.vue:280-283`（说「需要登录」）
- `frontend/src/components/ShareDialog.vue:132`（说「需登录（注册免费）」）
- `frontend/src/views/DocDetailView.vue:357-359`（说「站点当前对游客关闭了这些功能」）
- `frontend/src/components/ShareDialog.vue:15`（注释同口径）

**R05 「游客权限」开关只在 3 个文件里联动，导致同一句承诺在不同页面对不上**
- 已联动：`frontend/src/components/SiteFooter.vue:34-45`（反馈）、`frontend/src/views/AboutView.vue:36`（反馈）、`frontend/src/views/DocDetailView.vue:57-59`、`:154-163`（预览/下载/分享/反馈）
- **未联动**：`frontend/src/views/ChatView.vue` 全文无 `useGuestPermissions`（grep 结果：只有 SiteFooter / AboutView / DocDetailView 三处引用）→ 后台关掉「游客 AI 提问」后，`/chat` 页面照旧显示可用的输入框，与 `AboutView.vue:277`「访客无需注册即可提问」的承诺先后失配。**待确认**是否有意如此（后端仍会拦）。

**R06 AI 问答文案常量（这一处是好的单一真相来源，列出供对照）**
- `frontend/src/utils/askCopy.ts:18`（免责）、`:21`（作答范围）、`:24-25`（拒答模板）、`:28`、`:31`
- 使用处：`frontend/src/components/HomeAskWidget.vue:213`、`frontend/src/views/ChatView.vue:407`、`frontend/src/components/ChatBubble.vue:29`、`:244`、`:247`

**R07 免责声明另写一份（与 askCopy 同义不同文）**
- `frontend/src/utils/askCopy.ts:18`「回答由 AI 依据知识库内资料生成，仅供参考；请以资料原文为准。」
- `frontend/src/views/AboutView.vue:369`「本站的检索结果与 AI 回答由系统依据库内资料生成，仅供检索参考，不构成任何形式的专业意见。」

**R08 版权 / 引用声明 5 处**
- `frontend/src/components/SiteFooter.vue:104-107`
- `frontend/src/views/AboutView.vue:361-363`
- `frontend/src/views/AboutView.vue:366`
- `frontend/src/views/DocDetailView.vue:384-387`
- `frontend/src/components/ShareDialog.vue:138`

**R09 统计口径说明两套（内容高度重叠：份数按文件计 / 重复副本 N 组 N 份 / 主题标注来源 / 机构计数）**
- `frontend/src/views/AboutView.vue:288-353`（表格 5 行）
- `frontend/src/views/InsightsView.vue:196-218`（列表 5 条）

**R10 反馈出口 4 个、提交链路 2 条（同名函数 `submitFeedback` 来自两个不同模块）**
- `frontend/src/constants/feedback.ts:56-77` → `POST /api/track`（事件 `feedback_submit`，`constants/feedback.ts:71-76`）
- `frontend/src/api/feedback.ts:52-60` → `POST /api/feedback`
- 出口 1 `frontend/src/components/SiteFooter.vue:81-88` + `:111`（站点级弹窗）
- 出口 2 `frontend/src/views/DocDetailView.vue:390-408`（资料级弹窗）
- 出口 3 `frontend/src/views/ContributeView.vue:401-436`（页面 Tab，走 `constants/feedback.ts:32`）
- 出口 4 `frontend/src/views/AboutView.vue:390`（页面内表单，走 `components/FeedbackForm.vue:27` → `api/feedback.ts`）
- 另：`frontend/src/components/FeedbackForm.vue:12-16` 注释自述「资料详情页原也挂了本组件…后撤下」，`docId/docTitle/defaultKind` 三个 prop 已无人传。

**R11 反馈分类常量两套、字段上限三套**
- `frontend/src/constants/feedback.ts:18-23`（broken/wrong/duplicate/missing）与 `:26-31`（feature/content/usage/other），上限 `:34` = 300
- `frontend/src/api/feedback.ts:10`（recommend/correction/cooperation/other），上限 `:30` = 2000、`:31` = 120
- 联系方式 maxlength 写死两处：`frontend/src/components/FeedbackDialog.vue:160` = 60、`frontend/src/views/ContributeView.vue:426` = 60（与 `api/feedback.ts:31` 的 120 不一致）

**R12 示例问题两套 / 其中一组逐字重复**
- `frontend/src/components/HomeAskWidget.vue:49` EXAMPLES = 厨余垃圾怎么处理？/ 什么是零废弃？/ 社区堆肥需要注意什么？
- `frontend/src/views/ChatView.vue:63` EXAMPLES = **与上一行逐字相同**
- `frontend/src/views/HomeView.vue:69-74` SAMPLE_QUESTIONS = 另写 4 个（含「社区堆肥需要注意什么？」→ 该句共出现 3 次）

**R13 首页常见检索词与关于页举例重复**
- `frontend/src/views/HomeView.vue:137`（零废弃 / 垃圾分类 / 塑料 / 无废城市 / 化学品）
- `frontend/src/views/AboutView.vue:243`（塑料 / 垃圾分类 / 无废城市）

**R14 搜索框两个、placeholder 两种、入口两条**
- `frontend/src/views/HomeView.vue:119-133`「搜索资料名称、政策文件、发布机构……」→ `/shelf?q=`
- `frontend/src/views/ShelfView.vue:418-425`「搜索资料名称、机构……」→ 同页筛选

**R15 主题/类型入口重复（首页导航 vs 资料库筛选，同源不同实现）**
- `frontend/src/views/HomeView.vue:155-177`（主题 12 个）、`:180-200`（类型卡）
- `frontend/src/views/ShelfView.vue:337-351`（方向标签）、`:365-395`（主题/类型下拉）

**R16 「AI 问答」入口 6 个**
- `frontend/src/components/SiteNav.vue:40`（导航项）
- `frontend/src/views/HomeView.vue:236-246`（4 个示例问题，点了直接问）
- `frontend/src/views/HomeView.vue:247`（打开 AI 助手按钮）
- `frontend/src/components/HomeAskWidget.vue:218-228`（右下角悬浮球）
- `frontend/src/views/ShelfView.vue:471`（零结果「试试问 AI」）
- `frontend/src/views/AboutView.vue:277`（使用说明卡）

**R17 资料预览+下载的核心动作在 3 个地方被描述/承载**
- 实现：`frontend/src/api/docs.ts:364-381`（下载）、`:394-408`（预览）
- 使用：`frontend/src/views/DocDetailView.vue:331-354`（主按钮）、`:376-382`（iframe 面板）
- 描述：`frontend/src/views/AboutView.vue:266`、`:280-283`；`frontend/src/components/ShareDialog.vue:132`

**R18 首页挂件与独立问答页两套几乎相同的收发逻辑**
- `frontend/src/components/HomeAskWidget.vue:80-136`（send：落两气泡 → SSE → noAnswer → 失败兜底）
- `frontend/src/views/ChatView.vue:174-238`（同一套流程 + conversationId）
- 逐字重复的失败兜底句 `'AI 暂时不可用'`：`HomeAskWidget.vue:111` 与 `ChatView.vue:211`
- 逐字重复的 noAnswer 处理：`HomeAskWidget.vue:116-121` 与 `ChatView.vue:216-221`
- 逐字重复的相对时间/滚动/等待逻辑：`ChatView.vue:76-81`、`:267-279` 与 `HomeAskWidget.vue:67-72`（后者简版）

**R19 资料卡片 DocCard 三处复用（属正面案例，但注释与事实不符）**
- `frontend/src/views/HomeView.vue:212`、`frontend/src/views/ShelfView.vue:452`、`frontend/src/views/DocDetailView.vue:421`
- ⚠️ `frontend/src/components/DocCard.vue:5` 注释称「首页最新收录、资料库列表、**概览页**都用同一张卡片」——概览页 `InsightsView.vue` 全文未引用 DocCard（grep 无结果），**注释不实**。

**R20 页脚链接与导航条重复 4 项**
- 资料库 / 我要投稿 / 数据概览 / 关于项目：`SiteNav.vue:33-39` 与 `SiteFooter.vue:71-74`
- 登录注册：`SiteNav.vue:87` 与 `SiteFooter.vue:94`

**R21 「数据来源与口径 / 引用与转载 / 联系与共建」三个锚点被页脚与正文重复指路**
- `frontend/src/components/SiteFooter.vue:79-89`（三个 `#` 链接）
- 正文同名区块：`frontend/src/views/AboutView.vue:288`、`:357`、`:376`

**R22 「下载/预览需登录 + 分享二维码」提示文案与 AuthView 副标题三处同义**
- `frontend/src/views/AuthView.vue:133`、`frontend/src/components/ShareDialog.vue:132`、`frontend/src/views/AboutView.vue:281`

**R23 404 展示两套**
- 独立页 `frontend/src/views/NotFoundView.vue:1-7`
- 详情页内 `frontend/src/views/DocDetailView.vue:275-281`

**R24 「回到资料库」入口 3 个（措辞不统一）**
- `frontend/src/views/DocDetailView.vue:269`「← 返回资料库」
- `frontend/src/views/DocDetailView.vue:278`「返回资料库」
- `frontend/src/views/AdminStatsView.vue:234`「回到书架」（后台页，但用的是内部旧叫法）

**R25 「在微信里怎么分享」类操作指引两处**
- `frontend/src/components/ShareDialog.vue:128-133`（4 条）
- `frontend/src/views/DocDetailView.vue:236-238`（预览提示）+ `:361`

**R26 「年份不详 / 年份待补」口径三处不同措辞**
- `frontend/src/views/AboutView.vue:318-319`「年份不详」
- `frontend/src/views/InsightsView.vue:72`「年份待补」
- `frontend/src/api/docs.ts:277`「年份待补」（下载文件名）

---

## 四、公众页面上的后台入口 / 内部叫法 / 写死数据 / 无效与占位

### 4.1 后台与内部入口（出现在对外页面上）
| 项 | 位置 | 说明 |
|---|---|---|
| 4 个「（内部）」后台链接 | `frontend/src/components/SiteFooter.vue:95-98` | 每页页脚都有：资料管理（内部）/ 访客反馈（内部）/ 投稿审核（内部）/ 访问统计（内部） |
| 后台路由无守卫 | `frontend/src/router/index.ts:24-52` | 无 `beforeEach`，任何人可直接输入 `/admin/...` 打开后台页 |
| 口令输入框提示内部配置项名 | `frontend/src/views/AdminKnowledgeView.vue:402`、`AdminUsersView.vue:128`、`AdminFeedbackView.vue:148`、`AdminContributionsView.vue:220`、`AdminSettingsView.vue:531` | placeholder 写「管理口令（backend/.env 里的 ADMIN_STATS_TOKEN）」——把后端环境变量名摊在页面上 |
| 5 个后台页共享同一口令键 | `frontend/src/api/admin.ts`（`ADMIN_TOKEN_KEY`），使用处如 `AdminStatsView.vue:27` | 口令存 localStorage |
| 后台页仍是「本地演示」定位 | `frontend/src/router/index.ts:37`、`:39` | 注释明写「本地演示：老师后台」 |

### 4.2 内部叫法（「书架」「板块」「老师后台」等）
- 公众页面正文里已改：`frontend/src/views/ShelfView.vue:6`、`frontend/src/components/SiteNav.vue:7` 记录「书架→资料库」改名；`ShelfView.vue:325` 页眉已是「资料库」。
- **仍残留内部叫法**：`frontend/src/views/AdminStatsView.vue:234`「回到书架」、`AdminContributionsView.vue:15`、`:120`、`:200`「书架」、`AdminKnowledgeView.vue:188`、`:373`、`:556`「书架」、`AdminSettingsView.vue:392`「浏览书架与搜索」、`frontend/src/api/ask.ts:31`、`frontend/src/api/contributions.ts:172`、`frontend/src/api/docs.ts:2`、`:33`、`frontend/src/utils/format.ts:4`（注释）。
- 「板块」用于对外页面文案结构描述：`frontend/src/views/AboutView.vue:13-14`、`:470`、`:476`、`:493`、`:517`（注释）——**待确认**：如做对外文案收集，这些需按「栏目/区块」重命名。
- 投稿页注释仍写「不进书架」：`frontend/src/views/ContributeView.vue:11`。

### 4.3 写死的数字 / 文案（对外页面）
| 位置 | 写死内容 |
|---|---|
| `frontend/src/views/AboutView.vue:412` | 「最后更新于 2026-10-10；反馈受理方式于 2026-10-14 补充」——日期硬编码，会随时间失真 |
| `frontend/src/views/AboutView.vue:73` | 基金会官网 `http://www.lcx-foundation.org.cn/`（**http 明文**，非 https）；`:99` 弹窗标题「即将跳转至安徽省六尺巷慈善基金会官网」 |
| `frontend/src/views/HomeView.vue:69-74` | 4 个示例问题 |
| `frontend/src/views/HomeView.vue:135-140` | 5 个常见检索词 |
| `frontend/src/components/HomeAskWidget.vue:49` / `frontend/src/views/ChatView.vue:63` | 3 个示例问题（两份逐字相同） |
| `frontend/src/views/AuthView.vue:71` | 注册「关注议题」7 个选项（与库内主题不联动） |
| `frontend/src/views/AuthView.vue:84` | 密码长度 8–72（写死在校验消息里） |
| `frontend/src/components/SiteNav.vue:32-41` / `SiteFooter.vue:71-99` | 导航与页脚全部链接 |
| `frontend/src/views/ContributeView.vue:64`、`:277` | 「200 字内」与「单份不超过 50MB」文案（50MB 与 `api/contributions.ts:24` 常量同值，属两处维护） |
| `frontend/src/utils/askCopy.ts:13-14` | 注释写死「当前 617」，同文件 `:14` 明令「不写份数」——注释与规矩自相矛盾（未泄漏到页面） |

### 4.4 占位 / TODO / 承诺未兑现
- `frontend/src/views/AboutView.vue:396-408`：**对外可见**的「待基金会确认后补充（占位）」块（机构简介、邮箱/电话/地址、合作申请流程）。
- `frontend/src/components/SiteFooter.vue:8-10` 注释：机构使命/地址/电话一律留占位。
- `frontend/src/views/AboutView.vue:117-120`：`FOUNDATION_SITE` 为空时的「链接待确认」分支已不会走到（`:71` 注释自述），属死分支。
- `frontend/src/components/FeedbackForm.vue:15-16`：`docId`/`docTitle`/`defaultKind` 三个 prop 无人传（自述）。
- `frontend/src/views/DocDetailView.vue:36`：自述「新加的表单绕过了游客权限开关，已撤下」。

### 4.5 点了「没有反应 / 反应不符预期」的入口（事实层面）
- `frontend/src/views/HomeView.vue:176`：抓不到主题数据时用 `<a href="/shelf">` 硬跳转（会整页刷新，非 RouterLink）。
- `frontend/src/views/AboutView.vue:277`：文案说「**右下角** AI 助手」，但 `HomeAskWidget` 只挂在首页（`HomeView.vue:251`）；在「关于项目」页右下角并没有挂件 → 说明与事实不符。
- `frontend/src/views/AboutView.vue:189`「详情查看」：先弹确认框再 `window.open`（`AboutView.vue:93-122`）；若浏览器拦截弹窗则无反馈。**待确认**。
- `frontend/src/views/ShelfView.vue:471`「试试问 AI」→ `/chat?q=`，落地后只预填不自动发（`ChatView.vue:283-287`），属有意设计。
- `frontend/src/views/ChatView.vue:336-344`：删除按钮平时 `opacity: 0`（`:511-526`），仅 hover/聚焦显形；触屏下常驻（`:644-646`）。

### 4.6 墓碑代码 / 假数据残留（前端侧）
- `frontend/src/api/docs.ts:15` `USE_MOCK = false` 已关，但假数据实现整段留在交付文件里：`TITLE_POOL` 24 条 `:54-81`、`ORG_POOL` `:83`、`TAG_POOL` `:85`、`buildMockDocs()` 造 72 条 `:87-104`、`getDocsMock` `:154-170`、`getFacetsMock` `:173-185`、`getDocDetailMock` `:241-256`、`buildMockPdf` `:286-322`。
- `frontend/src/api/docs.ts:97` 注释「k-2 故意造一个 25MB 大文件」。
- `frontend/src/api/docs.ts:227-233` 已声明删除的 `searchOrgs()` 注释块（死代码说明留在文件里）。

### 4.7 前后端口径矛盾（可能被当成 bug 报告）
- `frontend/src/api/guest.ts:12-13` 注释：「读不到时一律按默认值（**全部开放**）走」；但 `:56-64` 的 `GUEST_FALLBACK_VALUES` 里 `download: false`（其余 true）。接口失败时下载按钮会被置灰，与注释不符。**待确认**是否为有意。

---

## 五、两个核心功能的定位（实现位置 + 页面位置 + 入口数）

### 5.1 资料库预览 + 下载
- 数据层：`frontend/src/api/docs.ts:364-381` `downloadDoc()`（blob 下载 + 中文错误还原 `:345-358`）；`:394-408` `getPreviewUrl()`（先请求再转 blob URL）；阈值 `LARGE_FILE_LIMIT = 20MB` `:261`；下载文件名口径 `:276-283`。
- 列表与检索：`frontend/src/api/docs.ts:412-422`（`getDocs` / `getFacets` / `getDocDetail`）；页面 `frontend/src/views/ShelfView.vue:170-215`（取数）、`:322-474`（渲染）。
- 主入口（唯一）：`frontend/src/views/DocDetailView.vue:331-354` 四按钮，处理器 `onPreview()` `:166-182`、`onDownload()` `:185-204`；预览面板 `:376-382`。
- 次入口（只到详情页，不直接下载）：资料卡片 `DocCard` → `/doc/:id`，见 `frontend/src/components/DocCard.vue:38`；首页 `HomeView.vue:212`、资料库 `ShelfView.vue:452`、详情页同主题 `DocDetailView.vue:421`。
- 权限：`frontend/src/views/DocDetailView.vue:154-163`（游客开关），开关值 `frontend/src/api/guest.ts:34-42`、`frontend/src/composables/useGuestPermissions.ts:68-71`。
- **入口统计**：直接触发预览/下载的按钮只有 1 组（2 个按钮，详情页）；能到达该按钮的路径有 3 类（首页最新收录、资料库列表、详情页同主题推荐）+ 站内 AI 回答来源卡片（`frontend/src/components/ChatBubble.vue:259-270`）。

### 5.2 AI 问答
- 传输层：`frontend/src/api/ask.ts:78-107`（原生 fetch + SSE 逐帧 `:122-148`，事件解析 `:151-185`，来源校验 `:192-213`）。
- 会话层：`frontend/src/api/chat.ts`（`createConversation` / `listConversations` / `fetchMessages` / `deleteConversation`，使用处 `ChatView.vue:22-28`）。
- 渲染层（两页共用）：`frontend/src/components/ChatBubble.vue`（Markdown+DOMPurify `:134-155`、`<kb/>` 引用转文件胶囊 `:136-145`、来源卡片 `:252-271`）；等待文案 `frontend/src/composables/useWaitingLines.ts`。
- 落地位置：① 右下角悬浮挂件，**只在首页** → `frontend/src/views/HomeView.vue:251`；② 独立页 `/chat` → `frontend/src/views/ChatView.vue:309-409`；③ 导航项 `frontend/src/components/SiteNav.vue:40`。
- **入口统计**：首页 3 个（4 个示例 chip `HomeView.vue:236-246`、打开按钮 `:247`、悬浮球 `HomeAskWidget.vue:218-228`）+ 导航 1 + 资料库零结果 1 + 关于页文字引导 1 = 共 6 处（见 R16）。
- 首页挂件是**一次性问答**（不带 `conversationId`，`HomeAskWidget.vue:96-114`），不落库；独立页带 `conversationId`（`ChatView.vue:195-214`）→ 同一功能两种数据行为。

---

## 六、待确认清单（不猜，交 Lead / 项目方判断）
1. `frontend/src/api/guest.ts:56-64` 的 `download:false` 兜底与 `:12-13` 注释「全部开放」矛盾 —— 是否有意。
2. `frontend/src/views/ChatView.vue` 与 `HomeAskWidget.vue` 均未读游客权限开关（`aiAsk`），是有意交给后端拦，还是漏接 T11。
3. 反馈双链路（`POST /api/track` vs `POST /api/feedback`）与两套分类常量，哪条是最终口径。
4. `frontend/src/views/AboutView.vue:396-408` 占位块是否要在对外站上线前撤下。
5. 页脚 4 个「（内部）」入口是否保留在公众页面。
6. `frontend/src/components/DocCard.vue:5` 注释提到的「概览页」是否原本计划用卡片（当前未用）。
7. 官网页 `http://www.lcx-foundation.org.cn/` 是否为最终地址（含是否要 https）。
8. `/shelf` 的「共收录 N 份」取自 `/api/docs` total，与页脚/首页/关于/概览的 `/api/overview.total` 是否一定同值。
