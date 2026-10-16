# Evaluations

Every brain-inspired mechanism in later phases has to beat the baselines measured here (see the [roadmap](../../ROADMAP.md), principle 6). One command runs the whole suite and writes a comparison report:

```sh
pnpm eval                                   # offline, deterministic: writes docs/evals/simulated-standard.md
node packages/cli/dist/bin.js eval --help   # options
node packages/cli/dist/bin.js eval -p anthropic --scale small --out docs/evals   # live model (costs money)
```

Published reports:

- [simulated-standard.md](simulated-standard.md): offline baseline numbers (seed 1, 4,000-token window, 16,000-token model limit).

Live-model reports will be added once they've been run with an API key.

## What runs

Each **task** is a scripted conversation: one or more sessions of user turns, some of which are **probes** with an expected answer. A new session starts a fresh agent; only long-term memory (the vector store) carries over. Tasks are generated from a seed, so a run is reproducible.

| Suite          | What it tests                                                                                                                           | Roadmap item                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `long-horizon` | Read 16 files one tool call at a time and add up a value from each. The reads alone exceed the model's context window.                  | (a) context far beyond the window        |
| `recall`       | Two facts stated early, probed after 30 filler turns and again in a new session.                                                        | (b) needle / fact recall across sessions |
| `update`       | A fact stated, later corrected ("I changed my mind"), probed in the same and a new session. A reply with the old value counts as stale. | (c) contradiction / update               |
| `interference` | 40 similar facts (locker codes), each with a near-duplicate distractor ("locker 12 annex"); three are probed.                           | (d) distractor / interference            |

Every task records tokens, model calls, cost and wall-clock time (roadmap item e).

## Baselines

| Strategy          | What the model sees each call                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full-transcript` | Everything said in this session.                                                                                                                                      |
| `sliding-window`  | The newest messages that fit in the window, cut at user-turn boundaries.                                                                                              |
| `summary-buffer`  | A sliding window plus a running summary of what slid out (extractive offline, the model under test in live runs).                                                     |
| `vector-rag`      | A sliding window plus the top 4 earlier messages most similar to the current request, from a vector store that outlives the session (hashed bag-of-words embeddings). |

## Metrics

- **Accuracy**: share of probes whose reply contains the expected answer (case-insensitive).
- **Task success**: share of tasks with every probe correct.
- **Stale answers**: share of probes answered with a superseded value.
- **Tokens / task**: input + output tokens across all model calls, including summarizer calls in live runs.
- **Recall@k / retrieval precision** (retrieval strategies only, on probes whose answer was outside the window): whether any of the k recalled items contained the answer, and what share of them did.
- **Wall-clock / task**, **errors** (e.g. requests over the context limit).

## The simulated model

Offline runs use `SimulatedReader`, a deterministic stand-in for an LLM. It sees only the request it is sent, answers "What is the X?" from "the X is Y" statements visible in that request (the latest statement wins), reads files it can't yet see a value for, and rejects prompts over its context limit. It has no memory between calls. Its scores therefore measure **what each context strategy delivers to the model**, not language understanding: a live model can do worse (it can be distracted) or better (it can infer). Use live runs to confirm any conclusion drawn offline.

## Traces and replay

`neuro eval --traces` writes one JSONL trace per task, strategy and session. `neuro replay <trace>` re-runs a recorded session using the recorded model turns and tool results (no network, no side effects) and reports the first event that differs. This catches behavior changes in the agent loop.

## Reading the current baseline

- **No baseline survives a single turn bigger than the model's window** (`long-horizon`: 0% everywhere). Sliding windows only drop whole turns, so the latest turn's tool output always goes in whole. This is the gap Phase 3's chunking and attention gate target.
- **Full transcript** is exact until the conversation outgrows the model, then every request fails.
- **Summary buffer** keeps about half of the in-session facts at fewer tokens than the alternatives, but has nothing to offer in a new session.
- **Vector RAG** is the only baseline that remembers across sessions, and the strongest overall. Its retrieval precision is low (31%), so most recalled items are distractors. A real model is more likely to be misled by them than the simulated reader is. Phase 4 has to beat this on recall and interference.
