# 0002. Event-sourced agent state

- Status: accepted
- Date: 2026-10-15

## Context

Brain-like memory needs replay (consolidation), traceability ("why was this recalled?"), versioned updates (reconsolidation), and deterministic evals.

## Decision

All state changes are immutable, timestamped events sharing the envelope in `@neuro-agent/core` (`AgentEvent`). Sessions are append-only logs; derived state (working memory, indexes) is a projection that can be rebuilt.

## Consequences

Replayable traces for evals and sleep-style consolidation come almost for free. Costs: projections must be designed carefully and logs need compaction/archival policies (Phase 8).
