# NestJS Backend

This package contains the production API and asynchronous document worker.

## Entrypoints

- `src/main.ts`: Fastify HTTP API, auth, workspace, library and SmartBar SSE routes.
- `src/worker.ts`: BullMQ consumers for document parsing, chunking and embedding.
- `src/database/migrate.ts`: serialized Drizzle migration runner with an Alembic compatibility baseline.

## Commands

```bash
pnpm dev
pnpm dev:worker
pnpm typecheck
pnpm test
pnpm build
pnpm db:generate
pnpm db:migrate
```

Production requires S3-compatible storage, a JWT secret of at least 32 characters, PostgreSQL with pgvector,
Redis configured with persistence and `maxmemory-policy noeviction`, and a private Apache Tika endpoint.

The database schema fixes the embedding dimension at 1536. Changing the embedding model dimension requires an
explicit schema migration and re-indexing all document chunks.
