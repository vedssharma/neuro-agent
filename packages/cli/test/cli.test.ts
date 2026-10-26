import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { VERSION } from "@neuro-agent/core";
import { ScriptedProvider, type ScriptedTurn } from "@neuro-agent/providers";
import { run, type CliIO } from "../src/index.js";

function io(script: ScriptedTurn[] = [], input = "") {
  let stdout = "";
  let stderr = "";
  const sink = (append: (s: string) => void) =>
    new Writable({
      write(chunk, _enc, cb) {
        append(String(chunk));
        cb();
      },
    });
  const stdin = new PassThrough();
  stdin.end(input);
  const provider = new ScriptedProvider(script);
  const value: CliIO = {
    stdin,
    stdout: sink((s) => (stdout += s)),
    stderr: sink((s) => (stderr += s)),
    createProvider: () => provider,
  };
  return { io: value, provider, out: () => stdout, err: () => stderr };
}

describe("cli", () => {
  it("prints the version and help", async () => {
    const a = io();
    expect(await run(["--version"], a.io)).toBe(0);
    expect(a.out()).toBe(`${VERSION}\n`);
    const b = io();
    expect(await run(["--help"], b.io)).toBe(0);
    expect(b.out()).toContain("neuro trace <file.jsonl>");
  });

  it("rejects bad options", async () => {
    const a = io();
    expect(await run(["--provider", "nope", "hi"], a.io)).toBe(2);
    expect(a.err()).toContain("Unknown provider");
    expect(await run(["--provider", "openai", "hi"], a.io)).toBe(2);
    expect(a.err()).toContain("--model is required");
    expect(await run(["--max-turns", "0", "hi"], a.io)).toBe(2);
  });

  it("compiles prompts from working memory with --working-memory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "neuro-cli-"));
    const a = io([
      { content: [{ type: "text", text: "Hello." }], usage: { inputTokens: 10, outputTokens: 2 } },
    ]);
    expect(await run(["--cwd", cwd, "--no-trace", "--working-memory", "say", "hello"], a.io)).toBe(
      0,
    );
    expect(a.provider.requests[0]?.messages[0]?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("<working-memory>"),
    });
  });

  it("remembers across sessions with --memory and inspects it with neuro memory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "neuro-cli-"));
    const reply = (text: string) => ({
      content: [{ type: "text" as const, text }],
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const a = io([reply("Noted.")]);
    const remember = [
      "--cwd",
      cwd,
      "--no-trace",
      "--memory",
      "remember:",
      "the",
      "deploy",
      "region",
      "is",
      "eu-west-2",
    ];
    expect(await run(remember, a.io)).toBe(0);

    const b = io([reply("eu-west-2")]);
    expect(
      await run(["--cwd", cwd, "--no-trace", "--memory", "What is the deploy region?"], b.io),
    ).toBe(0);
    const first = b.provider.requests[0]?.messages[0]?.content[0];
    expect(first?.type === "text" && first.text).toContain("the deploy region is eu-west-2");

    const stats = io();
    expect(await run(["memory", "stats", "-C", cwd], stats.io)).toBe(0);
    expect(stats.out()).toMatch(/facts: +1 current, 0 superseded/);
    const search = io();
    expect(await run(["memory", "search", "-C", cwd, "deploy region"], search.io)).toBe(0);
    expect(search.out()).toContain("the deploy region is eu-west-2");
    const md = io();
    expect(await run(["memory", "export", "-C", cwd], md.io)).toBe(0);
    expect(md.out()).toContain("# Memory");
    const bad = io();
    expect(await run(["memory", "nope", "-C", cwd], bad.io)).toBe(2);
  });

  it("runs a one-shot task end to end, records a trace, and summarizes it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "neuro-cli-"));
    writeFileSync(join(cwd, "notes.txt"), "the answer is 42\n");
    const a = io([
      {
        content: [{ type: "tool_call", id: "c1", name: "read_file", input: { path: "notes.txt" } }],
        usage: { inputTokens: 1000, outputTokens: 20 },
      },
      {
        content: [
          {
            type: "tool_call",
            id: "c2",
            name: "write_file",
            input: { path: "out.txt", content: "42" },
          },
        ],
        usage: { inputTokens: 1200, outputTokens: 20 },
      },
      {
        content: [{ type: "text", text: "The answer is 42." }],
        usage: { inputTokens: 1300, outputTokens: 10 },
      },
    ]);
    expect(await run(["--cwd", cwd, "--yes", "what", "is", "the", "answer?"], a.io)).toBe(0);
    expect(a.out()).toContain("→ read_file");
    expect(a.out()).toContain("The answer is 42.");
    expect(readFileSync(join(cwd, "out.txt"), "utf8")).toBe("42");
    expect(a.err()).toMatch(/tokens: 3500 in \/ 50 out · cost: \$0\.0150/);
    expect(a.provider.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
      type: "tool_result",
      content: expect.stringContaining("the answer is 42"),
    });

    const traces = readdirSync(join(cwd, ".neuro", "traces"));
    expect(traces).toHaveLength(1);
    const b = io();
    expect(await run(["trace", join(cwd, ".neuro", "traces", traces[0]!)], b.io)).toBe(0);
    expect(b.out()).toContain("runs:      1 (end_turn=1)");
    expect(b.out()).toContain(
      "calls:     3 model, 2 tool (0 errors, 0 denied) — read_file=1, write_file=1",
    );
  });

  it("denies write tools in non-interactive mode without --yes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "neuro-cli-"));
    const a = io([
      { content: [{ type: "tool_call", id: "c1", name: "shell", input: { command: "touch x" } }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    expect(await run(["--cwd", cwd, "--no-trace", "do it"], a.io)).toBe(0);
    expect(readdirSync(cwd)).toEqual([]);
    expect(a.provider.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({ isError: true });
  });

  it("offers only read tools with --read-only", async () => {
    const a = io([{ content: [{ type: "text", text: "ok" }] }]);
    await run(
      ["--cwd", mkdtempSync(join(tmpdir(), "neuro-cli-")), "--no-trace", "--read-only", "hi"],
      a.io,
    );
    expect(a.provider.requests[0]?.tools.map((t) => t.name)).toEqual([
      "read_file",
      "list_files",
      "search",
    ]);
  });

  it("runs an interactive session from stdin", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "neuro-cli-"));
    const a = io(
      [
        { content: [{ type: "text", text: "hello there" }] },
        { content: [{ type: "text", text: "second answer" }] },
      ],
      "hi\n/cost\nagain\n/exit\n",
    );
    expect(await run(["--cwd", cwd, "--no-trace"], a.io)).toBe(0);
    expect(a.out()).toContain("hello there");
    expect(a.out()).toContain("second answer");
    expect(a.provider.requests[1]?.messages).toHaveLength(3);
  });

  it("asks before running write tools in an interactive session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "neuro-cli-"));
    const a = io(
      [
        {
          content: [
            {
              type: "tool_call",
              id: "c1",
              name: "write_file",
              input: { path: "a.txt", content: "A" },
            },
          ],
        },
        {
          content: [
            {
              type: "tool_call",
              id: "c2",
              name: "write_file",
              input: { path: "b.txt", content: "B" },
            },
          ],
        },
        { content: [{ type: "text", text: "done" }] },
      ],
      "write files\ny\nn\n/exit\n",
    );
    expect(await run(["--cwd", cwd, "--no-trace"], a.io)).toBe(0);
    expect(a.out()).toContain("write_file wants to run");
    expect(readdirSync(cwd)).toEqual(["a.txt"]);
  });

  it("runs the offline benchmark and writes a report", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "neuro-eval-cli-"));
    const a = io();
    expect(
      await run(
        [
          "eval",
          "--scale",
          "small",
          "--suite",
          "recall,update",
          "--strategy",
          "sliding-window,vector-rag,working-memory",
          "--out",
          outDir,
          "--traces",
        ],
        a.io,
      ),
    ).toBe(0);
    expect(a.out()).toContain("| vector-rag |");
    const md = readFileSync(join(outDir, "simulated-small.md"), "utf8");
    expect(md).toContain("# Context strategy comparison (simulated, small)");
    const json = JSON.parse(readFileSync(join(outDir, "simulated-small.json"), "utf8"));
    expect(json.results).toHaveLength(12);

    const trace = join(outDir, "simulated-small-traces", "working-memory", "recall-1.s2.jsonl");
    const b = io();
    expect(await run(["replay", trace], b.io)).toBe(0);
    expect(b.out()).toMatch(/identical to the recording/);
  });

  it("validates eval options", async () => {
    const a = io();
    expect(await run(["eval", "--suite", "nope"], a.io)).toBe(2);
    expect(a.err()).toContain("Unknown suite");
    expect(await run(["eval", "--strategy", "nope", "--scale", "small"], a.io)).toBe(2);
    expect(a.err()).toContain("Unknown strategy");
    expect(await run(["replay"], a.io)).toBe(2);
  });
});
