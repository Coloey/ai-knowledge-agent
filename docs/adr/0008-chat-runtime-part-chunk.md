# ADR-0008: Use ChatRuntime with normalized Part and Chunk state

## Status
Accepted

## Decision
Keep chat orchestration in `@agent/chat-runtime` and pure state transitions in `@agent/domain`. The runtime owns SSE
transport, decoding, per-thread generation and abort controllers, best-effort interruption, transport errors and
Session Detail materialization. It exposes small commands and selectors to React through `ChatRuntimeProvider`.

Represent the visible conversation as ordered outer Parts backed by normalized entity maps. A user message,
assistant answer or system notice is a Part; an assistant answer contains a flat ordered list of thinking, message
and tool Chunk IDs. Citations enrich their target message Chunk and artifacts remain normalized. Stable event, run,
answer, chunk and tool-use identities drive idempotent in-place updates. This is not a recursive Virtual DOM tree.

Both live SSE events and persisted Session Detail events enter the same domain reducer. `@agent/smart-bar` reads
Parts and Chunks and sends commands; it does not parse SSE, switch on wire event types or own connection state.

## Consequences
Thread switching, stopping, error recovery and history reload share one state machine and can be tested without a
browser. Separate threads can stream independently while one thread still permits only one active generation.
Adding a new wire event requires protocol and reducer work; adding an unknown tool display does not change runtime
or connection logic because SmartBar has a generic tool card.
