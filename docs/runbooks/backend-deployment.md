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

1. Back up PostgreSQL and record any active legacy Alembic revision when migrating an older installation.
2. Run `node dist/database/migrate.js` as a single one-off job.
3. On an empty database it applies all Drizzle migrations.
4. On an existing Alembic database it adds refresh-token, outbox and idempotency structures, records the Drizzle
   baseline, and then applies later migrations.
5. Verify `drizzle.__drizzle_migrations`, `auth_refresh_tokens`, `outbox_events` and the pgvector HNSW index.

Do not run Alembic after the Drizzle baseline. Do not use `drizzle-kit push` against staging or production.

## Rollout

1. Run the migration job.
2. Deploy the NestJS API and verify `/health/live` and `/health/ready`.
3. Deploy the Node worker; monitor outbox lag, queue failures and parse latency.
4. Monitor active SSE connections, first-token latency and LLM error rate.
5. Increase API replicas to at least two and scale workers by queue depth.

## Rollback

Roll back by redeploying the previous NestJS image and stopping workers before changing migration state. Do not rerun
Alembic after the Drizzle baseline. If an older external FastAPI deployment is still available, route traffic back only
after stopping Node workers so one worker stack owns parsing jobs.

## Alerts

- API readiness failures or 5xx rate above threshold.
- PostgreSQL pool saturation, slow vector queries or storage errors.
- Redis memory/persistence failures, BullMQ failed/stalled jobs and outbox age over 60 seconds.
- Tika timeouts, parser failure rate and worker memory pressure.
- SSE disconnect rate, first-token latency and LLM provider quota errors.
