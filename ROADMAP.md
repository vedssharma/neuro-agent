# neuro-agent Roadmap

An open-source agent harness, written from scratch in TypeScript, whose **memory and context management work like a human brain**: a tiny, attention-gated working memory; fast episodic and slow semantic long-term stores; sleep-like consolidation; retrieval that is cue-driven and edits what it touches; and forgetting as a feature.

The neuroscience behind each decision is in [`docs/NEUROSCIENCE.md`](docs/NEUROSCIENCE.md). This roadmap turns it into phases.

## Guiding principles

1. **Brain-inspired, not brain-simulating.** We borrow mechanisms that solve real agent problems (context limits, interference, staleness, cost). We do not claim biological fidelity.
2. **The context window is working memory.** It is scarce and curated. Nothing enters it without passing a gate.
3. **Two-speed learning.** Write fast to an episodic store; integrate slowly into a semantic store. Never "fine-tune" on the hot path.
4. **Memory is reconstructive and mutable.** Retrieval can update memory; every update is versioned.
5. **Forgetting is a feature.** Decay and archival keep retrieval fast and relevant.
6. **Everything is measurable.** Each cognitive mechanism ships with an eval that shows it beats a naive baseline (full transcript, plain vector RAG, sliding window). If it doesn't help, we cut it.
7. **Model- and provider-agnostic, local-first, transparent.** Memory is inspectable on disk; the user can see, edit, and delete what the agent remembers.

## Target architecture (end state)

```
                 ┌────────────────────────── Executive (PFC) ──────────────────────────┐
 user / events → │ goals · attention gate · planner · budget · metacognition          │
                 └───────┬───────────────────────────────┬─────────────────────────────┘
                         │ admit / evict                 │ broadcast
                 ┌───────▼────────┐   cue    ┌───────────▼────────────┐
 Sensory buffer →│ Working memory │◄────────►│  Global workspace      │◄── tools / skills
                 │ focus(≈4)+held │          │ (modules compete)      │
                 └───────┬────────┘          └───────────▲────────────┘
                 encode  │ (salience gate)          retrieve│(cue → complete)
        ┌────────────────▼───────────┐   replay    ┌───────┴──────────────────┐
        │ Episodic store (hippocamp.)│────────────►│ Semantic store (cortex)  │
        │ fast · sparse · indexed    │◄── cues ────│ facts · schemas · graph  │
        └────────────────┬───────────┘             └───────┬──────────────────┘
                         │          Procedural store (skills / habits)
                         └──────── Consolidation "sleep" · Decay · Reconsolidation
```

---

## Phase 0 — Foundations & project setup ✅ (done)

**Goal:** A clean, contributor-friendly TypeScript monorepo.

- TypeScript (strict), Node 20+, pnpm workspaces; ESM only.
- Packages: `@neuro-agent/core`, `/memory`, `/providers`, `/tools`, `/cli`, `/eval`.
- Tooling: Vitest, ESLint, Prettier, tsup/tsc build, GitHub Actions CI (lint, typecheck, test).
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, `docs/` skeleton, ADR (architecture decision record) folder.
- Decide and record: zod for schemas, event-sourced state, SQLite as default store.

**Exit criteria:** `pnpm test` green in CI; "hello world" package builds and publishes to a dry run.

## Phase 1 — A minimal, conventional agent loop (the baseline) ✅ (done; live-model numbers pending)

**Goal:** A working agent _without_ brain features — the control group every later phase must beat.

- Provider abstraction (Anthropic first; OpenAI-compatible and local/Ollama adapters) with streaming and tool-call normalization.
- Agent loop: perceive → think → act → observe, with typed events and cancellation.
- Tool system: schema-defined tools (zod → JSON Schema), permissions/approval hooks, sandboxed shell + file read/write/edit + search.
- Naive context strategy: full transcript with sliding-window truncation.
- CLI REPL, structured logging, JSONL session traces (needed for evals and replay).
- Token accounting and cost tracking.

**Exit criteria:** Completes simple coding/research tasks end to end; full traces recorded; baseline numbers captured.

**Status:** the loop, providers, tools, CLI, traces and cost tracking are implemented and tested against scripted and recorded provider streams (see [ADR 0005](docs/adr/0005-provider-neutral-agent-loop.md)). Offline baseline numbers are in [docs/evals](docs/evals) (Phase 2). Remaining: the same suite against a live model (`neuro eval -p anthropic`).

