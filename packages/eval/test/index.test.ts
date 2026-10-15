import { describe, expect, it } from "vitest";
import { Agent, allowAll, defineTool, type AgentEvent } from "@neuro-agent/core";
import { ScriptedProvider } from "@neuro-agent/providers";
import { summarizeEvents } from "@neuro-agent/eval";
import { z } from "zod";

describe("summarizeEvents", () => {
  it("computes baseline metrics from a recorded run", async () => {
    const events: AgentEvent[] = [];
    let t = 1_000;
    const echo = defineTool({
      name: "echo",
      description: "echo",
      permission: "write",
      input: z.object({ text: z.string() }),
      execute: async ({ text }) => ({ content: text }),
    });
    const agent = new Agent({
      provider: new ScriptedProvider([
        {
          content: [{ type: "tool_call", id: "1", name: "echo", input: { text: "hi" } }],
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
        },
        {
          content: [{ type: "text", text: "done" }],
          usage: { inputTokens: 0, outputTokens: 1_000_000 },
        },
      ]),
      model: "claude-opus-5-5",
      tools: [echo],
      approve: allowAll,
      onEvent: (e) => events.push(e),
      now: () => (t += 10),
    });
    await agent.send("go");

    const s = summarizeEvents(events);
    expect(s).toMatchObject({
      provider: "scripted",
      model: "claude-opus-5-5",
      contextStrategy: "sliding-window",
      runs: 1,
      runEndReasons: { end_turn: 1 },
      modelCalls: 2,
      toolCalls: 1,
      toolErrors: 0,
      toolsByName: { echo: 1 },
    });
    expect(s.usage.inputTokens).toBe(1_000_000);
    expect(s.costUsd).toBeCloseTo(24);
    expect(s.wallClockMs).toBeGreaterThan(0);
  });
});
