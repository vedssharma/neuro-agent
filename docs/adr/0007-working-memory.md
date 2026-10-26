# 0007. Working memory as a prompt compiler

- Status: accepted
- Date: 2026-10-26

## Context

Phase 2 showed that no baseline survives a single turn bigger than the model's window: every baseline scores 0% on `long-horizon`, where one request reads 16 files of about 1,200 tokens each. Sliding windows can only drop whole turns, so the current turn always goes in verbatim. Phase 3 has to treat the window as a small, curated working memory instead of a suffix of the transcript, and beat the sliding-window and summary-buffer baselines on long-horizon tasks at equal or lower token cost.

## Decision

`WorkingMemory` (in `@neuro-agent/memory`) is an ordinary `ContextStrategy`. On every model call it compiles the prompt from slots, under one token budget:

- **Chunks.** Every user text, assistant text and tool exchange becomes a typed chunk (`user`, `assistant`, `tool` with a label such as `read_file(a.txt)`) that keeps the full text as its artifact. Chunks are rendered as their goal-relevant sentences, at most 80 tokens, behind a header with the chunk id and original size.
- **Goal stack.** The current request, plus up to two earlier requests that are no longer visible.
- **Current turn.** Always sent. With chunking on, all but the newest tool output are replaced by their compressed rendering; the newest is compressed too if the turn is still over budget.
- **Focus region.** Up to 4 chunks of this session, chosen by an attention gate: `relevance + 0.3·salience + 0.2·recency + 0.2·rehearsal`, where relevance is the best sentence's cosine similarity to the goal and a chunk needs relevance ≥ 0.1 to enter. Up to 30% of the budget.
- **Activated region.** Up to 4 chunks recalled from earlier sessions through the shared store, rendered oldest first so later corrections win. Up to 20% of the budget.
- **Sensory tail.** As many recent raw turns as still fit.
- **Sensory buffer.** New chunks stay in a fast-decaying buffer. Salient chunks (numbers, statements, cues such as "remember" or "correction") and chunks that enter focus are promoted to the long-term store; the rest are forgotten after 48 newer chunks.
- **Rehearsal.** A chunk admitted to focus gets rehearsal 1, which halves on every call it is not admitted, so held items are sticky and unattended ones decay out.

The budget is filled in priority order: goal stack, current turn, focus, activated region, tail. As the budget shrinks the tail goes first, then the activated region, then focus. The working-memory block is prepended to the first message sent; `dropped` is the index of the first raw message, and the focus and activated items are reported as `retrieved`, so retrieval metrics and traces cover them.

Each mechanism is a feature flag (`chunking`, `attention`, `rehearsal`, `activation`) so it can be ablated. `neuro eval` runs `working-memory` and one ablation per flag that changes the offline results; `neuro --working-memory` uses it interactively.

## Consequences

- Offline (`docs/evals/simulated-standard.md`), working memory scores 100% on all four suites, including `long-horizon` at 48,766 tokens per task against 107,911 for the sliding window and the summary buffer. Overall it uses fewer tokens per task than any baseline.
- The ablations show where the gains come from: without chunking, `long-horizon` drops back to 0%; with a recency-only gate, in-session recall drops to 14%; without activation, nothing survives into a new session.
- Rehearsal has no measurable effect on the current suites; it stays behind its flag until a benchmark exercises long-running goals.
- Relevance uses the hashed bag-of-words embedder, which matches on shared words. Paraphrased goals need a neural `Embedder`, and the weights still need tuning against a live model.
- The long-term store is still the in-memory vector store from Phase 2. Persistent episodic and semantic stores are Phase 4.
