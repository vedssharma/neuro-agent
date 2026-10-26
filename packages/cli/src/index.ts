import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import {
  Agent,
  allowAll,
  createLogger,
  FullTranscript,
  isLogLevel,
  JsonlTraceWriter,
  SlidingWindow,
  teeSinks,
  VERSION,
  type AgentEvent,
  type ApprovalHook,
  type ContextStrategy,
  type Provider,
  type RunResult,
} from "@neuro-agent/core";
import { summarizeTrace, type TraceSummary } from "@neuro-agent/eval";
import { LongTermMemory, WorkingMemory } from "@neuro-agent/memory";
import { SqliteBackend } from "@neuro-agent/store-sqlite";
import { evalCommand, replayCommand } from "./eval.js";
import { defaultMemoryPath, memoryCommand } from "./memory.js";
import {
  createProvider,
  DEFAULT_MODELS,
  PROVIDERS,
  type CreateProviderOptions,
  type ProviderName,
} from "@neuro-agent/providers";
import { builtinTools } from "@neuro-agent/tools";

export interface CliIO {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
  /** Overridable for tests. */
  createProvider?: (name: ProviderName, options: CreateProviderOptions) => Provider;
}

const defaultIO = (): CliIO => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

export const USAGE = `neuro-agent ${VERSION}

Usage:
  neuro [options]              start an interactive session
  neuro [options] <prompt>     run one request and exit
  neuro trace <file.jsonl>     summarize a recorded session trace
  neuro replay <file.jsonl>    re-run a recorded session and check it matches
  neuro eval [options]         run the benchmark suites (neuro eval --help)
  neuro memory <command>       inspect long-term memory (neuro memory --help)

Options:
  -p, --provider <name>     ${PROVIDERS.join(" | ")} (default: anthropic)
  -m, --model <id>          model id (default: ${DEFAULT_MODELS.anthropic} for anthropic)
      --base-url <url>      API base URL (OpenAI-compatible servers, Ollama host)
      --effort <level>      anthropic effort: low | medium | high | xhigh | max
  -C, --cwd <dir>           workspace root for tools (default: current directory)
      --context-tokens <n>  prompt budget in estimated tokens (default: 100000)
      --full-transcript     send the whole transcript every turn instead
      --working-memory      compile each prompt from working memory (goal, focus, recent turns)
                            instead of a sliding window
      --memory              working memory plus long-term memory that persists across sessions
      --memory-db <file>    long-term memory database (default: <cwd>/.neuro/memory.db)
      --max-turns <n>       model calls per request (default: 25)
      --max-tokens <n>      output tokens per model call (default: 16000)
  -y, --yes                 approve every write and shell call without asking
      --read-only           only offer read-only tools
      --trace-dir <dir>     where JSONL traces go (default: <cwd>/.neuro/traces)
      --no-trace            do not record a trace
      --log-level <level>   debug | info | warn | error | silent (default: warn)
  -v, --version             print the version
  -h, --help                print this help

Credentials: ANTHROPIC_API_KEY, OPENAI_API_KEY (+ OPENAI_BASE_URL), OLLAMA_HOST.`;

const SYSTEM_PROMPT = `You are neuro-agent, a careful software and research assistant working in a local workspace.
Use the tools to inspect files before changing them, keep edits minimal, and verify your work (for example by running tests) when you can.
File paths are relative to the workspace root. Write, edit and shell calls may be denied by the user; if one is, adapt or explain what you need.
When the task is done, reply with a short summary of what you did.`;

