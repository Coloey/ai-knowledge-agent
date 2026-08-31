# ADR-0004: Isolate document extraction behind Apache Tika

## Status
Accepted

## Decision
NestJS owns upload, authorization, task state, chunking and embedding. An internal Apache Tika service extracts
text from PDF and Office files inside the worker flow.

## Consequences
Format coverage and parser crash isolation improve, at the cost of one private runtime dependency. Tika must have
CPU/memory limits, timeouts and no public ingress.
