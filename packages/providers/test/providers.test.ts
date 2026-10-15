import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { complete, type Message, type ModelRequest, type StreamEvent } from "@neuro-agent/core";
import {
  AnthropicProvider,
  ollamaProvider,
  OpenAICompatibleProvider,
  ScriptedProvider,
  sseData,
  toAnthropicMessages,
  toChatMessages,
} from "@neuro-agent/providers";

const sse = (events: [string | null, unknown][]) =>
  events
    .map(
      ([name, data]) =>
        `${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
    )
    .join("");

function fakeFetch(
  body: string,
  capture: { url?: string; body?: unknown; headers?: Headers }[] = [],
) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // Split mid-event to exercise buffering.
        c.enqueue(bytes.slice(0, 37));
        c.enqueue(bytes.slice(37));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "claude-opus-5-5",
  system: "sys",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }],
  maxTokens: 1000,
  ...overrides,
});

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("sseData", () => {
  it("joins multi-line data and handles CRLF", async () => {
    const body = new Response("data: a\r\ndata: b\r\n\r\n: comment\n\ndata: c").body!;
    const out: string[] = [];
    for await (const d of sseData(body)) out.push(d);
    expect(out).toEqual(["a\nb", "c"]);
  });
});

describe("AnthropicProvider", () => {
  const anthropicStream = sse([
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 50,
            output_tokens: 1,
            cache_read_input_tokens: 7,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "content_block_start",
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me " } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "check." } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_1", name: "echo", input: {} },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"text":' },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '"hi"}' },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 2 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 30 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);

  it("streams text and normalizes tool calls, usage and opaque blocks", async () => {
    const captured: { url?: string; body?: unknown; headers?: Headers }[] = [];
    const client = new Anthropic({
      apiKey: "test",
      fetch: fakeFetch(anthropicStream, captured),
      maxRetries: 0,
    });
    const events = await collect(
      new AnthropicProvider({ client, effort: "high" }).stream(request()),
    );

    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e.type === "text_delta" ? e.text : "")),
    ).toEqual(["Let me ", "check."]);
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: "done",
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 30, cacheReadTokens: 7, cacheWriteTokens: 0 },
    });
    expect(done?.type === "done" && done.message.content).toEqual([
      {
        type: "opaque",
        provider: "anthropic",
        data: { type: "thinking", thinking: "", signature: "sig" },
      },
      { type: "text", text: "Let me check." },
      { type: "tool_call", id: "toolu_1", name: "echo", input: { text: "hi" } },
    ]);

    const body = captured[0]?.body as Record<string, unknown>;
    expect(captured[0]?.url).toMatch(/\/v1\/messages/);
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 1000,
      system: "sys",
      stream: true,
      output_config: { effort: "high" },
      fallbacks: "default",
      tools: [{ name: "echo", eager_input_streaming: true }],
    });
    expect(captured[0]?.headers?.get("anthropic-beta")).toContain(
      "server-side-fallback-2026-07-01",
    );
  });

  it("omits refusal fallbacks for models without them", async () => {
    const captured: { body?: unknown; headers?: Headers }[] = [];
    const client = new Anthropic({
      apiKey: "test",
      fetch: fakeFetch(anthropicStream, captured),
      maxRetries: 0,
    });
    await complete(new AnthropicProvider({ client }), request({ model: "claude-haiku-5-5" }));
    expect(captured[0]?.body).not.toHaveProperty("fallbacks");
    expect(captured[0]?.headers?.get("anthropic-beta")).toBeNull();
  });

  it("maps the neutral transcript, stripping thinking only when history was truncated", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [
          {
            type: "opaque",
            provider: "anthropic",
            data: { type: "thinking", thinking: "", signature: "s" },
          },
          { type: "opaque", provider: "openai", data: { whatever: 1 } },
          { type: "tool_call", id: "t1", name: "echo", input: { text: "x" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "t1", content: "x", isError: false }],
      },
    ];
    expect(toAnthropicMessages(messages, false)).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "s" },
          { type: "tool_use", id: "t1", name: "echo", input: { text: "x" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "x", is_error: false }],
      },
    ]);
    expect(toAnthropicMessages(messages, true)[1]?.content).toEqual([
      { type: "tool_use", id: "t1", name: "echo", input: { text: "x" } },
    ]);
  });
});

describe("OpenAICompatibleProvider", () => {
  const chunk = (delta: unknown, finish: string | null = null) => ({
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const body = sse([
    [null, chunk({ role: "assistant", content: "Sure" })],
    [
      null,
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_a",
            type: "function",
            function: { name: "echo", arguments: '{"te' },
          },
        ],
      }),
    ],
    [null, chunk({ tool_calls: [{ index: 0, function: { arguments: 'xt":"hi"}' } }] })],
    [
      null,
      chunk({
        tool_calls: [
          {
            index: 1,
            id: "call_b",
            type: "function",
            function: { name: "echo", arguments: "not json" },
          },
        ],
      }),
    ],
    [null, chunk({}, "tool_calls")],
    [
      null,
      {
        choices: [],
        usage: {
          prompt_tokens: 40,
          completion_tokens: 9,
          prompt_tokens_details: { cached_tokens: 10 },
        },
      },
    ],
    [null, "[DONE]"],
  ]);

  it("accumulates streamed tool calls and usage", async () => {
    const captured: { url?: string; body?: unknown; headers?: Headers }[] = [];
    const provider = new OpenAICompatibleProvider({
      baseURL: "https://x.test/v1/",
      apiKey: "k",
      fetch: fakeFetch(body, captured),
    });
    const events = await collect(provider.stream(request({ model: "m" })));
    expect(events[0]).toEqual({ type: "text_delta", text: "Sure" });
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "tool_use",
      usage: { inputTokens: 30, outputTokens: 9, cacheReadTokens: 10, cacheWriteTokens: 0 },
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Sure" },
          { type: "tool_call", id: "call_a", name: "echo", input: { text: "hi" } },
          { type: "tool_call", id: "call_b", name: "echo", input: "not json" },
        ],
      },
    });
    expect(captured[0]?.url).toBe("https://x.test/v1/chat/completions");
    expect(captured[0]?.headers?.get("authorization")).toBe("Bearer k");
    expect(captured[0]?.body).toMatchObject({
      model: "m",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
    });
  });

  it("throws on HTTP errors", async () => {
    const provider = new OpenAICompatibleProvider({
      baseURL: "https://x.test/v1",
      fetch: (async () => new Response("nope", { status: 401 })) as typeof fetch,
    });
    await expect(complete(provider, request())).rejects.toThrow(/HTTP 401 nope/);
  });

  it("maps tool results to tool messages and drops opaque blocks", () => {
    expect(
      toChatMessages(undefined, [
        { role: "user", content: [{ type: "text", text: "q" }] },
        {
          role: "assistant",
          content: [
            { type: "opaque", provider: "anthropic", data: {} },
            { type: "tool_call", id: "c", name: "echo", input: { a: 1 } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolCallId: "c", content: "bad", isError: true },
            { type: "text", text: "next" },
          ],
        },
      ]),
    ).toEqual([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c", type: "function", function: { name: "echo", arguments: '{"a":1}' } },
        ],
      },
      { role: "tool", tool_call_id: "c", content: "Error: bad" },
      { role: "user", content: "next" },
    ]);
  });

  it("points ollama at its OpenAI-compatible endpoint", async () => {
    const captured: { url?: string }[] = [];
    const provider = ollamaProvider({
      host: "127.0.0.1:11434",
      fetch: fakeFetch(sse([[null, "[DONE]"]]), captured),
    });
    expect(provider.name).toBe("ollama");
    await complete(provider, request());
    expect(captured[0]?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });
});

describe("ScriptedProvider", () => {
  it("records requests and honours abort", async () => {
    const p = new ScriptedProvider([{ content: [{ type: "text", text: "a" }] }]);
    const controller = new AbortController();
    controller.abort();
    await expect(complete(p, request({ signal: controller.signal }))).rejects.toThrow();
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]).not.toHaveProperty("signal");
  });
});
