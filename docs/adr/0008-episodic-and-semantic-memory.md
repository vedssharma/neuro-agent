# 0008. Episodic and semantic long-term memory

- Status: accepted
- Date: 2026-10-26

## Context

Phase 3 carried memory across sessions with the Phase 2 vector store, which keeps whole messages, cannot tell an old value from its correction, and lives only in process memory. Phase 4 calls for two long-term stores with different write policies (an episodic store of events and a semantic store of facts linked into a knowledge graph), an encoding pipeline with a salience gate, hybrid retrieval, and on-disk storage the user can inspect.

## Decision

- **Storage interface.** `MemoryBackend` (in `@neuro-agent/memory`) stores episodes, facts and entities and offers full-text and vector search. Methods are async so remote backends fit. Two implementations:
  - `InMemoryBackend`, with an in-process BM25 index (tests and evaluation);
  - `SqliteBackend` in the new `@neuro-agent/store-sqlite` package, on `better-sqlite3`. Records are JSON rows, full-text search uses FTS5's BM25, and embeddings are stored as blobs and loaded into a pluggable `VectorIndex` (brute force for now) on open. This settles the driver left open in ADR 0004: `node:sqlite` is not available on Node 20, which we still support.
- **Episodic store.** Every event that passes the gate becomes an episode with who, where (role or tool call), session, a global encoding time, its entities, a compact index (the most informative sentences, up to 400 characters) and the full text as its artifact. **Pattern separation:** when an episode is close to an earlier one (cosine ≥ 0.5), the words that tell it apart are stored with it and indexed.
- **Semantic store.** Facts ("the X is Y") and first-person preferences ("I prefer tabs") are extracted heuristically from user and tool events, never from the assistant's own words. Each fact keeps provenance: its supporting episodes and sessions. A fact with the same subject and a new value **supersedes** the old one, which is kept and marked. Facts and episodes link to entities (paths, codes, names and the noun phrases of fact subjects), which form the knowledge graph.
- **Encoding pipeline.** Event, then candidate episode and facts, then the salience gate, then write. An event passes when it is salient (≥ 0.5), states a fact, has an outcome, or was attended in working memory. Phase 6 replaces the salience heuristic.
- **Retrieval v1.** Three channels, each with a feature flag: BM25, embedding similarity, and the graph (entities named in the query plus one hop through their episodes, rarer entities weighted higher). Their results are fused by reciprocal rank. Superseded facts, and episodes whose facts have all been superseded, are left out unless asked for.
- **Integration.** `WorkingMemory` takes a `longTerm` store. Promoted chunks are encoded into it, and its recall fills the activated region in encoding order, so later statements come last. `neuro --memory` keeps long-term memory in `.neuro/memory.db`; `neuro memory stats|search|export` inspects it, and export writes JSONL or Markdown.

## Consequences

- Offline (`docs/evals/simulated-standard.md`), long-term memory scores 100% on every suite. Vector RAG scores 91% overall, and 80% on the new `dense-interference` suite, where long messages are truncated and near-duplicate facts from other buildings crowd the top results. Without the semantic store, `dense-interference` drops to 35%.
- Offline, Phase 3 working memory over the plain vector store also scores 100%, because the simulated reader reads every relevant sentence it is shown. The phase 4 stores add what the scores can't show: persistence, inspectability, supersession and provenance, and higher retrieval precision (47% against 28% for vector RAG).
- With the hashed bag-of-words embedder, the lexical and vector channels largely agree: `ltm-vector-only` also scores 100%, with higher precision (55%). The hybrid's value has to be shown with a neural embedder and a live model.
- Heuristic extraction only understands "the X is Y" statements and simple preferences. Model-based extraction and Phase 6 salience are follow-ups.
- Vector search is brute force over all vectors in memory, which is fine for thousands of records but not for millions. The `VectorIndex` interface is where an ANN index goes.
