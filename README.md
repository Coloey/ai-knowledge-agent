# AI Knowledge Agent

一个完整的 AI 知识管理 / SmartBar Agent 个人项目骨架。

## Stack

- Frontend: React 18, TypeScript, Rsbuild, pnpm workspace, Zustand-style domain package, Ant Design-ready UI package.
- Backend: FastAPI, PostgreSQL, pgvector, Redis, Celery.
- AI: DashScope-compatible provider with local deterministic fallback.
- Deploy: Docker Compose, Nginx, GitHub Actions.

## Local Start

```bash
pnpm install
pnpm infra:dev
cd backend
cp .env.example .env
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload
```

In another terminal:

```bash
cd backend
celery -A app.workers.celery_app worker -l info
```

Frontend:

```bash
pnpm dev
```

## Production Build

```bash
docker compose -f infra/docker-compose.prod.yml build
docker compose -f infra/docker-compose.prod.yml run --rm backend-api alembic upgrade head
docker compose -f infra/docker-compose.prod.yml up -d
```

The production Nginx image serves the built React app and proxies `/auth`, `/workspaces`,
`/library` and `/notta-brain` to FastAPI. The SSE endpoint disables proxy buffering in
`infra/nginx/default.conf`.
