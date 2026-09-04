# ADR-0007: Switch the agent event protocol directly to V2

## Status
Accepted

## Decision
Use `@agent/protocol` as the only browser-safe wire contract shared by the React frontend and NestJS backend. Every
`AgentEvent` has `schema_version: 2`, a stable `event_id`, a per-run `seq`, a numeric `timestamp`, and complete request,
workspace, session, question, answer and run identities. The discriminated union covers task start, metadata,
thinking, answer data, tool use/result, citations, artifacts, result, error, task completion and heartbeat events.

The decoder rejects V1, unknown types, invalid identities, invalid sequences and malformed event-specific content.
`task_completed.content.terminal_reason` is required and is one of `completed`, `failed` or `interrupted`. The project
has no deployed V1 frontend or external protocol consumers, so frontend and backend switch atomically without a V1
adapter, dual-protocol branch or feature flag. Existing database rows are normalized by a reviewed Drizzle migration.

## Consequences
Protocol drift fails in shared type checks and contract tests instead of leaking into UI code. All consumers can
correlate, order and deduplicate events consistently, and interruption survives persistence and history reload. A
future incompatible wire change requires a new schema version and an explicit migration decision.
