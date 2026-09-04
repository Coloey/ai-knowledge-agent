# AI Knowledge Agent Implementation Notes

This implementation is a pnpm monorepo with a React frontend, shared packages and a NestJS backend. The former Python
backend has been removed from the repository after the Node migration.

## Implemented

- `apps/backend/`: NestJS API, Auth, Workspace, Library and Session modules.
- `apps/backend/src/database/schema.ts`: PostgreSQL + pgvector schema managed by Drizzle.
- `apps/backend/src/sessions/`: SmartBar SSE routes, replayable session events and retrieval.
- `packages/protocol/`: shared, runtime-validated V2 `AgentEvent` and incremental SSE decoder.
- `packages/domain/`: normalized Thread/Part/Chunk state and pure event reducer.
- `packages/chat-runtime/`: per-thread streaming, stop/error handling and Session Detail materialization.
- `packages/smart-bar/`: presentation-only chat input and Part/Chunk rendering.
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
6. The backend persists each V2 event before publishing it. A normal run emits
   `task_started -> meta_info -> thinking -> citation? -> data* -> result -> task_completed -> done`.
7. `task_completed` carries a required `terminal_reason` (`completed`, `failed` or `interrupted`). Failed runs emit
   `error` before completion; interrupted runs may complete without `result`.
8. `ChatRuntime` decodes live SSE and reduces it into normalized Parts and Chunks. Local stop settles the UI and aborts
   immediately, then sends a bounded best-effort interrupt request.
9. Call `/notta-brain/session/detail` to restore sequence-ordered V2 events. History passes through the same reducer as
   live events, including stopped/error terminal state and citations.

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

- Built a pnpm workspace with a shared versioned protocol, normalized Domain model, ChatRuntime, UI and SmartBar.
- Implemented a NestJS + PostgreSQL pgvector + Redis/BullMQ RAG backend.
- Designed a persist-before-publish V2 event journal with live SSE/history parity and non-blocking interruption.
- Built a document ingestion pipeline for PDF, Office and text parsing, chunking, embeddings and workspace isolation.
- Established Docker Compose, Nginx and GitHub Actions workflows for development, testing and deployment.
