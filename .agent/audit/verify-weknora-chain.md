# 验证：本地 WeKnora 知识库链路是否正常（2026-10-18）

**问题**：前端改版之后，接到本地 WeKnora 知识库的 AI 问答还能用吗？后台自检说「向量服务没启动」要不要紧？

**结论**：**能用，而且和改版无关。Ollama 没跑是正常的，不影响 AI 问答** —— 这个知识库的嵌入模型走的是远程接口，不是本机 Ollama。

全部检查都是**只读**的（docker inspect / psql select / POST /api/ask），没有改任何配置、没有重启任何服务。

---

## 一、改版没有碰过链路

```
git diff --stat v0.9-pre-ux-redesign-2026-10-18 HEAD -- backend
（输出为空）
```

改版期间 17 个文件变更、1933 增 1125 删，**全部在 `frontend/` 与 `docs/`**，`backend/` 一行没动。

## 二、服务进程都在

| 检查项 | 结果 |
|---|---|
| `GET http://127.0.0.1:4000/health` | `{"ok":true}` |
| `GET http://127.0.0.1:4000/` | HTTP 200，入口 `index-rPpZSQ8d.js`（与 `frontend/dist` 一致） |
| `GET /api/docs?pageSize=20` | `total: 603` |
| 端口 4000 | 监听中（node，PID 20532） |
| 端口 8080 | 监听中，裸请求返回 401（正常，缺 API Key 而已） |
| 端口 11434（Ollama） | **没有监听；本机根本没装 ollama** |

`docker ps`：`WeKnora-app`(healthy)、`WeKnora-postgres`(healthy)、`WeKnora-docreader`(healthy)、`WeKnora-frontend`、`WeKnora-redis` —— 全部 Up 5 小时。

## 三、真问一句，链路是通的

`POST http://127.0.0.1:4000/api/ask`，body `{"query":"社区堆肥要注意什么"}`：

```
事件统计: sources = 1, answer = 287, done = 1
来源 3 条，全部 kb_id = 43dcdccd-d368-4d97-a1c6-7874ebbcac68（零废弃知识库）
```

回答是**真检索出来**的，逐条带出处：

> ## 社区堆肥关键注意事项
> ### 1. 堆料选择与预处理
> - **沥水与分类**：厨余需特别注意沥水使用……`<kb doc="社区厨余绿化垃圾就地堆肥手册 v2.0.pdf" chunk_id="8242bbab-…" kb_id="43dcdccd-…" />`
> - **碳氮配比**：氮源与碳源体积比宜为 **1:2**……
> - **温度与周期**：肥堆温度可达 **40-60 度**；夏天约 **2 个月**，冬天约 **4 个月** 可完成。

引用到的原件：《社区厨余绿化垃圾就地堆肥手册 v2.0.pdf》《零废弃学校建设指南 2.0.pdf》《绿色蝶变蝶城落叶堆肥工具包实操手册.pdf》《乡村堆肥指南.pdf》。

## 四、口语化提问也能命中（证明是语义检索，不是关键词凑巧）

故意用**跟原件标题几乎没有共同词**的口语问法：`家里吃剩的菜叶子果皮怎么处理才不会臭`

命中的来源：

- 乡村堆肥指南.pdf
- 零废弃学校建设指南 2.0.pdf
- 导游零废弃行动指南 0817.pdf
- GSI垃圾分类指数报告暨2021城市评价报告-办公新"零"感—零废弃办公行动指南.pdf

回答开头：「结论：剩菜叶、果皮可通过家庭堆肥处理，核心是**用容器收集**并**表面覆盖干料**。」

「菜叶子果皮…才不会臭」能命中《乡村堆肥指南.pdf》，靠的是语义，不是字面。**向量检索是在工作的。**

## 五、为什么 Ollama 没跑也不要紧（决定性证据）

查引擎自己的数据库（`WeKnora` 库）：

```sql
select kb.name, m.name as 嵌入模型, m.source as 嵌入来源,
       m2.name as 问答模型, m2.source as 问答来源
from knowledge_bases kb
left join models m  on m.id = kb.embedding_model_id
left join models m2 on m2.id = kb.summary_model_id
where kb.id = '43dcdccd-d368-4d97-a1c6-7874ebbcac68';
```

| 知识库 | 嵌入模型 | 嵌入来源 | 问答模型 | 问答来源 | 向量库 |
|---|---|---|---|---|---|
| 零废弃 | `qwen3-embedding-4B` | **remote** | `mimo-v2.6-flash` | **remote** | （空 = 用库内 pgvector） |

配套事实：

- 引擎容器环境变量：`OLLAMA_OPTIONAL=true`、`OLLAMA_BASE_URL=http://host.docker.internal:11434`、`RETRIEVE_DRIVER=postgres`
- 引擎里 **13 个模型全部 `source = remote`**，没有任何一个走本地 Ollama
- `embeddings` 表 **114,997 行**，其中本知识库 **90,696 条向量、全部 enabled**，维度 2560（= `qwen3-embedding-4B` 的输出维度）
- `vector_stores` 表 **0 行** —— 没配外部向量库，向量就存在 Postgres 里（`vector` 扩展已装）

既然嵌入和问答都是**远程接口**，本机 Ollama 跑不跑都不参与这条链路。

## 六、那条「向量服务没启动」是误报

`backend/src/routes/admin.ts:1719-1749` 的自检项读 `OLLAMA_BASE_URL`，没配就默认 `http://127.0.0.1:11434`。而 `backend/.env` 里的键只有：

```
DATABASE_URL, JWT_SECRET, PORT, WEKNORA_API_KEY, WEKNORA_BASE_URL,
WEKNORA_CHANNEL_ID, WEKNORA_KB_ID, WEKNORA_PUBLISH_TOKEN
```

**没有 `OLLAMA_BASE_URL`** → 自检去敲一个本部署从来没用过的地址 → 必然报「没过」。

**待办建议**（未实施，等拍板）：自检这一项应改成探测**该知识库实际在用的嵌入模型**能否调通，而不是硬编码探本机 11434；否则老师会看到一个永远红的项，反而掩盖真故障。

---

## 附：本次验证的副作用

`POST /api/ask` 走了 3 次游客提问（游客每日上限 5 次，计数落盘在 `backend/data/guest-ask-usage.json`）。除此之外没有任何写入。
