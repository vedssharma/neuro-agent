import { z } from "zod";

/**
 * All agent state changes are expressed as immutable, timestamped events
 * (see docs/adr/0002-event-sourced-state.md). Later phases add concrete event
 * kinds (messages, tool calls, memory writes, ...); this is the shared envelope.
 */
export const AgentEventSchema = z.object({
  id: z.string().min(1),
  /** Event discriminator, e.g. "message.user" or "memory.write". */
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
