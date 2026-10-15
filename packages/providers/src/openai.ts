import type {
  AssistantContent,
  Message,
  ModelRequest,
  Provider,
  StopReason,
  StreamEvent,
} from "@neuro-agent/core";
import { sseData } from "./sse.js";

export interface OpenAICompatibleOptions {
  /** e.g. https://api.openai.com/v1 or http://localhost:11434/v1 */
  baseURL: string;
  apiKey?: string;
  /** Name reported in traces. Default "openai-compatible". */
  name?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

/** Wire types for the subset of the Chat Completions API we use. */
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

/**
 * Any server speaking the OpenAI Chat Completions streaming protocol
 * (OpenAI, vLLM, LM Studio, Ollama's /v1, ...).
 */
export class OpenAICompatibleProvider implements Provider {
  readonly name: string;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.name = options.name ?? "openai-compatible";
  }

  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const body = {
      model: request.model,
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: toChatMessages(request.system, request.messages),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    };
    const response = await fetchImpl(
      `${this.options.baseURL.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          ...this.options.headers,
        },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`${this.name}: HTTP ${response.status} ${text.slice(0, 500)}`);
    }

    let text = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    for await (const data of sseData(response.body)) {
      if (data.trim() === "[DONE]") break;
      const chunk = JSON.parse(data) as ChatChunk;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? cacheReadTokens;
      }
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          yield { type: "text_delta", text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const entry = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          calls.set(tc.index, entry);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }

    const content: AssistantContent[] = [];
    if (text) content.push({ type: "text", text });
    for (const [index, call] of [...calls].sort(([a], [b]) => a - b)) {
      content.push({
        type: "tool_call",
        id: call.id || `call_${index}`,
        name: call.name,
        input: parseArguments(call.args),
      });
    }
    yield {
      type: "done",
      message: { role: "assistant", content },
      stopReason: mapFinishReason(finish, calls.size > 0),
      // OpenAI's prompt_tokens includes cached tokens; report them separately.
      usage: {
        inputTokens: inputTokens - cacheReadTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
      },
    };
  }
}

/** Unparseable arguments are passed through as a string so schema validation reports them. */
function parseArguments(args: string): unknown {
  if (args.trim() === "") return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function mapFinishReason(reason: string | null, hasCalls: boolean): StopReason {
  switch (reason) {
    case "stop":
      return hasCalls ? "tool_use" : "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return hasCalls ? "tool_use" : "other";
  }
}

export function toChatMessages(
  system: string | undefined,
  messages: readonly Message[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const message of messages) {
    if (message.role === "user") {
      const texts: string[] = [];
      for (const block of message.content) {
        if (block.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: block.toolCallId,
            content: block.isError ? `Error: ${block.content}` : block.content,
          });
        } else {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) out.push({ role: "user", content: texts.join("\n\n") });
      continue;
    }
    const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const toolCalls = message.content.flatMap((b) =>
      b.type === "tool_call"
        ? [
            {
              id: b.id,
              type: "function" as const,
              function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
            },
          ]
        : [],
    );
    out.push({
      role: "assistant",
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return out;
}

export interface OllamaOptions {
  /** Default http://localhost:11434 (or OLLAMA_HOST). */
  host?: string;
  fetch?: typeof globalThis.fetch;
}

/** Local models via Ollama's OpenAI-compatible endpoint. */
export function ollamaProvider(options: OllamaOptions = {}): OpenAICompatibleProvider {
  const host = options.host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const base = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return new OpenAICompatibleProvider({
    baseURL: `${base.replace(/\/$/, "")}/v1`,
    name: "ollama",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
