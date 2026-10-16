import { z } from "zod";
import type { AssistantContent } from "./messages.js";
import type { StopReason } from "./provider.js";
import type { Usage } from "./usage.js";

/**
 * All agent state changes are expressed as immutable, timestamped events
 * (see docs/adr/0002-event-sourced-state.md). This is the shared envelope;
 * `AgentEventPayloads` lists the concrete kinds the agent loop emits.
 */
export const AgentEventSchema = z.object({
  id: z.string().min(1),
  /** Event discriminator, e.g. "message.user" or "tool.result". */
  type: z.string().min(1),
  /** Milliseconds since the Unix epoch. */
  timestamp: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  payload: z.record(z.unknown()),
});

export type AgentEvent = z.infer<typeof AgentEventSchema>;

export function createEvent(
  input: Pick<AgentEvent, "type" | "sessionId" | "payload">,
  now: () => number = Date.now,
): AgentEvent {
  return AgentEventSchema.parse({
    id: globalThis.crypto.randomUUID(),
    timestamp: now(),
    ...input,
  });
}

/** Bumped when the meaning of recorded events changes; replay checks it. */
export const TRACE_VERSION = 1;

export type RunEndReason =
  "end_turn" | "max_turns" | "max_tokens" | "refusal" | "cancelled" | "error";

/** Payloads of the events emitted by the Phase 1 agent loop. */
export interface AgentEventPayloads {
  "session.start": {
    traceVersion: number;
    provider: string;
    model: string;
    contextStrategy: string;
    cwd: string;
    tools: string[];
  };
  /** Perceive: input arrives. */
  "message.user": { text: string };
  /** Think: a model call starts. */
  "model.request": {
    turn: number;
    messages: number;
    droppedMessages: number;
    estimatedTokens: number;
    rewritten: boolean;
    retrieved?: { id: string; score: number; text: string }[];
  };
  "model.restart": { turn: number; reason: string };
  /** Think: a model call finished. */
  "message.assistant": {
    turn: number;
    content: AssistantContent[];
    stopReason: StopReason;
    usage: Usage;
    costUsd: number;
  };
  /** Act. */
  "tool.call": { id: string; name: string; input: unknown };
  "tool.denied": { id: string; name: string; reason: string };
  /** Observe. */
  "tool.result": {
    id: string;
    name: string;
    content: string;
    isError: boolean;
    durationMs: number;
  };
  "run.end": {
    reason: RunEndReason;
    turns: number;
    usage: Usage;
    costUsd: number;
    error?: string;
  };
}

export type AgentEventType = keyof AgentEventPayloads;

export type TypedAgentEvent<K extends AgentEventType = AgentEventType> = {
  [T in K]: Omit<AgentEvent, "type" | "payload"> & { type: T; payload: AgentEventPayloads[T] };
}[K];

/** Narrows an envelope to a known event kind. */
export function isEvent<K extends AgentEventType>(
  event: AgentEvent,
  type: K,
): event is AgentEvent & TypedAgentEvent<K> {
  return event.type === type;
}
