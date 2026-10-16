import { z } from "zod";
import {
  Agent,
  isEvent,
  TRACE_VERSION,
  type AgentEvent,
  type AgentOptions,
  type AnyTool,
  type ContextStrategy,
  type Provider,
  type StreamEvent,
  type ModelRequest,
} from "@neuro-agent/core";

/** A provider that returns the assistant turns recorded in a trace, in order. */
export class ReplayProvider implements Provider {
  readonly name = "replay";
  private call = 0;

  constructor(private readonly turns: AgentEvent[]) {}

  static fromTrace(events: readonly AgentEvent[]): ReplayProvider {
    return new ReplayProvider(events.filter((e) => isEvent(e, "message.assistant")));
  }

  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    request.signal?.throwIfAborted();
    const event = this.turns[this.call++];
    if (!event || !isEvent(event, "message.assistant")) {
      throw new Error(`replay: the trace has no model turn #${this.call}`);
    }
    const { content, stopReason, usage } = event.payload;
    for (const block of content)
      if (block.type === "text") yield { type: "text_delta", text: block.text };
    yield { type: "done", message: { role: "assistant", content }, stopReason, usage };
  }
}

export interface ReplayResult {
  events: AgentEvent[];
  /** Index of the first event whose content differs from the original, or -1. */
  divergence: number;
}

/**
 * Re-runs a recorded session: same user inputs, recorded model turns, and
 * recorded tool results. With an unchanged agent loop the new trace matches
 * the original event for event; a divergence points at a behavior change.
 */
export async function replaySession(
  events: readonly AgentEvent[],
  options: { context?: ContextStrategy } = {},
): Promise<ReplayResult> {
  const start = events.find((e) => isEvent(e, "session.start"));
  if (!start || !isEvent(start, "session.start"))
    throw new Error("replay: trace has no session.start event");
  if (start.payload.traceVersion !== TRACE_VERSION) {
    throw new Error(
      `replay: trace version ${String(start.payload.traceVersion)} is not ${TRACE_VERSION}`,
    );
  }

  const toolResults = new Map<string, { content: string; isError: boolean }>();
  for (const e of events) {
    if (isEvent(e, "tool.result"))
      toolResults.set(e.payload.id, { content: e.payload.content, isError: e.payload.isError });
  }
  const denied = new Set(
    events.filter((e) => isEvent(e, "tool.denied")).map((e) => String(e.payload.id)),
  );
  const names = new Set<string>(start.payload.tools);
  const tools: AnyTool[] = [...names].map((name) => ({
    name,
    description: `Replays recorded ${name} results`,
    permission: "write" as const,
    input: z.unknown(),
    execute: async () => ({ content: "", isError: true }),
  }));

  const replayed: AgentEvent[] = [];
  let pendingCallId = "";
  const agentOptions: AgentOptions = {
    provider: ReplayProvider.fromTrace(events),
    model: start.payload.model,
    tools: tools.map((t) => ({
      ...t,
      execute: async () => {
        const recorded = toolResults.get(pendingCallId);
        return (
          recorded ?? { content: `replay: no recorded result for ${pendingCallId}`, isError: true }
        );
      },
    })),
    approve: ({ id }) => !denied.has(id),
    cwd: start.payload.cwd,
    sessionId: start.sessionId,
    onEvent: (e) => {
      if (isEvent(e, "tool.call")) pendingCallId = e.payload.id;
      replayed.push(e);
    },
    maxTurns: Number.MAX_SAFE_INTEGER,
    ...(options.context ? { context: options.context } : {}),
  };
  const agent = new Agent(agentOptions);
  for (const e of events) {
    if (isEvent(e, "message.user")) await agent.send(e.payload.text);
  }
  return { events: replayed, divergence: firstDivergence(events, replayed) };
}

// Timings, and the fields that describe how the replay itself was wired, never count as divergence.
const VOLATILE = new Set(["durationMs", "costUsd", "provider", "contextStrategy"]);
// Context selection depends on strategy state that a trace doesn't capture (e.g. a
// vector store built in earlier sessions), so only the presence of model calls is compared.
const TYPE_ONLY = new Set(["model.request"]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !VOLATILE.has(k))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

/**
 * Compares event types and payloads, ignoring ids, timestamps, timings, and
 * context-selection details.
 */
export function firstDivergence(a: readonly AgentEvent[], b: readonly AgentEvent[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.type !== y.type) return i;
    if (TYPE_ONLY.has(x.type)) continue;
    if (JSON.stringify(normalize(x.payload)) !== JSON.stringify(normalize(y.payload))) return i;
  }
  return -1;
}
