import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  allowAll,
  defineTool,
  SlidingWindow,
  type AgentEvent,
  type AgentOptions,
} from "@neuro-agent/core";
import { ScriptedProvider, type ScriptedTurn } from "@neuro-agent/providers";

const calls: string[] = [];
const echo = defineTool({
  name: "echo",
  description: "Echo text back",
  permission: "read",
  input: z.object({ text: z.string() }),
  execute: async ({ text }) => {
    calls.push(text);
    return { content: `echo: ${text}` };
  },
});
const write = defineTool({
  name: "write",
  description: "Pretend to write",
  permission: "write",
  input: z.object({ path: z.string() }),
  execute: async ({ path }) => ({ content: `wrote ${path}` }),
});
const boom = defineTool({
  name: "boom",
  description: "Throws",
  permission: "read",
  input: z.object({}),
  execute: async () => {
    throw new Error("kaboom");
  },
});

const toolCall = (id: string, name: string, input: unknown): ScriptedTurn => ({
  content: [{ type: "tool_call", id, name, input }],
  usage: { inputTokens: 100, outputTokens: 10 },
});
const say = (text: string): ScriptedTurn => ({
  content: [{ type: "text", text }],
  usage: { inputTokens: 100, outputTokens: 10 },
});

function setup(script: ScriptedTurn[], options: Partial<AgentOptions> = {}) {
  const provider = new ScriptedProvider(script);
  const events: AgentEvent[] = [];
  let text = "";
  const agent = new Agent({
    provider,
    model: "claude-opus-5-5",
    tools: [echo, write, boom],
    system: "sys",
    onEvent: (e) => events.push(e),
    onText: (d) => (text += d),
    ...options,
  });
  return { agent, provider, events, streamed: () => text };
}

