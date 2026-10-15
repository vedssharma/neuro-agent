import type { AssistantMessage, Message } from "./messages.js";
import type { Usage } from "./usage.js";

/** A tool as advertised to a model: name, description, JSON Schema for its input. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  /**
   * True when the context strategy dropped earlier messages. Adapters whose
   * opaque blocks are bound to the full history (e.g. Anthropic thinking) strip them.
   */
  historyTruncated?: boolean;
  signal?: AbortSignal;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  /** The provider is re-issuing the request; discard any partial output shown so far. */
  | { type: "restart"; reason: string }
  | { type: "done"; message: AssistantMessage; stopReason: StopReason; usage: Usage };

/**
 * A model backend. `stream` must end with exactly one `done` event and must
 * reject with an AbortError when `request.signal` aborts.
 */
export interface Provider {
  readonly name: string;
  stream(request: ModelRequest): AsyncIterable<StreamEvent>;
}

/** Drains a stream into its final `done` event (useful for tests and non-interactive callers). */
export async function complete(
  provider: Provider,
  request: ModelRequest,
): Promise<Extract<StreamEvent, { type: "done" }>> {
  let done: Extract<StreamEvent, { type: "done" }> | undefined;
  for await (const event of provider.stream(request)) {
    if (event.type === "done") done = event;
  }
  if (!done) throw new Error(`provider ${provider.name} ended without a done event`);
  return done;
}