## Phase 2 — Evaluation harness (build the ruler first) ✅ (done; live-model run and public benchmarks pending)

**Goal:** Prove or disprove every later claim.

- Replayable trace format; deterministic mock-provider mode for tests.
- Benchmarks: (a) long-horizon task suites with context far beyond the window; (b) needle/fact recall across sessions; (c) contradiction/update tests ("user changed their mind"); (d) distractor/interference tests; (e) cost & latency tracking.
- Baselines: full-transcript, sliding window, summary-buffer, vanilla vector-RAG memory.
- Metrics: task success, recall@k, stale-fact rate, tokens per task, retrieval precision, wall-clock.
- Optionally adapt public long-term-memory benchmarks (e.g. LongMemEval/LoCoMo-style) to our harness.

**Exit criteria:** One command runs the suite and produces a comparison report; baselines published in `docs/evals`.

**Status:** `pnpm eval` runs four seeded suites (long-horizon, cross-session recall, updates, interference) against all four baselines and writes [docs/evals/simulated-standard.md](docs/evals/simulated-standard.md). Offline runs use a deterministic simulated model; the same command runs against live providers. Traces are versioned and replayable (`neuro replay`). See [ADR 0006](docs/adr/0006-offline-evaluation.md). Open: a published live-model run, and adapting public long-term-memory benchmarks.

## Phase 3 — Working memory & attention (the prefrontal workbench) ✅ (done offline; live-model run pending)

**Goal:** Treat the context window as a small, curated working memory.

- **Context compiler:** assembles each prompt from slots — system/identity, _goal stack_, _focus region_ (≈4 active chunks), _activated region_ (recently retrieved items), and an optional sensory tail of raw recent events.
- **Chunking:** raw turns and tool outputs are compressed into typed chunks (summary + pointer to the full artifact) rather than retained verbatim.
- **Attention gate:** an admit/evict policy scoring candidates by relevance to the current goal, recency, and salience; configurable token budget per region.
- **Sensory buffer:** large, fast-decaying raw buffer (tool outputs, file contents) from which only attended items are promoted.
- **Rehearsal/refresh:** items kept in focus are refreshed; unattended items decay out of the window.
- Graceful degradation as budget shrinks (drop the activated region before the focus).

**Exit criteria:** Beats sliding-window and summary-buffer baselines on long-horizon tasks at equal or lower token cost.

**Status:** `WorkingMemory` in `@neuro-agent/memory` compiles each prompt from a goal stack, an attention-gated focus region, an activated region recalled from earlier sessions, a sensory tail and a chunked current turn, with each mechanism behind a feature flag ([ADR 0007](docs/adr/0007-working-memory.md)). Offline it scores 100% on `long-horizon` at 48,766 tokens per task, against 0% at 107,911 for the sliding window and the summary buffer ([report](docs/evals/simulated-standard.md)). Open: confirming the result with a live model, and tuning the gate weights there.

## Phase 4 — Long-term memory v1: episodic + semantic stores

**Goal:** Two long-term stores with different speeds and write policies (Complementary Learning Systems).

- **Storage layer:** SQLite (+ FTS5) with a pluggable vector index; everything inspectable on disk (JSONL/Markdown export). Interfaces so Postgres/other backends can follow.
- **Episodic store ("hippocampus"):** fast, append-mostly writes of _events_ — what happened, when, where (project/file/session), with whom, outcome — each with a compact _index_ pointing to full artifacts. **Pattern-separated writes:** store distinguishing context so near-duplicate episodes stay distinct.
- **Semantic store ("neocortex"):** facts, entities, preferences, and schemas as a knowledge graph with provenance links back to supporting episodes.
- **Encoding pipeline:** event → candidate memory → salience gate (Phase 6 deepens this) → write.
- **Retrieval v1:** hybrid lexical + embedding + graph-neighborhood search, returning chunks into the activated region.

**Exit criteria:** Cross-session recall evals pass; beats vanilla vector-RAG on recall and interference tests.

## Phase 5 — Cue-driven retrieval (pattern completion)

**Goal:** Retrieval that works like associative recall, not keyword lookup.

- **Cue construction:** derive cues from the current goal, focus chunks, and environment, not just the user's last message.
- **Pattern completion:** partial cue → spreading activation over the episodic/semantic graph (with decay per hop) → completed ensemble of related memories.
- **Retrieval-time reranking:** relevance × recency × strength × salience × context match (encoding-specificity: memories surface best when current context resembles encoding context).
- **Proactive recall ("it just came to mind"):** background retrieval during the loop that surfaces relevant memories without the agent explicitly asking.
- **Memory tools:** `recall`, `remember`, `forget`, `link`, plus transparent "why was this recalled" explanations.
- **Tip-of-the-tongue mode:** when confidence is low, return partial matches and ask the executive to refine the cue.

