import type { TaskResult } from "./runner.js";
import { SUITES, type Suite } from "./tasks.js";

export interface Aggregate {
  strategy: string;
  suite: Suite | "all";
  tasks: number;
  probes: number;
  /** Share of probes answered correctly. */
  accuracy: number;
  /** Share of probes answered with a superseded value. */
  staleRate: number;
  /** Share of tasks with every probe correct. */
  taskSuccess: number;
  tokensPerTask: number;
  modelCallsPerTask: number;
  costPerTaskUsd: number;
  wallClockMsPerTask: number;
  errors: number;
  /** Retrieval strategies only. */
  recallAtK?: number;
  retrievalPrecision?: number;
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function aggregate(results: readonly TaskResult[]): Aggregate[] {
  const strategies = [...new Set(results.map((r) => r.strategy))];
  const out: Aggregate[] = [];
  for (const strategy of strategies) {
    for (const suite of [...SUITES, "all"] as const) {
      const rows = results.filter(
        (r) => r.strategy === strategy && (suite === "all" || r.suite === suite),
      );
      if (rows.length === 0) continue;
      const probes = rows.flatMap((r) => r.probes);
      const retrieval = probes.filter((p) => p.recallHit !== undefined);
      out.push({
        strategy,
        suite,
        tasks: rows.length,
        probes: probes.length,
        accuracy: mean(probes.map((p) => (p.correct ? 1 : 0))),
        staleRate: mean(probes.map((p) => (p.stale ? 1 : 0))),
        taskSuccess: mean(rows.map((r) => (r.probes.every((p) => p.correct) ? 1 : 0))),
        tokensPerTask: mean(
          rows.map((r) => r.usage.inputTokens + r.usage.outputTokens + r.usage.cacheReadTokens),
        ),
        modelCallsPerTask: mean(rows.map((r) => r.modelCalls)),
        costPerTaskUsd: mean(rows.map((r) => r.costUsd)),
        wallClockMsPerTask: mean(rows.map((r) => r.wallClockMs)),
        errors: rows.reduce((n, r) => n + r.errors.length, 0),
        ...(retrieval.length > 0
          ? {
              recallAtK: mean(retrieval.map((p) => (p.recallHit ? 1 : 0))),
              retrievalPrecision: mean(retrieval.map((p) => p.precision ?? 0)),
            }
          : {}),
      });
    }
  }
  return out;
}

export interface ReportMeta {
  title: string;
  provider: string;
  model: string;
  seed: number;
  scale: string;
  windowTokens: number;
  date: string;
  notes?: string[];
}

const pct = (x: number | undefined) => (x === undefined ? "–" : `${(x * 100).toFixed(0)}%`);
const num = (x: number) => (x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(1));

/** Renders the comparison report as Markdown. */
export function renderMarkdown(results: readonly TaskResult[], meta: ReportMeta): string {
  const aggs = aggregate(results);
  const overall = aggs.filter((a) => a.suite === "all");
  const suites = SUITES.filter((s) => aggs.some((a) => a.suite === s));
  const lines: string[] = [];
  lines.push(`# ${meta.title}`, "");
  lines.push(
    `Provider \`${meta.provider}\` · model \`${meta.model}\` · scale \`${meta.scale}\` · seed ${meta.seed} · window ${meta.windowTokens} tokens · ${meta.date}`,
    "",
  );
  for (const note of meta.notes ?? []) lines.push(`> ${note}`, "");

  lines.push("## Overall", "");
  lines.push(
    "| Strategy | Accuracy | Task success | Stale answers | Tokens / task | Model calls / task | Cost / task | Wall-clock / task | Errors | Recall@k | Retrieval precision |",
    "| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
  );
  for (const a of overall) {
    lines.push(
      `| ${a.strategy} | ${pct(a.accuracy)} | ${pct(a.taskSuccess)} | ${pct(a.staleRate)} | ${num(a.tokensPerTask)} | ${num(a.modelCallsPerTask)} | $${a.costPerTaskUsd.toFixed(4)} | ${num(a.wallClockMsPerTask)} ms | ${a.errors} | ${pct(a.recallAtK)} | ${pct(a.retrievalPrecision)} |`,
    );
  }
  lines.push("");

  lines.push("## Accuracy by suite", "");
  lines.push(
    `| Strategy | ${suites.join(" | ")} |`,
    `| --- |${suites.map(() => " --: |").join("")}`,
  );
  for (const strategy of overall.map((a) => a.strategy)) {
    const cells = suites.map((s) =>
      pct(aggs.find((a) => a.strategy === strategy && a.suite === s)?.accuracy),
    );
    lines.push(`| ${strategy} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Tokens per task by suite", "");
  lines.push(
    `| Strategy | ${suites.join(" | ")} |`,
    `| --- |${suites.map(() => " --: |").join("")}`,
  );
  for (const strategy of overall.map((a) => a.strategy)) {
    const cells = suites.map((s) => {
      const a = aggs.find((x) => x.strategy === strategy && x.suite === s);
      return a ? num(a.tokensPerTask) : "–";
    });
    lines.push(`| ${strategy} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  const sameVsNew = overall.map((a) => {
    const probes = results.filter((r) => r.strategy === a.strategy).flatMap((r) => r.probes);
    const s1 = probes.filter((p) => p.session === 1);
    const s2 = probes.filter((p) => p.session > 1);
    return `| ${a.strategy} | ${pct(mean(s1.map((p) => (p.correct ? 1 : 0))))} | ${s2.length ? pct(mean(s2.map((p) => (p.correct ? 1 : 0)))) : "–"} |`;
  });
  lines.push("## Same session vs. a new session", "");
  lines.push(
    "| Strategy | Probes in the same session | Probes in a later session |",
    "| --- | --: | --: |",
    ...sameVsNew,
    "",
  );

  const withErrors = overall.filter((a) => a.errors > 0);
  if (withErrors.length > 0) {
    lines.push("## Errors", "");
    for (const a of withErrors) {
      const rows = results.filter((r) => r.strategy === a.strategy && r.errors.length > 0);
      const example = rows[0]!.errors[0]!;
      lines.push(
        `- **${a.strategy}**: ${a.errors} failed requests in ${rows.length} tasks, e.g. ${example}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
