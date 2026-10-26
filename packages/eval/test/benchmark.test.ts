import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Agent,
  complete,
  defineTool,
  readTrace,
  type AgentEvent,
  type ModelRequest,
} from "@neuro-agent/core";
import {
  aggregate,
  ContextLimitError,
  firstDivergence,
  generateTasks,
  gradeProbe,
  offlineBaselines,
  offlineStrategies,
  renderMarkdown,
  replaySession,
  runBenchmark,
  SCALES,
  SimulatedReader,
  SUITES,
  visibleFacts,
} from "@neuro-agent/eval";
import { ScriptedProvider } from "@neuro-agent/providers";
import { readFileTool } from "@neuro-agent/tools";
import { z } from "zod";

const req = (texts: string[], overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "simulated",
  messages: texts.map((text, i) =>
    i % 2 === 0
      ? { role: "user", content: [{ type: "text", text }] }
      : { role: "assistant", content: [{ type: "text", text }] },
  ),
  tools: [],
  maxTokens: 100,
  ...overrides,
});
const answer = async (r: ModelRequest) => {
  const done = await complete(new SimulatedReader(), r);
  return done.message.content;
};

describe("SimulatedReader", () => {
  it("finds facts, latest statement wins", () => {
    const f = visibleFacts(
      "The room is A. Later: the room is now B; the code for locker 2 is 11, and the code for locker 2 annex is 12.",
    );
    expect(f.get("room")).toBe("B");
    expect(f.get("code for locker 2")).toBe("11");
    expect(f.get("code for locker 2 annex")).toBe("12");
  });

  it("answers only from what is in the request", async () => {
    expect(
      await answer(
        req([
          "The deploy region for the api is eu-west-2.",
          "Noted.",
          "What is the deploy region for the api?",
        ]),
      ),
    ).toEqual([{ type: "text", text: "The deploy region for the api is eu-west-2." }]);
    expect(await answer(req(["What is the deploy region for the api?"]))).toEqual([
      { type: "text", text: "I don't know the deploy region for the api." },
    ]);
    expect(await answer(req(["Just some notes."]))).toEqual([{ type: "text", text: "Noted." }]);
  });

  it("reads files it cannot see a value for, then totals", async () => {
    const tools = [{ name: "read_file", description: "", inputSchema: {} }];
    const first = await answer(
      req(["Compute the total of the values of a.txt, b.txt."], { tools }),
    );
    expect(first).toEqual([
      { type: "tool_call", id: expect.any(String), name: "read_file", input: { path: "a.txt" } },
    ]);
    const done = await answer(
      req(
        [
          "The value of a.txt is 3. The value of b.txt is 4.",
          "Noted.",
          "Compute the total of the values of a.txt and b.txt.",
        ],
        { tools },
      ),
    );
    expect(done).toEqual([{ type: "text", text: "The total is 7." }]);
  });

  it("enforces a context limit and reports estimated usage", async () => {
    await expect(
      complete(new SimulatedReader({ contextLimit: 10 }), req(["x".repeat(400)])),
    ).rejects.toThrow(ContextLimitError);
    const done = await complete(new SimulatedReader(), req(["hello"]));
    expect(done.usage.inputTokens).toBeGreaterThan(0);
    expect(done.usage.outputTokens).toBeGreaterThan(0);
  });
});

describe("tasks", () => {
  it("are deterministic per seed and cover every suite", () => {
    const a = generateTasks({ seed: 7, scale: SCALES.small });
    expect(generateTasks({ seed: 7, scale: SCALES.small })).toEqual(a);
    expect(generateTasks({ seed: 8, scale: SCALES.small })).not.toEqual(a);
    expect(new Set(a.map((t) => t.suite))).toEqual(new Set(SUITES));
    for (const t of a) expect(t.sessions.flat().some((turn) => turn.probe)).toBe(true);
  });

  it("filler never states a fact", () => {
    const tasks = generateTasks({ seed: 3, scale: SCALES.small, suites: ["recall"] });
    const fillerTurns = tasks
      .flatMap((t) => t.sessions.flat())
      .filter((t) => t.user.startsWith("Some background notes"));
    expect(fillerTurns.length).toBeGreaterThan(0);
    for (const t of fillerTurns) expect(visibleFacts(t.user).size).toBe(0);
  });
});

