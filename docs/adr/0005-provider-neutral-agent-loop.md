# 0005. Provider-neutral messages and the baseline agent loop

- Status: accepted
- Date: 2026-10-15

## Context

Phase 1 needs a conventional agent (the control group for every later phase) that runs against Anthropic, OpenAI-compatible servers, and local models, and that records everything needed for evals and replay.

## Decision

- `@neuro-agent/core` owns a small, provider-neutral conversation model (`Message`, text / tool call / tool result blocks) and a `Provider` interface that streams `text_delta` events and ends with one normalized `done` event (assistant message, stop reason, usage).
- Provider-specific content the next request must echo back (Anthropic thinking and fallback blocks) is carried as `opaque` blocks tagged with their provider; other providers drop them.
- The Anthropic adapter uses the official `@anthropic-ai/sdk`. OpenAI-compatible servers (OpenAI, vLLM, LM Studio, Ollama's `/v1`) share one `fetch`-based adapter, so no second SDK is needed.
- Tools are defined once with zod and converted to JSON Schema (`zod-to-json-schema`). The loop validates every tool input against its schema before running it, so malformed or truncated model output becomes an error result instead of a crash.
- Tools declare a permission (`read`, `write`, `execute`); non-read tools pass an approval hook that defaults to deny.
- Context selection is a pluggable `ContextStrategy`. The baseline is a sliding window that cuts only at user-turn boundaries so tool calls and results stay paired.
- Every state change is emitted as an `AgentEvent` (ADR 0002) and can be written to a JSONL trace.

## Consequences

- Later phases replace the context strategy (Phase 3) and add memory without touching providers or tools.
- Anthropic thinking blocks are bound to the exact history that produced them. When the sliding window drops earlier messages, the adapter strips thinking blocks rather than replaying them; this costs some reasoning continuity on long sessions and is part of what the baseline measures.
- The shell tool scrubs the environment, confines its working directory to the workspace, and enforces a timeout, but it is not an OS-level sandbox; it relies on per-call approval. Real isolation is Phase 12 work.
