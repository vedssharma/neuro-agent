import { SlidingWindow, type ContextStrategy } from "./context.js";
import {
  createEvent,
  type AgentEvent,
  type AgentEventPayloads,
  type AgentEventType,
  type RunEndReason,
} from "./events.js";
import {
  toolCallsOf,
  type AssistantMessage,
  type Message,
  type ToolCallBlock,
  type ToolResultBlock,
  type UserContent,
} from "./messages.js";
import type { Provider, StopReason, ToolSpec } from "./provider.js";
import { denyAll, toToolSpec, type AnyTool, type ApprovalHook } from "./tool.js";
import type { EventSink } from "./trace.js";
import { addUsage, CostTracker, ZERO_USAGE, type Usage } from "./usage.js";

export interface AgentOptions {
  provider: Provider;
  model: string;
  tools?: AnyTool[];
  system?: string;
  /** Default: sliding window over the newest 100k estimated tokens. */
  context?: ContextStrategy;
  /** Model calls allowed per `send` before stopping. Default 25. */
  maxTurns?: number;
  /** Output token cap per model call. Default 16000. */
  maxTokens?: number;
  /** Tool results longer than this are truncated before the model sees them. Default 50k chars. */
  maxToolOutputChars?: number;
  /** Gate for `write`/`execute` tools. Default: deny. */
  approve?: ApprovalHook;
  /** Workspace root passed to tools. Default: process.cwd(). */
  cwd?: string;
  sessionId?: string;
  onEvent?: EventSink;
  /** Streams assistant text as it arrives. */
  onText?: (delta: string) => void;
  /** Called when the provider re-issues a call; partial text shown so far is void. */
  onRestart?: (reason: string) => void;
  costs?: CostTracker;
  now?: () => number;
}

export interface RunResult {
  reason: RunEndReason;
  /** Final assistant text of the run. */
  text: string;
  turns: number;
  /** Usage and cost of this run only. */
  usage: Usage;
  costUsd: number;
  error?: Error;
}

export const DEFAULT_CONTEXT_TOKENS = 100_000;

/**
 * The Phase 1 baseline agent: perceive → think → act → observe, repeated
 * until the model stops calling tools, with no memory beyond the transcript.
 */
export class Agent {
  readonly sessionId: string;
  readonly costs: CostTracker;
  private readonly transcriptLog: Message[] = [];
  private readonly tools: Map<string, AnyTool>;
  private readonly toolSpecs: ToolSpec[];
  private readonly context: ContextStrategy;
  private readonly now: () => number;
  private started = false;

  constructor(private readonly options: AgentOptions) {
    this.sessionId = options.sessionId ?? globalThis.crypto.randomUUID();
    this.costs = options.costs ?? new CostTracker();
    this.context = options.context ?? new SlidingWindow(DEFAULT_CONTEXT_TOKENS);
    this.now = options.now ?? Date.now;
    this.tools = new Map();
    for (const tool of options.tools ?? []) {
      if (this.tools.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
    this.toolSpecs = [...this.tools.values()].map(toToolSpec);
  }

  /** The full conversation so far (the context strategy decides what the model sees). */
  get transcript(): readonly Message[] {
    return this.transcriptLog;
  }

  /** Runs one user request to completion, cancellation, or the turn limit. */
  async send(text: string, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    const signal = options.signal ?? new AbortController().signal;
    const maxTurns = this.options.maxTurns ?? 25;
    const startCost = this.costs.costUsd;
    let usage = ZERO_USAGE;
    let turns = 0;
    let lastText = "";

    const finish = (reason: RunEndReason, error?: Error): RunResult => {
      const costUsd = this.costs.costUsd - startCost;
      this.emit("run.end", {
        reason,
        turns,
        usage,
        costUsd,
        ...(error ? { error: error.message } : {}),
      });
      return { reason, text: lastText, turns, usage, costUsd, ...(error ? { error } : {}) };
    };

    if (!this.started) {
      this.started = true;
      this.emit("session.start", {
        provider: this.options.provider.name,
        model: this.options.model,
        contextStrategy: this.context.name,
        cwd: this.cwd,
        tools: [...this.tools.keys()],
      });
    }

    // Perceive.
    this.emit("message.user", { text });
    this.appendUser([{ type: "text", text }]);

    try {
      while (turns < maxTurns) {
        if (signal.aborted) return finish("cancelled");
        turns++;

        // Think.
        const { message, stopReason, usage: callUsage } = await this.think(turns, signal);
        usage = addUsage(usage, callUsage);
        const costUsd = this.costs.add(this.options.model, callUsage);
        this.transcriptLog.push(message);
        this.emit("message.assistant", {
          turn: turns,
          content: message.content,
          stopReason,
          usage: callUsage,
          costUsd,
        });
        lastText = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");

        const calls = toolCallsOf(message);
        if (stopReason === "refusal") {
          this.closeCalls(calls, "Not executed: the model refused this turn.");
          return finish("refusal");
        }
        if (calls.length === 0) {
          return finish(stopReason === "max_tokens" ? "max_tokens" : "end_turn");
        }
        if (stopReason === "max_tokens") {
          // The last call's input may be truncated; never run it.
          this.closeCalls(
            calls,
            "Not executed: output hit max_tokens, so the input may be incomplete.",
          );
          return finish("max_tokens");
        }

        // Act, then observe.
        const results: ToolResultBlock[] = [];
        for (const call of calls) {
          if (signal.aborted) {
            results.push(cancelledResult(call));
            continue;
          }
          results.push(await this.act(call, signal));
        }
        this.appendUser(results);
        if (signal.aborted) return finish("cancelled");
      }
      return finish("max_turns");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (signal.aborted || error.name === "AbortError") return finish("cancelled");
      return finish("error", error);
    }
  }

  private get cwd(): string {
    return this.options.cwd ?? process.cwd();
  }

  private async think(
    turn: number,
    signal: AbortSignal,
  ): Promise<{ message: AssistantMessage; stopReason: StopReason; usage: Usage }> {
    const selection = this.context.select(this.transcriptLog);
    this.emit("model.request", {
      turn,
      messages: selection.messages.length,
      droppedMessages: selection.dropped,
      estimatedTokens: selection.estimatedTokens,
    });
    const stream = this.options.provider.stream({
      model: this.options.model,
      ...(this.options.system !== undefined ? { system: this.options.system } : {}),
      messages: selection.messages,
      tools: this.toolSpecs,
      maxTokens: this.options.maxTokens ?? 16_000,
      historyTruncated: selection.dropped > 0,
      signal,
    });
    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          this.options.onText?.(event.text);
          break;
        case "restart":
          this.emit("model.restart", { turn, reason: event.reason });
          this.options.onRestart?.(event.reason);
          break;
        case "done":
          return event;
      }
    }
    throw new Error(`provider ${this.options.provider.name} ended without a done event`);
  }