describe("grading", () => {
  it("marks superseded answers as stale", () => {
    const probe = { answer: "B", stale: ["A"], retrievable: true };
    expect(gradeProbe("The room is b.", probe)).toEqual({ correct: true, stale: false });
    expect(gradeProbe("The room is A.", probe)).toEqual({ correct: false, stale: true });
    expect(gradeProbe("I don't know.", probe)).toEqual({ correct: false, stale: false });
  });
});

describe("runBenchmark", () => {
  it("produces comparable, deterministic baseline results", async () => {
    const tasks = generateTasks({ seed: 1, scale: SCALES.small });
    const run = () =>
      runBenchmark({
        tasks,
        strategies: offlineBaselines(),
        provider: () => new SimulatedReader(),
        model: "simulated",
      });
    const results = await run();
    expect(results).toHaveLength(tasks.length * 4);

    const overall = Object.fromEntries(
      aggregate(results)
        .filter((a) => a.suite === "all")
        .map((a) => [a.strategy, a]),
    );
    // Only the vector store carries facts into a new session.
    expect(overall["vector-rag"]!.accuracy).toBeGreaterThan(overall["sliding-window"]!.accuracy);
    expect(overall["vector-rag"]!.recallAtK).toBeDefined();
    expect(overall["sliding-window"]!.recallAtK).toBeUndefined();
    expect(results.every((r) => r.usage.inputTokens > 0)).toBe(true);

    const strip = (rs: typeof results) => rs.map(({ wallClockMs: _w, ...r }) => r);
    expect(strip(await run())).toEqual(strip(results));

    const md = renderMarkdown(results, {
      title: "T",
      provider: "simulated",
      model: "simulated",
      seed: 1,
      scale: "small",
      windowTokens: 4000,
      date: "2026-10-15",
    });
    expect(md).toContain("| vector-rag |");
    expect(md).toContain("## Accuracy by suite");
    expect(md).toContain("## Same session vs. a new session");
  });

  it("fails long tasks that exceed the model's context window", async () => {
    const tasks = generateTasks({
      seed: 1,
      scale: { ...SCALES.small, tasksPerSuite: 1, files: 6, fileTokens: 400 },
      suites: ["long-horizon"],
    });
    const [full] = await runBenchmark({
      tasks,
      strategies: offlineBaselines(1000).slice(0, 1),
      provider: () => new SimulatedReader({ contextLimit: 1500 }),
      model: "simulated",
    });
    expect(full!.probes[0]!.correct).toBe(false);
    expect(full!.errors[0]).toMatch(/context window/);
  });

  it("working memory solves long-horizon tasks the baselines can't, with fewer tokens", async () => {
    const tasks = generateTasks({
      seed: 1,
      scale: { ...SCALES.standard, tasksPerSuite: 1 },
      suites: ["long-horizon"],
    });
    const results = await runBenchmark({
      tasks,
      strategies: offlineStrategies().filter((s) =>
        ["sliding-window", "summary-buffer", "working-memory", "wm-no-chunking"].includes(s.name),
      ),
      provider: () => new SimulatedReader(),
      model: "simulated",
    });
    const by = Object.fromEntries(results.map((r) => [r.strategy, r]));
    const tokens = (name: string) => by[name]!.usage.inputTokens + by[name]!.usage.outputTokens;
    expect(by["working-memory"]!.probes[0]!.correct).toBe(true);
    expect(by["working-memory"]!.errors).toEqual([]);
    for (const baseline of ["sliding-window", "summary-buffer", "wm-no-chunking"]) {
      expect(by[baseline]!.probes[0]!.correct).toBe(false);
      expect(tokens("working-memory")).toBeLessThan(tokens(baseline));
    }
  });

  it("long-term memory beats vector RAG on dense cross-session interference", async () => {
    const tasks = generateTasks({
      seed: 1,
      scale: { ...SCALES.standard, tasksPerSuite: 2 },
      suites: ["dense-interference", "multi-session"],
    });
    const results = await runBenchmark({
      tasks,
      strategies: offlineStrategies().filter((s) =>
        ["vector-rag", "long-term-memory", "ltm-episodes-only"].includes(s.name),
      ),
      provider: () => new SimulatedReader(),
      model: "simulated",
    });
    const accuracy = Object.fromEntries(
      aggregate(results)
        .filter((a) => a.suite === "dense-interference")
        .map((a) => [a.strategy, a.accuracy]),
    );
    expect(accuracy["long-term-memory"]).toBe(1);
    expect(accuracy["vector-rag"]).toBeLessThan(1);
    expect(accuracy["ltm-episodes-only"]).toBeLessThan(1);
    const multi = results.filter(
      (r) => r.suite === "multi-session" && r.strategy === "long-term-memory",
    );
    expect(multi.flatMap((r) => r.probes).every((p) => p.correct)).toBe(true);
  });

  it("writes replayable traces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "neuro-eval-test-"));
    const tasks = generateTasks({ seed: 2, scale: SCALES.small, suites: ["long-horizon"] }).slice(
      0,
      1,
    );
    await runBenchmark({
      tasks,
      strategies: offlineBaselines().slice(1, 2),
      provider: () => new SimulatedReader(),
      model: "simulated",
      traceDir: dir,
    });
    const events = readTrace(join(dir, "sliding-window", "long-horizon-1.s1.jsonl"));
    expect(events.filter((e) => e.type === "tool.call").length).toBe(SCALES.small.files);
    const replay = await replaySession(events);
    expect(replay.divergence).toBe(-1);
  });
});

