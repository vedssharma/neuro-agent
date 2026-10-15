# 0004. SQLite as the default store

- Status: accepted (implementation lands in Phase 4)
- Date: 2026-10-15

## Context

Memory should be local-first, inspectable, portable, and dependency-light, yet support full-text search and transactional writes.

## Decision

SQLite (with FTS5) is the default backing store, behind storage interfaces so other backends (Postgres, in-memory for tests) can be added. A concrete driver (`better-sqlite3` or Node's built-in `node:sqlite` once stable on our minimum Node version) is chosen in Phase 4. Vector search will be a pluggable index.

## Consequences

Single-file memory the user can inspect, back up, and delete. No driver dependency is added until Phase 4.
