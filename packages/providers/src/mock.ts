import type {
  AssistantContent,
  AssistantMessage,
  ModelRequest,
  Provider,
  StopReason,
  StreamEvent,
  Usage,
} from "@neuro-agent/core";

export interface ScriptedTurn {
  content: AssistantContent[];
  stopReason?: StopReason;
  usage?: Partial<Usage>;
}

export type Script = ScriptedTurn[] | ((request: ModelRequest, call: number) => ScriptedTurn);

/**
 * Deterministic provider for tests and offline runs: replays scripted turns
 * and records every request it receives.
 */
export class ScriptedProvider implements Provider {
  readonly name = "scripted";
  readonly requests: Omit<ModelRequest, "signal">[] = [];

  constructor(private readonly script: Script) {}

  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    const call = this.requests.length;
    const recorded: ModelRequest = { ...request };
    delete recorded.signal;
    this.requests.push(structuredClone(recorded));
    request.signal?.throwIfAborted();
    const turn = typeof this.script === "function" ? this.script(request, call) : this.script[call];
    if (!turn) throw new Error(`ScriptedProvider: no scripted turn #${call + 1}`);

    for (const block of turn.content) {
      if (block.type === "text") yield { type: "text_delta", text: block.text };
    }
    request.signal?.throwIfAborted();
    const message: AssistantMessage = { role: "assistant", content: turn.content };
    const hasCalls = turn.content.some((b) => b.type === "tool_call");
    yield {
      type: "done",
      message,
      stopReason: turn.stopReason ?? (hasCalls ? "tool_use" : "end_turn"),
      usage: {
        inputTokens: turn.usage?.inputTokens ?? 0,
        outputTokens: turn.usage?.outputTokens ?? 0,
        cacheReadTokens: turn.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: turn.usage?.cacheWriteTokens ?? 0,
      },
    };
  }
}
