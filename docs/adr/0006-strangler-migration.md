# ADR-0006: Migrate by route ownership

## Status
Accepted

## Decision
Run FastAPI and NestJS in parallel during rollout but assign each write route to exactly one backend. Preserve the
existing response envelope and SmartBar SSE event contract. Move Session streaming last.

## Consequences
Rollback remains possible without dual writes. Alembic stops owning schema changes at the recorded cutover revision;
all later migrations are generated and applied by Drizzle.
