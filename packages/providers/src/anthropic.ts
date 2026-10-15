import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantContent,
  Message,
  ModelRequest,
  Provider,
  StopReason,
  StreamEvent,
} from "@neuro-agent/core";

import type * as Beta from "@anthropic-ai/sdk/resources/beta/messages/messages";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicProviderOptions {
  /** Defaults to the SDK's own credential resolution (ANTHROPIC_API_KEY, etc.). */
  apiKey?: string;
  baseURL?: string;
  /** Inject a preconfigured client (e.g. for tests). */
  client?: Anthropic;
  /** `output_config.effort`; omitted means the model's default. */
  effort?: Effort;
  /**
   * Opt into server-side refusal fallbacks (`fallbacks: "default"`). Default:
   * on for models that support it.
   */
  refusalFallback?: boolean;
  /** Re-issues a call whose streamed tool input could not be parsed. Default 2. */
  maxParseRetries?: number;
}

const PROVIDER = "anthropic";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const FALLBACK_MODELS = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

/** Claude via the official Anthropic SDK, streaming, with tool calls normalized. */
export class AnthropicProvider implements Provider {
  readonly name = PROVIDER;
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicProviderOptions = {}) {
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      });
  }

  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    const fallback = (this.options.refusalFallback ?? true) && FALLBACK_MODELS.has(request.model);
    const params: Beta.MessageCreateParamsStreaming = {
      model: request.model,
      max_tokens: request.maxTokens,
      messages: toAnthropicMessages(request.messages, request.historyTruncated ?? false),
      stream: true,
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Beta.BetaTool.InputSchema,
              // Tool inputs (file bodies) can be large; stream them as generated.
              // The agent validates every input against its zod schema before running it.
              eager_input_streaming: true,
            })),
          }
        : {}),
      ...(this.options.effort ? { output_config: { effort: this.options.effort } } : {}),
      ...(fallback ? { fallbacks: "default" as const, betas: [FALLBACK_BETA] } : {}),
    };

    const maxRetries = this.options.maxParseRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const stream = this.client.beta.messages.stream(params, {
        ...(request.signal ? { signal: request.signal } : {}),
      });
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          }
        }
        const final = await stream.finalMessage();
        yield {
          type: "done",
          message: { role: "assistant", content: fromAnthropicContent(final.content) },
          stopReason: mapStopReason(final.stop_reason),
          usage: {
            inputTokens: final.usage.input_tokens,
            outputTokens: final.usage.output_tokens,
            cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
          },
        };
        return;
      } catch (err) {
        // API errors and aborts propagate; only unparseable streamed tool JSON is retried.
        const retryable =
          !(err instanceof Anthropic.APIError) &&
          !request.signal?.aborted &&
          !(err instanceof Error && err.name === "AbortError") &&
          attempt < maxRetries;
        if (!retryable) throw err;
        yield { type: "restart", reason: `unparseable tool input: ${(err as Error).message}` };
      }
    }
  }
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function fromAnthropicContent(content: Beta.BetaContentBlock[]): AssistantContent[] {
  return content.map((block): AssistantContent => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "tool_use":
        return { type: "tool_call", id: block.id, name: block.name, input: block.input };
      default:
        // Thinking, fallback, and other blocks are echoed back unchanged.
        return { type: "opaque", provider: PROVIDER, data: block };
    }
  });
}

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

/**
 * Converts the neutral transcript to Anthropic messages. Thinking blocks are
 * bound to the exact history that produced them, so when the context strategy
 * has dropped earlier messages they are stripped rather than replayed.
 */
export function toAnthropicMessages(
  messages: readonly Message[],
  historyTruncated: boolean,
): Beta.BetaMessageParam[] {
  const out: Beta.BetaMessageParam[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({
        role: "user",
        content: message.content.map((b): Beta.BetaContentBlockParam =>
          b.type === "text"
            ? { type: "text", text: b.text }
            : {
                type: "tool_result",
                tool_use_id: b.toolCallId,
                content: b.content,
                is_error: b.isError,
              },
        ),
      });
      continue;
    }
    const content: Beta.BetaContentBlockParam[] = [];
    for (const b of message.content) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "tool_call") {
        content.push({
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: b.input as Record<string, unknown>,
        });
      } else if (b.provider === PROVIDER) {
        const data = b.data as { type: string };
        if (historyTruncated && THINKING_TYPES.has(data.type)) continue;
        content.push(data as Beta.BetaContentBlockParam);
      }
    }
    if (content.length > 0) out.push({ role: "assistant", content });
  }
  return out;
}
