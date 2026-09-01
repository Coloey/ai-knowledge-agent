# AI Knowledge Agent Implementation Notes

This implementation is a pnpm monorepo with a React frontend, shared packages and a NestJS backend. The former Python
backend has been removed from the repository after the Node migration.

## Implemented

- `apps/backend/`: NestJS API, Auth, Workspace, Library and Session modules.
- `apps/backend/src/database/schema.ts`: PostgreSQL + pgvector schema managed by Drizzle.
- `apps/backend/src/sessions/`: SmartBar SSE routes, replayable session events and retrieval.
- `apps/backend/src/library/`: upload handling, Tika parsing, chunking, embedding and BullMQ workers.
- `infra/docker-compose.dev.yml`: local PostgreSQL, Redis, MinIO and Apache Tika.
- `infra/docker-compose.prod.yml` and `infra/nginx/default.conf`: single-host production reference.
- `.github/workflows/ci.yml`: typecheck, tests, formatting, build and Drizzle migration verification.

## Local Start

Start infrastructure:

```bash
pnpm infra:dev
```

Start the API:

```bash
cp apps/backend/.env.example apps/backend/.env
pnpm --filter @agent/backend db:migrate
pnpm backend:dev
```

Start the worker and frontend in separate terminals:

```bash
pnpm backend:worker
pnpm dev
```

## Main Flow

1. Call `/auth/register` to create a user and receive `access_token` plus `default_workspace_id`.
2. Send frontend requests with `Authorization: Bearer <access_token>`.
3. Upload PDF, Office, TXT or Markdown files through `/library/files/upload?workspace_id=<workspace_id>`.
4. The worker parses files, creates chunks and writes embeddings into `document_chunks`.
5. Call `/notta-brain/session/send-message` to start SmartBar SSE.
6. SSE emits `meta_info -> thinking -> citation? -> data* -> result -> task_completed -> done`.
7. Call `/notta-brain/session/detail` to restore session history.

## Production

1. Configure production secrets through the deployment platform or an external `.env.production`.
2. Build images:

```bash
docker compose --env-file .env.production -f infra/docker-compose.prod.yml build
```

3. Start services:

```bash
docker compose --env-file .env.production -f infra/docker-compose.prod.yml up -d
```

## Resume Highlights

- Built a pnpm workspace for API, Domain, UI and SmartBar packages.
- Implemented a NestJS + PostgreSQL pgvector + Redis/BullMQ RAG backend.
- Designed the SmartBar SSE protocol with session replay, incremental persistence and generation interruption.
- Built a document ingestion pipeline for PDF, Office and text parsing, chunking, embeddings and workspace isolation.
- Established Docker Compose, Nginx and GitHub Actions workflows for development, testing and deployment.
