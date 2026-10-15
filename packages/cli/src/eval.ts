import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readTrace, type Provider } from "@neuro-agent/core";
import {
  aggregate,
  DEFAULT_WINDOW_TOKENS,
  generateTasks,
  liveBaselines,
  offlineBaselines,
  renderMarkdown,
  replaySession,
  runBenchmark,
  SCALES,
  SimulatedReader,
  SUITES,
  UsageMeter,
  type StrategySpec,
  type Suite,
} from "@neuro-agent/eval";
import {
  createProvider,
  DEFAULT_MODELS,
  PROVIDERS,
  type CreateProviderOptions,
  type ProviderName,
} from "@neuro-agent/providers";

export interface CommandIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  createProvider?: (name: ProviderName, options: CreateProviderOptions) => Provider;
}

export const EVAL_USAGE = `Usage: neuro eval [options]

Runs the benchmark suites against every baseline context strategy and writes
a comparison report (<out>/<name>.md and .json).

Options:
  -p, --provider <name>     simulated | ${PROVIDERS.join(" | ")} (default: simulated, deterministic and free)
  -m, --model <id>          model for live providers
      --base-url <url>      API base URL for live providers
      --scale <name>        small | standard (default: standard)
      --seed <n>            task generator seed (default: 1)
      --suite <list>        comma-separated: ${SUITES.join(", ")} (default: all)
      --strategy <list>     comma-separated baseline names (default: all)
      --window-tokens <n>   context window budget for the windowed baselines (default: ${DEFAULT_WINDOW_TOKENS})
      --context-limit <n>   simulated model's hard context limit in tokens (default: 16000)
      --out <dir>           output directory (default: eval-results)
      --name <name>         report file name (default: <provider>-<scale>)
      --traces              also write a JSONL trace per task, strategy and session`;

