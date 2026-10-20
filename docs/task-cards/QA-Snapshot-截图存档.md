# QA-Snapshot · 截图存档

> 归属：**月月** · 状态：**🚧 进行中**（目录已建，截图待补）
> 存档目录：[`docs/shots/`](../shots/)

---

## 一、目标

把验收证据沉淀进仓库，不再只躺在飞书群消息和个人笔记里——交付时能直接对答"这一项验收过了吗"。

## 二、契约（`docs/shots/` 目录约定）

```
docs/shots/
├─ README.md          # 本目录说明 + 截图清单
├─ home.png           # 首页
├─ shelf.png          # 书架页
├─ auth.png           # 注册/登录页
├─ doc-detail.png     # 资料详情页
├─ admin-stats.png    # 管理统计页
└─ QA01/              # 按 QA 批次归档（修复轮对比）
   └─ ...
```

命名规范，**照抄 portal**：

| 规则 | 说明 |
|---|---|
| 小写 + 短横线 | `doc-detail.png`，不写 `DocDetail.png` |
| 按页面命名 | 与路由对应，一眼知道截的是哪页 |
| 批次进子目录 | 修复轮对比放 `QA01FIX/`，与 `QA01/` 对照 |
| 单张 ≤ 200KB | 超了用 `sharp-cli -i input -o output resize 1280` 压 |

## 三、四种态必须各截一张

每个页面不只是"正常态"，要覆盖：

| 态 | 怎么触发 |
|---|---|
| 正常 | 直接访问 |
| 加载 | 节流到 Slow 3G 后刷新，抓骨架屏 |
| 空 | 筛一个不可能命中的条件 |
| 错误 | 停掉 backend 再刷新，抓 `zw-error` 卡片 |

## 四、验收命令

```bash
# 启动前后端
npm run dev:backend   # 终端 1
npm run dev:frontend  # 终端 2

# 截图后检查体积
ls -lh docs/shots/*.png
# 单张应 ≤ 200KB
```

## 五、已知坑

- **截图前必须确认 backend 在跑**，否则页面全是 `zw-error`，会误判成"页面坏了"。
- **不要把截图存成绝对路径引用**——Markdown 里用相对路径 `../shots/home.png`。
- 截图属**过程证据，永不删**（AGENTS.md 墓碑守则明确写了）。
- 别把 55MB 级的二进制拖进仓——portal 根目录那个 `cloudflared.exe` 就是教训，clone 会慢到无法接受。

## 六、墓碑候选

无。截图与交付记录属过程证据，**不删**。