**Exit criteria:** Measurable gain on partial-cue and multi-hop recall evals.

## Phase 6 — Salience, emotion & prediction error (the amygdala gate)

**Goal:** Decide _what is worth remembering_.

- **Salience scorer** at encoding combining: surprise (prediction error against the agent's expectation), task relevance, outcome value (success/failure, tests passing, user approval/correction), explicit user emphasis ("remember this"), and novelty vs. existing memory.
- **Expectation modeling:** the agent predicts outcomes of actions; mismatches are tagged as high-value learning events.
- **Valence & affect tags:** errors, user frustration, and rewards modulate consolidation priority (flashbulb-memory analogue).
- **User feedback as dopamine:** thumbs/corrections adjust salience weights and memory strength.
- Calibrate weights via the Phase 2 evals; keep scorer inspectable and tunable.

**Exit criteria:** Memory store stays smaller than a write-everything baseline while matching or beating its recall.

## Phase 7 — Consolidation: "sleep" (replay → semantic integration)

**Goal:** Offline processing that turns experience into knowledge.

- **Triggers:** session end, idle time, token/size thresholds, scheduled (`neuro sleep`).
- **Replay:** sample recent episodes (prioritized by salience), re-run them through an "integration" pass.
- **Abstraction:** extract entities, facts, preferences, and recurring patterns into the semantic store; generalize across episodes (gist extraction); link to source episodes.
- **Interleaved replay:** mix recent and old memories so new knowledge doesn't overwrite or contradict existing knowledge unnoticed; separate "recent" and "remote" replay phases to limit interference.
- **Schema-aware integration:** schema-consistent info merges quickly; schema-violating info is flagged for review/higher scrutiny.
- **Compression:** episodic detail is progressively abstracted (full → summary → gist), with originals archived.
- **Dreaming (optional, experimental):** recombine episodes to hypothesize generalizations or simulate future scenarios; keep outputs clearly marked as hypotheses.
- Consolidation report the user can read.

**Exit criteria:** After "sleeping", agent answers long-horizon questions with fewer tokens and higher accuracy than before; no regression on interference evals.

## Phase 8 — Forgetting, strength & reconsolidation

**Goal:** Keep memory healthy over months of use.

- **Memory strength model:** each memory has strength that decays (Ebbinghaus-style, per-memory rate), is boosted by retrieval and _spaced_ reuse, and is modulated by salience.
- **Active forgetting:** below-threshold memories become _inaccessible_ (archived, de-indexed from default search) but recoverable with a strong cue — not deleted.
- **Reconsolidation:** retrieval opens a short **lability window**; if new evidence contradicts or extends the memory (prediction error), it is revised and re-stored as a new version with lineage. Boundary conditions: memory age, strength, and degree of mismatch.
- **Contradiction handling:** conflicting facts are detected, resolved by recency/provenance/confidence, or surfaced to the user.
- **Source monitoring:** every memory carries origin (user said, tool output, inferred, dreamed) and confidence, to prevent confabulation from hardening into "fact."
- **Privacy & control:** `forget` (true deletion), redaction, retention policies, exportable memory.

**Exit criteria:** Stale-fact rate drops vs. no-update baseline; retrieval latency stays flat as the store grows.

## Phase 9 — Procedural memory & skill learning (the basal ganglia)

**Goal:** Habits — repeated successes become cheap, reliable routines.

- Detect recurring, successful action sequences from traces.
- **Compile** them into reusable skills/macros (parameterized tool sequences or prompts) stored in a procedural memory with success statistics.
- **Deliberate → habitual:** first runs reason step by step; practiced skills execute with minimal context.
- **Habit override:** executive can interrupt a skill when its preconditions or prediction checks fail (prediction error → fall back to deliberate mode).
- Skills are inspectable, editable, shareable (import/export, compatible with open skill formats where practical).

**Exit criteria:** Repeated tasks show significant token/latency reduction without success regression.

## Phase 10 — Executive control & global workspace

**Goal:** Coordinated cognition rather than a single prompt loop.

- **Executive:** maintains the goal stack, decomposes goals, monitors progress, controls the attention gate, and manages token/cost budgets.
- **Global workspace:** specialist modules (retriever, planner, critic, tool-user, memory-writer) propose content; a competition selects what is _broadcast_ into working memory each cycle.
- **Metacognition:** confidence/feeling-of-knowing estimates decide between answering, recalling, searching, or asking the user. Detect "I'm going in circles" and replan.
- **Inhibition:** suppress irrelevant retrieved memories and prior failed approaches.
- **Default-mode loop:** idle-time reflection, planning, and future simulation feeding the consolidation pipeline.
- Optional sub-agents (parallel "regions") with scoped working memories and shared long-term memory.

**Exit criteria:** Improved success on multi-step, long-horizon tasks versus Phase 3–9 configurations in ablation.

## Phase 11 — Developer experience, observability & ecosystem

**Goal:** Make it pleasant to use, extend, and trust.

- **Memory inspector** (TUI / local web UI): live view of working memory, recalls, writes, salience scores, decay, consolidation diffs; "why did it remember/forget this?"
- Plugin API for tools, memory backends, salience scorers, embedding providers; MCP client/server support.
- Config profiles ("fast & cheap", "deep memory"); per-project and global memory scopes.
- Library mode (embed as an SDK) and a headless server mode.
- Docs site, tutorials, example agents (coding assistant, research assistant, personal assistant).

**Exit criteria:** A new contributor can add a memory backend or scorer from docs alone.

## Phase 12 — Hardening, safety & v1.0

**Goal:** Production-ready and trustworthy.

- **Security:** sandboxing, permission model, prompt-injection defenses (untrusted tool output is tagged and cannot write high-trust memories or alter goals), memory-poisoning detection, secrets redaction before storage.
- **Privacy:** local-first by default, encryption at rest option, full export/delete.
- Performance: indexing, caching, batching, background workers; scale tests (10⁵–10⁶ memories).
- Reliability: crash-safe writes, migrations, backward-compatible memory schema versions.
- Published benchmark results and methodology; semantic versioning; v1.0 release.

---

## Stretch / research tracks (post-1.0)

- **Learned components:** train small models for salience, cue generation, and consolidation instead of prompting a frontier model.
- **Neuromodulation analogues:** global "arousal/exploration" parameters that shift retrieval breadth, learning rate, and temperature.
- **Multi-agent shared memory:** social/semantic memory across agents and teams with provenance and trust.
- **Emotion-congruent and state-dependent recall.**
- **Continual weight-level learning** (LoRA adapters as "cortical" slow weights) consolidated from the semantic store — true CLS at the parameter level.
- **Multimodal memory** (images, audio, screenshots).
- **Neuroscience advisory loop:** invite cognitive scientists to critique the mappings and propose better ones.

## Risks & open questions

| Risk                                                                                                                  | Mitigation                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Brain metaphors add complexity without benefit                                                                        | Evals first (Phase 2); each mechanism must beat a baseline or be cut                                    |
| LLM-driven consolidation hallucinates or drifts                                                                       | Provenance links, hypothesis labeling, source monitoring, human-readable diffs, rollback via versioning |
| Cost/latency of background processes                                                                                  | Budgets, idle-time scheduling, cheaper models for gating/consolidation                                  |
| Memory poisoning / prompt injection                                                                                   | Trust levels per source; untrusted content never writes high-trust semantic memory                      |
| Privacy of stored experience                                                                                          | Local-first, redaction, retention policies, true deletion                                               |
| Neuroscience is contested in places (e.g. exact roles of CA3/DG, replay's causal role, reconsolidation replicability) | Treat as design heuristics, document uncertainty in `docs/NEUROSCIENCE.md`                              |

## Suggested milestones

| Milestone             | Phases | Outcome                                                    |
| --------------------- | ------ | ---------------------------------------------------------- |
| **M0 – Skeleton**     | 0–1    | Working baseline agent + CLI                               |
| **M1 – Measurable**   | 2–3    | Evals + curated working memory                             |
| **M2 – It remembers** | 4–5    | Persistent episodic/semantic memory with cue-based recall  |
| **M3 – It learns**    | 6–8    | Salience, sleep consolidation, forgetting, reconsolidation |
| **M4 – It's skilled** | 9–10   | Procedural skills, executive, workspace                    |
| **M5 – It ships**     | 11–12  | Tooling, hardening, v1.0                                   |

Phases 3–10 are intended to be developed behind feature flags so every mechanism can be ablated in the eval suite.