export async function evalCommand(argv: string[], io: CommandIO): Promise<number> {
  const out = (s: string) => io.stdout.write(s);
  const err = (s: string) => io.stderr.write(s);
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        provider: { type: "string", short: "p" },
        model: { type: "string", short: "m" },
        "base-url": { type: "string" },
        scale: { type: "string" },
        seed: { type: "string" },
        suite: { type: "string" },
        strategy: { type: "string" },
        "window-tokens": { type: "string" },
        "context-limit": { type: "string" },
        out: { type: "string" },
        name: { type: "string" },
        traces: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    err(`${(e as Error).message}\n\n${EVAL_USAGE}\n`);
    return 2;
  }
  if (values.help) {
    out(`${EVAL_USAGE}\n`);
    return 0;
  }
  const fail = (m: string) => {
    err(`${m}\n`);
    return 2;
  };
  const positive = (name: string, v: string | undefined, fallback: number) => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
    return n;
  };

  const providerName = values.provider ?? "simulated";
  if (providerName !== "simulated" && !PROVIDERS.includes(providerName as ProviderName)) {
    return fail(`Unknown provider: ${providerName}`);
  }
  const scaleName = values.scale ?? "standard";
  if (scaleName !== "small" && scaleName !== "standard") return fail(`Unknown scale: ${scaleName}`);
  const suites = (values.suite?.split(",").map((s) => s.trim()) ?? [...SUITES]) as Suite[];
  const badSuite = suites.find((s) => !SUITES.includes(s));
  if (badSuite) return fail(`Unknown suite: ${badSuite}`);
  let seed: number, windowTokens: number, contextLimit: number;
  try {
    seed = positive("seed", values.seed, 1);
    windowTokens = positive("window-tokens", values["window-tokens"], DEFAULT_WINDOW_TOKENS);
    contextLimit = positive("context-limit", values["context-limit"], 16_000);
  } catch (e) {
    return fail((e as Error).message);
  }

  const meter = new UsageMeter();
  let model: string;
  let makeProvider: () => Provider;
  let strategies: StrategySpec[];
  if (providerName === "simulated") {
    model = "simulated";
    makeProvider = () => new SimulatedReader({ contextLimit });
    strategies = offlineBaselines(windowTokens);
  } else {
    const name = providerName as ProviderName;
    const m = values.model ?? DEFAULT_MODELS[name];
    if (!m) return fail(`--model is required for provider ${name}`);
    model = m;
    const options: CreateProviderOptions = values["base-url"]
      ? { baseURL: values["base-url"] }
      : {};
    const shared = (io.createProvider ?? createProvider)(name, options);
    makeProvider = () => shared;
    strategies = liveBaselines(shared, model, meter.add, windowTokens);
  }
  if (values.strategy) {
    const wanted = values.strategy.split(",").map((s) => s.trim());
    const unknown = wanted.find((w) => !strategies.some((s) => s.name === w));
    if (unknown)
      return fail(
        `Unknown strategy: ${unknown} (have: ${strategies.map((s) => s.name).join(", ")})`,
      );
    strategies = strategies.filter((s) => wanted.includes(s.name));
  }

  const tasks = generateTasks({ seed, scale: SCALES[scaleName], suites });
  const outDir = resolve(values.out ?? "eval-results");
  const name = values.name ?? `${providerName}-${scaleName}`;
  err(
    `Running ${tasks.length} tasks × ${strategies.length} strategies on ${providerName}/${model}…\n`,
  );

  const results = await runBenchmark(
    {
      tasks,
      strategies,
      provider: makeProvider,
      model,
      ...(values.traces ? { traceDir: join(outDir, `${name}-traces`) } : {}),
      onProgress: (done, total, r) =>
        err(
          `  [${done}/${total}] ${r.strategy} ${r.taskId}: ${r.probes.filter((p) => p.correct).length}/${r.probes.length} correct\n`,
        ),
    },
    meter,
  );

  const meta = {
    title: `Baseline comparison (${providerName}, ${scaleName})`,
    provider: providerName,
    model,
    seed,
    scale: scaleName,
    windowTokens,
    date: new Date().toISOString().slice(0, 10),
    notes:
      providerName === "simulated"
        ? [
            `Simulated model: a deterministic reader that answers only from facts visible in its prompt, with a hard ${contextLimit}-token context limit. Scores measure what each context strategy delivers to the model, not language-model quality. Wall-clock times are for the harness only.`,
          ]
        : [
            "Live model. Summarizer calls (summary-buffer) are included in token counts but not in cost.",
          ],
  };
  mkdirSync(outDir, { recursive: true });
  const markdown = renderMarkdown(results, meta);
  writeFileSync(join(outDir, `${name}.md`), markdown);
  writeFileSync(
    join(outDir, `${name}.json`),
    JSON.stringify({ meta, aggregates: aggregate(results), results }, null, 2) + "\n",
  );
  out(markdown.split("## Accuracy by suite")[0]!.trimEnd() + "\n");
  out(`\nReport: ${join(outDir, `${name}.md`)}\n`);
  return 0;
}

export async function replayCommand(argv: string[], io: CommandIO): Promise<number> {
  const file = argv[0];
  if (!file || argv.length > 1) {
    io.stderr.write("Usage: neuro replay <file.jsonl>\n");
    return 2;
  }
  try {
    const original = readTrace(file);
    const { events, divergence } = await replaySession(original);
    if (divergence < 0) {
      io.stdout.write(`Replayed ${events.length} events: identical to the recording.\n`);
      return 0;
    }
    const a = original[divergence];
    const b = events[divergence];
    io.stdout.write(
      `Replay diverges at event ${divergence + 1}: recorded ${a?.type ?? "(end)"}, replayed ${b?.type ?? "(end)"}.\n` +
        `  recorded: ${JSON.stringify(a?.payload ?? null).slice(0, 300)}\n` +
        `  replayed: ${JSON.stringify(b?.payload ?? null).slice(0, 300)}\n`,
    );
    return 1;
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
}
