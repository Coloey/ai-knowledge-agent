# ADR-0009: Persist agent events before publishing SSE

## Status
Accepted

## Decision
Use `SessionEventJournal` as the ordered write/read boundary for V2 agent events. For each answer run, persist the
event and advance `last_event_seq` before writing its SSE frame. Reuse the event row ID as `event_id`; derive the
remaining envelope identity from the answer, question and session relationships. `task_started` must be sequence
zero and must be durable before any terminal transition.

Persist `result` and `task_completed` as separate events. Successful and failed terminal pairs are written in one
transaction and are idempotent; interrupted runs persist `task_completed` with `terminal_reason: interrupted` even
without a result. Answer rows store run identity, last sequence, status, terminal reason and start/completion times.
Duplicate `request_id` replay and Session Detail read the same sequence-ordered journal.

## Consequences
Anything published to a client is available for replay, and refresh can reconstruct the same Part/Chunk state as
the live stream. A database failure prevents publication instead of creating an unrecoverable UI-only event.
Journal growth must be monitored, and the one-time V2 migration must be rehearsed on representative PostgreSQL data
before production deployment.
