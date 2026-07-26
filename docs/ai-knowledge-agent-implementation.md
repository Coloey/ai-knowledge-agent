# AI 知识管理 / AI Agent 实现说明

这份实现把 Python 后端补进当前 monorepo，用来承接 SmartBar SSE、知识库上传解析、RAG 检索和部署链路。

## 已落地内容

- `backend/`：FastAPI 应用，包含 auth、workspace、library、session 四组 API。
- `backend/app/models/entities.py`：PostgreSQL + pgvector 数据模型。
- `backend/app/api/routes/session.py`：兼容 `/notta-brain/session/send-message`、`interrupt`、`detail`、`history`、`rate-answer`。
- `backend/app/workers/tasks.py`：Celery 文件解析任务，负责 parse -> chunk -> embedding -> 入库。
- `infra/docker-compose.dev.yml`：本地 PostgreSQL、Redis、MinIO。
- `infra/docker-compose.prod.yml` 和 `infra/nginx/default.conf`：单机生产部署骨架，SSE location 已关闭 buffering。
- `.github/workflows/ai-knowledge-agent-ci.yml`：前端 smart-bar 测试、后端 ruff、迁移和 pytest。
- `apps/notta-brain/rsbuild.config.ts`：新增 `PYTHON_BACKEND_URL` 联调开关。

## 本地启动

启动基础设施：

```bash
docker compose -f infra/docker-compose.dev.yml up -d
```

启动后端：

```bash
cd backend
cp .env.example .env
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload
```

启动 worker：

```bash
cd backend
celery -A app.workers.celery_app worker -l info
```

启动前端并接入 Python 后端：

```bash
PYTHON_BACKEND_URL=http://localhost:8000 pnpm start:dev1
```

## 联调主链路

1. 调 `/auth/register` 注册用户，拿到 `access_token` 和 `default_workspace_id`。
2. 前端请求带上 `Authorization: Bearer <access_token>`。
3. 调 `/library/files/upload?workspace_id=<workspace_id>` 上传 PDF / DOCX / PPTX / TXT / MD。
4. worker 解析文件并写入 `document_chunks`。
5. 调 `/notta-brain/session/send-message` 发起 SmartBar SSE。
6. SSE 返回 `meta_info -> thinking -> citation? -> data* -> result -> task_completed -> done`。
7. 调 `/notta-brain/session/detail` 恢复历史会话。

## 生产部署

1. 云服务器安装 Docker、Docker Compose、Nginx/Certbot。
2. 配置 `backend/.env`，生产环境必须修改 `JWT_SECRET_KEY`、数据库密码、对象存储密钥和 AI API Key。
3. 构建前后端镜像：

```bash
docker compose -f infra/docker-compose.prod.yml build
```

4. 执行数据库迁移：

```bash
docker compose -f infra/docker-compose.prod.yml run --rm backend-api alembic upgrade head
```

5. 启动服务：

```bash
docker compose -f infra/docker-compose.prod.yml up -d
```

## 简历可写亮点

- 基于 pnpm workspace 拆分 API、Domain、UI、SmartBar package，完成 AI 应用前端 monorepo 工程化。
- 基于 FastAPI + PostgreSQL pgvector + Redis + Celery 实现知识库 RAG 后端主链路。
- 设计 SmartBar SSE 流式协议，支持服务端 sessionId 收编、事件增量落库、历史重放和生成中断。
- 建设文件上传解析链路，支持 PDF / Office / 文本解析、chunk 切分、embedding 入库和 workspace 级数据隔离。
- 搭建 Docker Compose + Nginx + GitHub Actions 的开发、测试、部署闭环。