export async function run(argv: string[], io: CliIO = defaultIO()): Promise<number> {
  const out = (s: string) => io.stdout.write(s);
  const err = (s: string) => io.stderr.write(s);

  if (argv[0] === "eval") return evalCommand(argv.slice(1), io);
  if (argv[0] === "replay") return replayCommand(argv.slice(1), io);
  if (argv[0] === "memory") return memoryCommand(argv.slice(1), io);

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        provider: { type: "string", short: "p" },
        model: { type: "string", short: "m" },
        "base-url": { type: "string" },
        effort: { type: "string" },
        cwd: { type: "string", short: "C" },
        "context-tokens": { type: "string" },
        "full-transcript": { type: "boolean" },
        "working-memory": { type: "boolean" },
        memory: { type: "boolean" },
        "memory-db": { type: "string" },
        "max-turns": { type: "string" },
        "max-tokens": { type: "string" },
        yes: { type: "boolean", short: "y" },
        "read-only": { type: "boolean" },
        "trace-dir": { type: "string" },
        "no-trace": { type: "boolean" },
        "log-level": { type: "string" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`${(e as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values: opts, positionals } = parsed;

  if (opts.version) {
    out(`${VERSION}\n`);
    return 0;
  }
  if (opts.help) {
    out(`${USAGE}\n`);
    return 0;
  }
  if (positionals[0] === "trace") {
    const file = positionals[1];
    if (!file) {
      err("Usage: neuro trace <file.jsonl>\n");
      return 2;
    }
    try {
      out(formatSummary(summarizeTrace(file)));
      return 0;
    } catch (e) {
      err(`${(e as Error).message}\n`);
      return 1;
    }
  }

  const fail = (message: string) => {
    err(`${message}\n`);
    return 2;
  };
  const providerName = (opts.provider ?? "anthropic") as ProviderName;
  if (!PROVIDERS.includes(providerName)) return fail(`Unknown provider: ${opts.provider}`);
  const model = opts.model ?? DEFAULT_MODELS[providerName];
  if (!model) return fail(`--model is required for provider ${providerName}`);
  const effort = opts.effort;
  if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    return fail(`Invalid --effort: ${effort}`);
  }
  const logLevel = opts["log-level"] ?? "warn";
  if (!isLogLevel(logLevel)) return fail(`Invalid --log-level: ${logLevel}`);
  const int = (name: string, value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
    return n;
  };
  let contextTokens: number, maxTurns: number, maxTokens: number;
  try {
    contextTokens = int("context-tokens", opts["context-tokens"], 100_000);
    maxTurns = int("max-turns", opts["max-turns"], 25);
    maxTokens = int("max-tokens", opts["max-tokens"], 16_000);
  } catch (e) {
    return fail((e as Error).message);
  }

  const cwd = resolve(opts.cwd ?? process.cwd());
  const logger = createLogger({ level: logLevel, write: (line) => err(line + "\n") });
  const providerOptions: CreateProviderOptions = {
    ...(opts["base-url"] !== undefined ? { baseURL: opts["base-url"] } : {}),
    ...(effort !== undefined
      ? { effort: effort as NonNullable<CreateProviderOptions["effort"]> }
      : {}),
  };
  const provider = (io.createProvider ?? createProvider)(providerName, providerOptions);
  const memoryBackend =
    opts.memory || opts["memory-db"]
      ? new SqliteBackend({ path: resolve(cwd, opts["memory-db"] ?? defaultMemoryPath(cwd)) })
      : undefined;
  const context: ContextStrategy = opts["full-transcript"]
    ? new FullTranscript()
    : memoryBackend
      ? new WorkingMemory({
          budgetTokens: contextTokens,
          longTerm: new LongTermMemory({ backend: memoryBackend }),
        })
      : opts["working-memory"]
        ? new WorkingMemory({ budgetTokens: contextTokens })
        : new SlidingWindow(contextTokens);
  const tools = builtinTools().filter((t) => !opts["read-only"] || t.permission === "read");

  const prompt = positionals.join(" ").trim();
  const interactive = prompt === "";
  const lines: LineReader | undefined =
    interactive || (!opts.yes && io.stdout.isTTY)
      ? new LineReader(
          createInterface({
            input: io.stdin,
            output: io.stdout,
            terminal: io.stdout.isTTY ?? false,
          }),
        )
      : undefined;

  const sessionId = globalThis.crypto.randomUUID();
  const trace = opts["no-trace"]
    ? undefined
    : new JsonlTraceWriter(
        join(
          resolve(cwd, opts["trace-dir"] ?? ".neuro/traces"),
          `${timestamp()}-${sessionId.slice(0, 8)}.jsonl`,
        ),
      );

  const approve: ApprovalHook = opts.yes
    ? allowAll
    : lines
      ? interactiveApproval(lines, out)
      : () => false;

  let lineOpen = false;
  const agent = new Agent({
    provider,
    model,
    tools,
    system: SYSTEM_PROMPT,
    context,
    maxTurns,
    maxTokens,
    approve,
    cwd,
    sessionId,
    onEvent: teeSinks(trace?.write, logEvents(logger), (e) => {
      if (e.type === "tool.call") {
        if (lineOpen) out("\n");
        lineOpen = false;
        out(`  → ${String(e.payload.name)} ${preview(e.payload.input)}\n`);
      } else if (e.type === "tool.result" && e.payload.isError) {
        out(`  ✗ ${preview(e.payload.content)}\n`);
      }
    }),
    onText: (delta) => {
      lineOpen = !delta.endsWith("\n");
      out(delta);
    },
    onRestart: () => out("\n[retrying]\n"),
  });

  if (trace) logger.info("trace", { path: trace.path });

  const runOnce = async (text: string, signal: AbortSignal): Promise<RunResult> => {
    const result = await agent.send(text, { signal });
    if (lineOpen) out("\n");
    lineOpen = false;
    if (result.reason !== "end_turn") {
      out(`[stopped: ${result.reason}${result.error ? ` — ${result.error.message}` : ""}]\n`);
    }
    return result;
  };

  try {
    if (!interactive) {
      const controller = new AbortController();
      const onSigint = () => controller.abort();
      process.once("SIGINT", onSigint);
      try {
        const result = await runOnce(prompt, controller.signal);
        err(`${formatCost(agent)}\n`);
        if (trace) err(`trace: ${trace.path}\n`);
        return result.reason === "end_turn" ? 0 : 1;
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
    }

    out(`neuro-agent ${VERSION} · ${provider.name}/${model} · ${context.name} · ${cwd}\n`);
    out(`Type a request, /cost for usage, /exit to quit. Ctrl-C cancels a running request.\n`);
    let current: AbortController | undefined;
    lines!.rl.on("SIGINT", () => {
      if (current) current.abort();
      else lines!.rl.close();
    });
    for (;;) {
      out("\n› ");
      const raw = await lines!.next();
      if (raw === undefined) break; // input closed
      const line = raw.trim();
      if (line === "") continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/cost") {
        out(`${formatCost(agent)}\n`);
        continue;
      }
      current = new AbortController();
      await runOnce(line, current.signal);
      current = undefined;
    }
    out(`${formatCost(agent)}\n`);
    if (trace) out(`trace: ${trace.path}\n`);
    return 0;
  } finally {
    lines?.rl.close();
    await memoryBackend?.close();
  }
}

/** Queues input lines so none are lost between prompts (e.g. when stdin is piped). */
class LineReader {
  private readonly queue: string[] = [];
  private waiting: ((line: string | undefined) => void) | undefined;
  private closed = false;

  constructor(readonly rl: Interface) {
    rl.on("line", (line) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve(line);
      } else this.queue.push(line);
    });
    rl.on("close", () => {
      this.closed = true;
      this.waiting?.(undefined);
      this.waiting = undefined;
    });
  }

  next(): Promise<string | undefined> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => (this.waiting = resolve));
  }
}

function interactiveApproval(lines: LineReader, out: (s: string) => void): ApprovalHook {
  const always = new Set<string>();
  return async ({ tool, input }) => {
    if (always.has(tool.name)) return true;
    out(`\n  ${tool.name} wants to run: ${preview(input, 400)}\n`);
    out("  Allow? [y]es / [n]o / [a]lways for this tool: ");
    const answer = ((await lines.next()) ?? "").trim().toLowerCase();
    if (answer === "a" || answer === "always") {
      always.add(tool.name);
      return true;
    }
    return answer === "y" || answer === "yes";
  };
}

function logEvents(logger: ReturnType<typeof createLogger>) {
  return (event: AgentEvent) => {
    const { type, payload } = event;
    if (type === "message.assistant") {
      logger.debug(type, {
        stopReason: payload.stopReason,
        usage: payload.usage,
        costUsd: payload.costUsd,
      });
    } else if (type === "tool.result" || type === "tool.denied") {
      logger.info(type, {
        name: payload.name,
        isError: payload.isError,
        durationMs: payload.durationMs,
      });
    } else if (type === "run.end" && payload.reason === "error") {
      logger.error(type, payload);
    } else {
      logger.debug(type, payload);
    }
  };
}

function preview(value: unknown, max = 120): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = (text ?? "").replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function formatCost(agent: Agent): string {
  const u = agent.costs.usage;
  return `tokens: ${u.inputTokens} in / ${u.outputTokens} out${u.cacheReadTokens ? ` / ${u.cacheReadTokens} cached` : ""} · cost: $${agent.costs.costUsd.toFixed(4)}`;
}

export function formatSummary(s: TraceSummary): string {
  const reasons = Object.entries(s.runEndReasons)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const tools = Object.entries(s.toolsByName)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return [
    `session:   ${s.sessionId}`,
    `model:     ${s.provider ?? "?"}/${s.model ?? "?"} (${s.contextStrategy ?? "?"})`,
    `runs:      ${s.runs}${reasons ? ` (${reasons})` : ""}`,
    `calls:     ${s.modelCalls} model, ${s.toolCalls} tool (${s.toolErrors} errors, ${s.toolDenials} denied)${tools ? ` — ${tools}` : ""}`,
    `context:   up to ${s.maxDroppedMessages} messages dropped`,
    `tokens:    ${s.usage.inputTokens} in / ${s.usage.outputTokens} out / ${s.usage.cacheReadTokens} cache read`,
    `cost:      $${s.costUsd.toFixed(4)}`,
    `wall time: ${(s.wallClockMs / 1000).toFixed(1)}s`,
    "",
  ].join("\n");
}
