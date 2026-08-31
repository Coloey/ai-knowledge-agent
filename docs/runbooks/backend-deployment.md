# Backend Deployment Runbook

`infra/docker-compose.prod.yml` is a single-host production reference. For high availability, deploy the same API,
worker and migration image on an orchestrator, and use managed or clustered PostgreSQL, Redis and S3-compatible
object storage instead of the Compose stateful services.

## Preconditions

- Node 24 LTS image is built from `apps/backend/Dockerfile`.
- PostgreSQL backups and point-in-time recovery are enabled and a restore has been rehearsed.
- Redis uses AOF `everysec` and `maxmemory-policy noeviction`.
- Object storage versioning/lifecycle rules are configured.
- Tika is private and resource limited.
- Required secrets are supplied by the deployment platform, not committed environment files.

## Database Migration

1. Back up PostgreSQL and record the active FastAPI/Alembic revision.
2. Stop schema changes from the Python deployment.
3. Run `node dist/database/migrate.js` as a single one-off job.
4. On an empty database it applies all Drizzle migrations.
5. On an existing Alembic database it adds refresh-token, outbox and idempotency structures, records the Drizzle
   baseline, and then applies later migrations.
6. Verify `drizzle.__drizzle_migrations`, `auth_refresh_tokens`, `outbox_events` and the pgvector HNSW index.

Do not run Alembic after the Drizzle baseline. Do not use `drizzle-kit push` against staging or production.

## Rollout

1. Deploy one worker with queue consumption paused or zero concurrency.
2. Deploy the NestJS API and verify `/health/live` and `/health/ready`.
3. Route read-only Auth/Workspace traffic to NestJS and compare responses.
4. Route Library writes and enable the Node worker; monitor outbox lag, queue failures and parse latency.
5. Route Session traffic last; monitor active SSE connections, first-token latency and LLM error rate.
6. Increase API replicas to at least two and scale workers by queue depth.

## Rollback

Route affected endpoints back to FastAPI without reverting database migrations. Stop Node workers before restarting
Celery consumers so only one worker stack owns new parsing jobs. New refresh tokens are not understood by the legacy
backend, so an Auth rollback may require users to log in again.

## Alerts

- API readiness failures or 5xx rate above threshold.
- PostgreSQL pool saturation, slow vector queries or storage errors.
- Redis memory/persistence failures, BullMQ failed/stalled jobs and outbox age over 60 seconds.
- Tika timeouts, parser failure rate and worker memory pressure.
- SSE disconnect rate, first-token latency and LLM provider quota errors.