describe("replay", () => {
  it("reproduces a session with recorded model turns and tool results", async () => {
    const events: AgentEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "neuro-replay-"));
    const write = defineTool({
      name: "touch",
      description: "",
      permission: "write",
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => ({ content: `touched ${n}` }),
    });
    const agent = new Agent({
      provider: new ScriptedProvider([
        { content: [{ type: "tool_call", id: "a", name: "touch", input: { n: 1 } }] },
        { content: [{ type: "tool_call", id: "b", name: "touch", input: { n: 2 } }] },
        { content: [{ type: "text", text: "done" }] },
        {
          content: [{ type: "tool_call", id: "c", name: "read_file", input: { path: "missing" } }],
        },
        { content: [{ type: "text", text: "bye" }] },
      ]),
      model: "m",
      tools: [write, readFileTool],
      approve: ({ id }) => id !== "b",
      cwd,
      onEvent: (e) => events.push(e),
    });
    await agent.send("go");
    await agent.send("again");

    const replay = await replaySession(events);
    expect(replay.divergence).toBe(-1);
    expect(replay.events.map((e) => e.type)).toEqual(events.map((e) => e.type));

    const tampered = events.map((e) =>
      e.type === "tool.result" ? { ...e, payload: { ...e.payload, content: "changed" } } : e,
    );
    expect(firstDivergence(events, tampered)).toBe(
      events.findIndex((e) => e.type === "tool.result"),
    );
  });

  it("rejects traces from another format version", async () => {
    const start = {
      id: "1",
      type: "session.start",
      timestamp: 0,
      sessionId: "s",
      payload: { traceVersion: 99, tools: [], model: "m", cwd: "/" },
    };
    await expect(replaySession([start])).rejects.toThrow(/trace version/);
  });
});
