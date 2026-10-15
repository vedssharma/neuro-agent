# 0006. Seeded synthetic benchmarks with a simulated model

- Status: accepted
- Date: 2026-10-15

## Context

Phase 2 needs an evaluation that can run on every change, compare context and memory strategies, and stay cheap and reproducible. Live LLM runs are slow, cost money, need credentials, and vary between runs.

## Decision

- Benchmarks are synthetic conversations generated from a seed (`generateTasks`). Facts are phrased "the X is Y", so answers can be graded by substring match against any model.
- Offline runs use a deterministic `SimulatedReader` provider that answers only from facts visible in the request it receives and enforces a context limit. With it, the suite measures how well a strategy _delivers_ the needed information, deterministically and in seconds.
- The same suite runs against live providers (`neuro eval -p anthropic`); live results are the ones that confirm a mechanism helps.
- Baselines (full transcript, sliding window, summary buffer, vector RAG) are ordinary `ContextStrategy` implementations in `@neuro-agent/memory`. Strategies may now be async and may report recalled items, which are recorded on `model.request` events so retrieval metrics come from traces.
- Traces carry a `traceVersion`; `replaySession` re-runs a session from its recorded model turns and tool results and reports the first divergent event.
- The vector-RAG baseline uses a hashed bag-of-words embedder so it runs offline. A neural `Embedder` can be plugged in for live runs.

## Consequences

- Offline scores show how much information reaches the model, not how well a model uses it. Large offline gains have to be confirmed live before they count.
- The simulated reader resolves conflicts by text order ("latest statement wins"), so offline stale-answer rates understate what a real model may do.
- Benchmarks are synthetic. Adapting public long-term-memory benchmarks (LongMemEval/LoCoMo-style) is still open.
