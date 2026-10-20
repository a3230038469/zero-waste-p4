# docs/shots/ — 验收截图存档

> 用途：把验收证据沉淀进仓，交付时能直接对答"这一项验收过了吗"。
> 规范见 [`docs/task-cards/QA-Snapshot-截图存档.md`](../task-cards/QA-Snapshot-截图存档.md)。
> **截图与交付记录属过程证据，永不删**（AGENTS.md 墓碑守则）。

---

## 截图清单

| 文件 | 页面 | 路由 | 状态 |
|---|---|---|---|
| `home.png` | 首页 | `/` | ⬜ 待补 |
| `shelf.png` | 书架页 | `/shelf` | ⬜ 待补 |
| `auth.png` | 注册 / 登录页 | `/auth` | ⬜ 待补 |
| `doc-detail.png` | 资料详情页 | `/doc/:id` | ⬜ 待补 |
| `admin-stats.png` | 管理统计页 | `/admin/stats` | ⬜ 待补 |

每个页面需覆盖**四种态**（正常 / 加载 / 空 / 错误），共 5 × 4 = 20 张。

## 目录结构

```
docs/shots/
├─ README.md
├─ home.png
├─ shelf.png
├─ auth.png
├─ doc-detail.png
├─ admin-stats.png
└─ QA01/          # 按 QA 批次归档
   └─ QA01FIX/    # 修复轮，与 QA01 对照
```

## 怎么补

```bash
# 1. 起服务
npm run dev:backend    # 终端 1（必须先起，否则页面全是错误态）
npm run dev:frontend   # 终端 2

# 2. 浏览器访问 localhost:5173 逐页截图

# 3. 压体积（单张 ≤ 200KB）
npx -p sharp-cli sharp -i input.png -o docs/shots/home.png resize 1280
```

## 纪律

- 命名：小写 + 短横线（`doc-detail.png`，不写 `DocDetail.png`）
- Markdown 引用用**相对路径**：`../shots/home.png`
- 单张 ≤ 200KB；超了先压再传
- 别把大二进制拖进仓——portal 根目录那个 55MB `cloudflared.exe` 就是教训
