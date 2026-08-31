# ADR-0001: Use a modular NestJS monolith

## Status
Accepted

## Decision
Keep one backend codebase with explicit Auth, Workspace, Library, Session, Storage, AI and Database modules. Build
two deployable entrypoints: a horizontally scalable HTTP API and an independently scalable queue worker.

## Consequences
Module boundaries remain testable without introducing service discovery, distributed transactions or network APIs
between business modules. API and worker failures and scaling are isolated at the process level.