  private async act(call: ToolCallBlock, signal: AbortSignal): Promise<ToolResultBlock> {
    this.emit("tool.call", { id: call.id, name: call.name, input: call.input });
    const started = this.now();
    const result = (content: string, isError: boolean): ToolResultBlock => {
      const max = this.options.maxToolOutputChars ?? 50_000;
      if (content.length > max) {
        content = `${content.slice(0, max)}\n[truncated ${content.length - max} characters]`;
      }
      this.emit("tool.result", {
        id: call.id,
        name: call.name,
        content,
        isError,
        durationMs: this.now() - started,
      });
      return { type: "tool_result", toolCallId: call.id, content, isError };
    };
    const deny = (reason: string): ToolResultBlock => {
      this.emit("tool.denied", { id: call.id, name: call.name, reason });
      return { type: "tool_result", toolCallId: call.id, content: reason, isError: true };
    };

    const tool = this.tools.get(call.name);
    if (!tool) return result(`Unknown tool: ${call.name}`, true);

    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) {
      return result(`Invalid input for ${call.name}: ${parsed.error.message}`, true);
    }

    if (tool.permission !== "read") {
      const approve = this.options.approve ?? denyAll;
      const approved = await approve({ id: call.id, tool, input: parsed.data });
      if (!approved) return deny(`The user did not approve this ${call.name} call.`);
    }

    try {
      const output = await tool.execute(parsed.data, { cwd: this.cwd, signal });
      return result(output.content, output.isError ?? false);
    } catch (err) {
      if (signal.aborted) return result("Cancelled.", true);
      return result(
        `${call.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  }

  /** Answers unrun tool calls so the transcript stays valid for the next request. */
  private closeCalls(calls: ToolCallBlock[], reason: string): void {
    if (calls.length === 0) return;
    this.appendUser(
      calls.map((c) => ({ type: "tool_result", toolCallId: c.id, content: reason, isError: true })),
    );
  }

  /** Appends user content, merging into a trailing user message so roles alternate. */
  private appendUser(content: UserContent[]): void {
    const last = this.transcriptLog.at(-1);
    if (last?.role === "user") last.content.push(...content);
    else this.transcriptLog.push({ role: "user", content });
  }

  private emit<K extends AgentEventType>(type: K, payload: AgentEventPayloads[K]): void {
    if (!this.options.onEvent) return;
    const event: AgentEvent = createEvent(
      { type, sessionId: this.sessionId, payload: payload as unknown as Record<string, unknown> },
      this.now,
    );
    this.options.onEvent(event);
  }
}

function cancelledResult(call: ToolCallBlock): ToolResultBlock {
  return { type: "tool_result", toolCallId: call.id, content: "Cancelled.", isError: true };
}
