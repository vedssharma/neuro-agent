# 0003. zod for runtime schemas

- Status: accepted
- Date: 2026-10-15

## Context

Events, tool inputs, and stored memories cross trust boundaries (LLM output, disk, plugins) and need runtime validation. Tool schemas must also be convertible to JSON Schema for LLM providers.

## Decision

Use zod as the single source of truth for schemas; derive TypeScript types with `z.infer`.

## Consequences

One definition yields validation, types, and (via a converter in Phase 1) JSON Schema. Adds a runtime dependency to `@neuro-agent/core`.
