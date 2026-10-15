import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  costOf,
  CostTracker,
  createEvent,
  createLogger,
  defineTool,
  JsonlTraceWriter,
  readTrace,
  toToolSpec,
} from "@neuro-agent/core";

describe("toToolSpec", () => {
  it("converts zod input to JSON Schema", () => {
    const tool = defineTool({
      name: "t",
      description: "d",
      permission: "read",
      input: z.object({ path: z.string().describe("where"), n: z.number().int().optional() }),
      execute: async () => ({ content: "" }),
    });
    expect(toToolSpec(tool)).toEqual({
      name: "t",
      description: "d",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "where" }, n: { type: "integer" } },
        required: ["path"],
        additionalProperties: false,
      },
    });
  });
});

describe("costs", () => {
  it("prices known models and ignores unknown ones", () => {
    const usage = {
      inputTokens: 1e6,
      outputTokens: 1e6,
      cacheReadTokens: 1e6,
      cacheWriteTokens: 0,
    };
    expect(costOf(usage, { input: 4, output: 20, cacheRead: 0.2 })).toBeCloseTo(24.2);
    const tracker = new CostTracker();
    expect(tracker.add("claude-opus-5-5", usage)).toBeCloseTo(24.2);
    expect(tracker.add("llama3.1", usage)).toBe(0);
    expect(tracker.usage.inputTokens).toBe(2e6);
    expect(tracker.costUsd).toBeCloseTo(24.2);
    expect(Object.keys(tracker.models())).toEqual(["claude-opus-5-5", "llama3.1"]);
  });
});

describe("JSONL traces", () => {
  it("round-trips events", () => {
    const path = join(mkdtempSync(join(tmpdir(), "neuro-")), "nested", "t.jsonl");
    const trace = new JsonlTraceWriter(path);
    const a = createEvent({ type: "message.user", sessionId: "s", payload: { text: "hi" } });
    const b = createEvent({ type: "run.end", sessionId: "s", payload: { reason: "end_turn" } });
    trace.write(a);
    trace.write(b);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readTrace(path)).toEqual([a, b]);
  });
});

describe("createLogger", () => {
  it("writes JSON lines at or above the level", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", write: (l) => lines.push(l), now: () => 0 }).child({
      s: 1,
    });
    log.debug("hidden");
    log.warn("shown", { x: 2 });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { time: "1970-01-01T00:00:00.000Z", level: "warn", msg: "shown", s: 1, x: 2 },
    ]);
  });
});
