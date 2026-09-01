# ADR-0006: Migrate by route ownership

## Status
Completed

## Decision
The temporary FastAPI-to-NestJS strangler migration is complete. NestJS now owns the API, worker and Drizzle
migrations, while preserving the existing response envelope and SmartBar SSE event contract.

## Consequences
The legacy Python backend is no longer kept in the repository. Drizzle owns new schema changes; its migration runner
keeps an Alembic compatibility baseline for existing databases created before the cutover.
