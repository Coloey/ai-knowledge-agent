# ADR-0002: Use Drizzle with PostgreSQL and pgvector

## Status
Accepted

## Decision
Use Drizzle ORM with reviewed SQL migrations. Keep PostgreSQL 16 and pgvector as the source of truth for relational
data and vector retrieval. Never use schema push or automatic synchronization in production.

## Consequences
Vector columns, HNSW indexes and cosine queries remain explicit and type checked. Existing Alembic databases need
the compatibility baseline in the migration runner before Drizzle takes ownership.
