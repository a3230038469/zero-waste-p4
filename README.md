# 零废弃知识库 · 公众端（P4 组）

WeKnora v0.8.2 作**内网问答引擎**，本仓库是自建公众网站（前端 + 后端）。

- 前端：Vue 3 + Vite + TypeScript + Element Plus → `frontend/`
- 后端：Node.js + Express + TypeScript → `backend/`
- 部署：Docker Compose（预留）→ `deploy/`

---

## 一、环境要求

- Node.js >= 20
- npm >= 10

## 二、快速开始

```bash
npm install        # 一次装齐（workspaces）
npm run dev:backend    # 后端 http://localhost:4000
npm run dev:frontend   # 前端 http://localhost:5173
```

自检：

```bash
curl http://localhost:4000/health   # 期望 {"ok":true}
# 浏览器打开 http://localhost:5173  期望看到占位页
```

质量关（提交前必须通过）：

```bash
npm run lint       # 要求 0 error
npm run typecheck  # 类型检查
```

---

## 三、AI / 协作者必读

**开工前请按顺序读这三份：**

| 文件 | 作用 |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | **纪律：三条铁律 + 协作规矩。开工第一件事就是读它** |
| [`docs/接口约定.md`](./docs/接口约定.md) | **前后端字段名和路由名，必须照抄，否则拼不上** |
| [`docs/分工清单.md`](./docs/分工清单.md) | 谁负责哪个板块、各自的功能清单 |

---

## 四、目录结构

```
├─ frontend/                # 前端（Vue3 + TS）
│  └─ src/
│     ├─ views/             # 页面：Home / Shelf / DocDetail / Auth
│     ├─ components/        # 组件：SiteNav 等
│     ├─ router/            # 路由
│     └─ api/               # 统一请求封装
├─ backend/                 # 后端（Express + TS）
│  └─ src/
│     ├─ routes/            # ★ 按人分文件，见下
│     │  ├─ docs.ts         # 归韶茹：资料列表/筛选/详情/预览/下载
│     │  ├─ auth.ts         # 归月月：注册/登录/当前用户
│     │  └─ embed.ts        # 归韶茹：问答窗口钥匙
│     ├─ weknora/           # 引擎对接层（归韶茹）
│     └─ middleware/        # 中间件
├─ docs/                    # 约定与清单（AI 读这个）
└─ deploy/                  # 部署配置（预留）
```

**⚠️ 各写各的文件，不要改别人负责的文件。** 这是全组防冲突的核心机制。

---

## 五、三条铁律

1. **密钥只写 `backend/.env`**，不进代码、不进 git（`.env.example` 里只放占位符）
2. **前端不直接连引擎**，一律走自建后端
3. **不改 WeKnora 源码**，它是引擎，不是我们的项目

---

## 六、Git 协作规矩

- 每人一条分支：`feat/姓名-模块`（如 `feat/dingzi-frontend`）
- **谁都不直接改 `main`**
- 定期推自己的分支；由组长统一合并
- 合并有冲突时，把冲突文件交回对应负责人的 AI 对话去解

---

## 七、端口约定

| 服务 | 端口 |
|---|---|
| WeKnora 引擎 | `8080` |
| 自建后端 | `4000` |
| 自建前端 | `5173` |