describe("Agent", () => {
  it("runs perceive → think → act → observe until the model stops calling tools", async () => {
    const { agent, provider, events, streamed } = setup([
      toolCall("c1", "echo", { text: "hi" }),
      say("All done."),
    ]);
    const result = await agent.send("say hi");

    expect(result).toMatchObject({ reason: "end_turn", text: "All done.", turns: 2 });
    expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 20 });
    expect(result.costUsd).toBeCloseTo((200 * 4 + 20 * 20) / 1e6);
    expect(streamed()).toBe("All done.");
    expect(events.map((e) => e.type)).toEqual([
      "session.start",
      "message.user",
      "model.request",
      "message.assistant",
      "tool.call",
      "tool.result",
      "model.request",
      "message.assistant",
      "run.end",
    ]);
    // The second request carries the tool result back to the model.
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolCallId: "c1", content: "echo: hi", isError: false }],
    });
    expect(provider.requests[0]?.tools.map((t) => t.name)).toEqual(["echo", "write", "boom"]);
    expect(provider.requests[0]?.system).toBe("sys");
  });

  it("denies write tools without an approval hook", async () => {
    const { agent, provider, events } = setup([toolCall("c1", "write", { path: "a" }), say("ok")]);
    await agent.send("write");
    expect(events.some((e) => e.type === "tool.denied")).toBe(true);
    const r = provider.requests[1]?.messages.at(-1)?.content[0];
    expect(r).toMatchObject({ type: "tool_result", isError: true });
  });

  it("runs write tools when approved and passes parsed input to the hook", async () => {
    const seen: unknown[] = [];
    const { agent, provider } = setup([toolCall("c1", "write", { path: "a" }), say("ok")], {
      approve: ({ input }) => {
        seen.push(input);
        return true;
      },
    });
    await agent.send("write");
    expect(seen).toEqual([{ path: "a" }]);
    expect(provider.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
      content: "wrote a",
      isError: false,
    });
  });

  it("reports invalid input, unknown tools and thrown errors back to the model", async () => {
    const { agent, provider } = setup([
      {
        content: [
          { type: "tool_call", id: "a", name: "echo", input: { text: 5 } },
          { type: "tool_call", id: "b", name: "nope", input: {} },
          { type: "tool_call", id: "c", name: "boom", input: {} },
        ],
      },
      say("ok"),
    ]);
    await agent.send("go");
    const results = provider.requests[1]?.messages.at(-1)?.content ?? [];
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.type === "tool_result" && r.isError)).toBe(true);
    expect(results.map((r) => (r.type === "tool_result" ? r.content : ""))).toEqual([
      expect.stringContaining("Invalid input for echo"),
      "Unknown tool: nope",
      "boom failed: kaboom",
    ]);
  });

  it("stops at maxTurns", async () => {
    const { agent } = setup(
      Array.from({ length: 5 }, (_, i) => toolCall(`c${i}`, "echo", { text: String(i) })),
      { maxTurns: 3 },
    );
    expect(await agent.send("loop")).toMatchObject({ reason: "max_turns", turns: 3 });
  });

  it("does not run tool calls cut off by max_tokens, and keeps the transcript valid", async () => {
    calls.length = 0;
    const { agent } = setup([
      { ...toolCall("c1", "echo", { text: "x" }), stopReason: "max_tokens" },
    ]);
    expect((await agent.send("go")).reason).toBe("max_tokens");
    expect(calls).toEqual([]);
    expect(agent.transcript.at(-1)?.content[0]).toMatchObject({
      type: "tool_result",
      toolCallId: "c1",
      isError: true,
    });
  });

  it("stops on refusal", async () => {
    const { agent } = setup([{ content: [], stopReason: "refusal" }]);
    expect((await agent.send("go")).reason).toBe("refusal");
  });

  it("merges a new request into a trailing tool-result message", async () => {
    const { agent } = setup([
      { ...toolCall("c1", "echo", { text: "x" }), stopReason: "max_tokens" },
      say("ok"),
    ]);
    await agent.send("first");
    await agent.send("second");
    const roles = agent.transcript.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    expect(agent.transcript[2]?.content.map((b) => b.type)).toEqual(["tool_result", "text"]);
  });

  it("cancels between steps and answers pending tool calls", async () => {
    const controller = new AbortController();
    const slow = defineTool({
      name: "slow",
      description: "aborts the run",
      permission: "read",
      input: z.object({}),
      execute: async () => {
        controller.abort();
        return { content: "done" };
      },
    });
    const { agent } = setup(
      [
        {
          content: [
            { type: "tool_call", id: "a", name: "slow", input: {} },
            { type: "tool_call", id: "b", name: "echo", input: { text: "never" } },
          ],
        },
      ],
      { tools: [slow, echo] },
    );
    const result = await agent.send("go", { signal: controller.signal });
    expect(result.reason).toBe("cancelled");
    expect(agent.transcript.at(-1)?.content).toEqual([
      { type: "tool_result", toolCallId: "a", content: "done", isError: false },
      { type: "tool_result", toolCallId: "b", content: "Cancelled.", isError: true },
    ]);
  });

  it("returns cancelled when aborted before the first call", async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent } = setup([say("never")]);
    expect((await agent.send("go", { signal: controller.signal })).reason).toBe("cancelled");
  });

  it("reports provider errors as an error result", async () => {
    const { agent, events } = setup([]);
    const result = await agent.send("go");
    expect(result.reason).toBe("error");
    expect(result.error?.message).toMatch(/no scripted turn/);
    expect(events.at(-1)?.payload).toMatchObject({ reason: "error" });
  });

  it("truncates long tool output", async () => {
    const { agent, provider } = setup(
      [toolCall("c1", "echo", { text: "y".repeat(100) }), say("ok")],
      {
        maxToolOutputChars: 20,
      },
    );
    await agent.send("go");
    const r = provider.requests[1]?.messages.at(-1)?.content[0];
    expect(r?.type === "tool_result" && r.content).toMatch(
      /^echo: y{14}\n\[truncated 86 characters\]$/,
    );
  });

  it("applies the context strategy and flags truncated history", async () => {
    const big = "z".repeat(2000);
    const { agent, provider, events } = setup([say(big), say("ok")], {
      context: new SlidingWindow(300),
    });
    await agent.send("first");
    await agent.send("second");
    expect(provider.requests[1]?.messages).toHaveLength(1);
    expect(provider.requests[1]?.historyTruncated).toBe(true);
    const req = events.filter((e) => e.type === "model.request").at(-1);
    expect(req?.payload).toMatchObject({ droppedMessages: 2 });
  });

  it("allows everything with allowAll", async () => {
    const { agent } = setup([toolCall("c1", "write", { path: "p" }), say("ok")], {
      approve: allowAll,
    });
    const result = await agent.send("go");
    expect(result.reason).toBe("end_turn");
  });

  it("rejects duplicate tool names", () => {
    expect(() => setup([], { tools: [echo, echo] })).toThrow(/duplicate tool/);
  });
});
