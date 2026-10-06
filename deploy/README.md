# 部署（预留）

第一阶段先本地跑通（`npm run dev:*`），部署文件成型后再补。

计划包含：
- `docker-compose.yml`：前端 + 后端两个服务（**不含 WeKnora**，它是独立引擎）
- `nginx.conf`：反向代理
- `backend.Dockerfile` / `frontend.Dockerfile`
- `.env.example`：生产环境变量清单

**注意**：正式部署时引擎仍需放内网，仅网站对外。
