# ADR-0003: Use BullMQ with a transactional outbox

## Status
Accepted

## Decision
Persist file metadata and an outbox event in one PostgreSQL transaction. Relay events to BullMQ using `fileId` as
the deterministic job ID. Workers must be idempotent and replace chunks in a database transaction.

## Consequences
An API crash between database commit and queue publication no longer loses parsing work. Redis must use AOF and
`maxmemory-policy noeviction`; failed jobs and outbox lag require alerts.
