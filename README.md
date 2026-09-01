# AI Knowledge Agent

AI knowledge management and SmartBar Agent application built as a pnpm workspace.

## Stack

- Web: React 18, TypeScript, Rsbuild, Zustand and Ant Design.
- Backend: Node.js 24 LTS, NestJS 11, Fastify 5 and Drizzle ORM.
- Data: PostgreSQL 16 with pgvector, Redis/BullMQ and S3-compatible object storage.
- Document processing: an isolated NestJS worker backed by Apache Tika.
- AI: DashScope or another OpenAI-compatible provider, with a local deterministic fallback outside production.

## Local Start

```bash
pnpm install
pnpm infra:dev
cp apps/backend/.env.example apps/backend/.env
pnpm --filter @agent/backend db:migrate
pnpm backend:dev
```

Run the parser worker and frontend in separate terminals:

```bash
pnpm backend:worker
pnpm dev
```

The API listens on `http://localhost:8000`. Liveness is exposed at `/health/live`; readiness is exposed at
`/health/ready`.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm backend:build
```

## Production

The API, worker and migration job use the same Node 24 image. The reference single-host deployment is:

```bash
docker compose --env-file .env.production -f infra/docker-compose.prod.yml build
docker compose --env-file .env.production -f infra/docker-compose.prod.yml up -d
```

For higher availability, deploy the same image as separate API and worker workloads and use managed PostgreSQL,
Redis and object storage. See `docs/runbooks/backend-deployment.md` before deploying or migrating an existing
legacy Alembic database.

Backend development belongs in `apps/backend/`.
