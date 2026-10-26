import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Agent,
  FullTranscript,
  isEvent,
  JsonlTraceWriter,
  SlidingWindow,
  teeSinks,
  type AgentEvent,
  type ContextStrategy,
  type Provider,
  type Usage,
} from "@neuro-agent/core";
import {
  extractiveSummarizer,
  HashingEmbedder,
  InMemoryBackend,
  InMemoryVectorStore,
  llmSummarizer,
  LongTermMemory,
  messageText,
  SummaryBuffer,
  VectorRag,
  WorkingMemory,
  type Embedder,
  type RetrievalFeatures,
  type Summarizer,
  type WorkingMemoryFeatures,
} from "@neuro-agent/memory";
import { listFilesTool, readFileTool, searchTool } from "@neuro-agent/tools";
import type { BenchmarkTask, Probe, Suite } from "./tasks.js";

/** Long-term state that survives across the sessions of one task. */
export interface EpisodeMemory {
  /** Phase 2/3 message-level vector store. */
  store: InMemoryVectorStore;
  /** Phase 4 episodic + semantic memory, created on first use. */
  longTerm(features?: Partial<RetrievalFeatures>): LongTermMemory;
}

export interface StrategySpec {
  name: string;
  /** True for strategies that recall from a store (they get retrieval metrics). */
  retrieves: boolean;
  /** Called once per session. */
  create(memory: EpisodeMemory): ContextStrategy;
}

export interface BaselineConfig {
  /** Sliding-window budget in estimated tokens (also the window under summary/RAG). */
  windowTokens: number;
  summaryTokens: number;
  topK: number;
  summarizer: Summarizer;
  embedder: Embedder;
}

/** The four Phase 2 baselines. */
export function baselineStrategies(config: BaselineConfig): StrategySpec[] {
  return [
    { name: "full-transcript", retrieves: false, create: () => new FullTranscript() },
    {
      name: "sliding-window",
      retrieves: false,
      create: () => new SlidingWindow(config.windowTokens),
    },
    {
      name: "summary-buffer",
      retrieves: false,
      create: () =>
        new SummaryBuffer({
          windowTokens: config.windowTokens - config.summaryTokens,
          summarizer: config.summarizer,
        }),
    },
    {
      name: "vector-rag",
      retrieves: true,
      create: (memory) =>
        new VectorRag({
          store: memory.store,
          embedder: config.embedder,
          windowTokens: config.windowTokens - Math.round(config.windowTokens / 4),
          topK: config.topK,
          maxItemChars: Math.round(config.windowTokens / 4 / config.topK) * 4,
        }),
    },
  ];
}

/**
 * Phase 3 working memory at the same token budget as the baselines, plus one
 * ablation per mechanism (each switches a single feature off).
 */
export function workingMemoryStrategies(
  windowTokens: number,
  embedder: Embedder = new HashingEmbedder(),
): StrategySpec[] {
  const variant = (name: string, features: Partial<WorkingMemoryFeatures> = {}): StrategySpec => ({
    name,
    retrieves: true,
    create: (memory) =>
      new WorkingMemory({ budgetTokens: windowTokens, store: memory.store, embedder, features }),
  });
  return [
    variant("working-memory"),
    variant("wm-no-chunking", { chunking: false }),
    variant("wm-recency-gate", { attention: false }),
    variant("wm-no-activation", { activation: false }),
  ];
}

/**
 * Phase 4: working memory backed by episodic and semantic long-term memory
 * with hybrid recall, plus ablations of the retrieval channels.
 */
export function longTermStrategies(windowTokens: number): StrategySpec[] {
  const variant = (name: string, features: Partial<RetrievalFeatures> = {}): StrategySpec => ({
    name,
    retrieves: true,
    create: (memory) =>
      new WorkingMemory({ budgetTokens: windowTokens, longTerm: memory.longTerm(features) }),
  });
  return [
    variant("long-term-memory"),
    variant("ltm-vector-only", { lexical: false, graph: false }),
    variant("ltm-episodes-only", { semantic: false }),
  ];
}

export const DEFAULT_WINDOW_TOKENS = 4000;

/** Offline defaults: extractive summaries and hashed bag-of-words embeddings. */
export function offlineBaselines(windowTokens = DEFAULT_WINDOW_TOKENS): StrategySpec[] {
  const summaryTokens = Math.round(windowTokens / 5);
  return baselineStrategies({
    windowTokens,
    summaryTokens,
    topK: 4,
    summarizer: extractiveSummarizer({ maxTokens: summaryTokens }),
    embedder: new HashingEmbedder(),
  });
}

/** The baselines plus working memory and its ablations, all offline. */
export function offlineStrategies(windowTokens = DEFAULT_WINDOW_TOKENS): StrategySpec[] {
  return [
    ...offlineBaselines(windowTokens),
    ...workingMemoryStrategies(windowTokens),
    ...longTermStrategies(windowTokens),
  ];
}

/** Live defaults: the summary buffer summarizes with the model under test. */
export function liveBaselines(
  provider: Provider,
  model: string,
  onUsage: (usage: Usage) => void,
  windowTokens = DEFAULT_WINDOW_TOKENS,
): StrategySpec[] {
  const summaryTokens = Math.round(windowTokens / 5);
  return baselineStrategies({
    windowTokens,
    summaryTokens,
    topK: 4,
    summarizer: llmSummarizer({ provider, model, maxTokens: summaryTokens, onUsage }),
    embedder: new HashingEmbedder(),
  });
}

export const EVAL_SYSTEM_PROMPT = `You are being evaluated on memory. Answer only from information available in this conversation.
When asked "What is the X?", answer in the form "The X is <value>." If you do not know, say so plainly.
When asked to compute a total of values in files, read each file with read_file and reply "The total is <number>."
For anything else, reply "Noted."`;

export interface ProbeResult {
  question: string;
  expected: string;
  response: string;
  correct: boolean;
  stale: boolean;
  /**
   * Retrieval metrics, for strategies that recall and only on probes whose answer
   * was outside the window: did any recalled item contain the answer, and what share did.
   */
  recallHit?: boolean;
  precision?: number;
  session: number;
}

export interface TaskResult {
  taskId: string;
  suite: Suite;
  strategy: string;
  probes: ProbeResult[];
  usage: Usage;
  costUsd: number;
  modelCalls: number;
  errors: string[];
  wallClockMs: number;
}

export interface RunOptions {
  tasks: BenchmarkTask[];
  strategies: StrategySpec[];
  /** A fresh provider per session (providers may keep per-call state). */
  provider: () => Provider;
  model: string;
  maxTokens?: number;
  /** Write one JSONL trace per task × strategy × session here. */
  traceDir?: string;
  /** Extra usage (e.g. LLM summarizer calls) is reported through this hook by callers; added to the current task. */
  onProgress?: (done: number, total: number, result: TaskResult) => void;
  now?: () => number;
}

const contains = (text: string, needle: string) =>
  text.toLowerCase().includes(needle.toLowerCase());

export function gradeProbe(response: string, probe: Probe): { correct: boolean; stale: boolean } {
  const correct = contains(response, probe.answer);
  const stale = !correct && (probe.stale ?? []).some((s) => contains(response, s));
  return { correct, stale };
}

/** Extra usage incurred outside the agent loop (e.g. summarizer calls), attributed to the running task. */
export class UsageMeter {
  usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  readonly add = (u: Usage) => {
    this.usage = {
      inputTokens: this.usage.inputTokens + u.inputTokens,
      outputTokens: this.usage.outputTokens + u.outputTokens,
      cacheReadTokens: this.usage.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: this.usage.cacheWriteTokens + u.cacheWriteTokens,
    };
  };
  take(): Usage {
    const u = this.usage;
    this.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    return u;
  }
}

/** Runs every task under every strategy. Deterministic when the provider is. */
export async function runBenchmark(options: RunOptions, meter?: UsageMeter): Promise<TaskResult[]> {
  const now = options.now ?? (() => performance.now());
  const results: TaskResult[] = [];
  const total = options.tasks.length * options.strategies.length;
  for (const strategy of options.strategies) {
    for (const task of options.tasks) {
      const result = await runTask(task, strategy, options, now, meter);
      results.push(result);
      options.onProgress?.(results.length, total, result);
    }
  }
  return results;
}

async function runTask(
  task: BenchmarkTask,
  strategy: StrategySpec,
  options: RunOptions,
  now: () => number,
  meter?: UsageMeter,
): Promise<TaskResult> {
  const workspace = mkdtempSync(join(tmpdir(), "neuro-eval-"));
  for (const [name, content] of Object.entries(task.files ?? {})) {
    mkdirSync(dirname(join(workspace, name)), { recursive: true });
    writeFileSync(join(workspace, name), content);
  }
  meter?.take();
  let longTerm: LongTermMemory | undefined;
  const memory: EpisodeMemory = {
    store: new InMemoryVectorStore(),
    longTerm: (features) =>
      (longTerm ??= new LongTermMemory({
        backend: new InMemoryBackend(),
        features: features ?? {},
      })),
  };
  const result: TaskResult = {
    taskId: task.id,
    suite: task.suite,
    strategy: strategy.name,
    probes: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    modelCalls: 0,
    errors: [],
    wallClockMs: 0,
  };
  const started = now();
  try {
    for (const [s, turns] of task.sessions.entries()) {
      let events: AgentEvent[] = [];
      const trace = options.traceDir
        ? new JsonlTraceWriter(join(options.traceDir, strategy.name, `${task.id}.s${s + 1}.jsonl`))
        : undefined;
      const agent = new Agent({
        provider: options.provider(),
        model: options.model,
        tools: [readFileTool, listFilesTool, searchTool],
        system: EVAL_SYSTEM_PROMPT,
        context: strategy.create(memory),
        maxTurns: task.maxTurns ?? 6,
        maxTokens: options.maxTokens ?? 1024,
        cwd: workspace,
        onEvent: teeSinks(trace?.write, (e) => events.push(e)),
      });
      for (const turn of turns) {
        events = [];
        const before = agent.transcript.length;
        const run = await agent.send(turn.user);
        result.modelCalls += events.filter((e) => e.type === "model.request").length;
        if (run.error) result.errors.push(`${task.id} s${s + 1}: ${run.error.message}`);
        if (!turn.probe) continue;
        // What the window itself showed on the probe's first call (memories excluded).
        const first = events.find((e) => isEvent(e, "model.request"));
        const dropped =
          first && isEvent(first, "model.request") ? first.payload.droppedMessages : 0;
        const windowText = agent.transcript
          .slice(dropped, before + 1)
          .map(messageText)
          .join("\n");
        const needsRecall = !contains(windowText, turn.probe.answer);
        result.probes.push(
          scoreProbe(
            turn.user,
            turn.probe,
            run.text,
            events,
            strategy.retrieves && needsRecall,
            s + 1,
          ),
        );
      }
      const u = agent.costs.usage;
      result.usage = addU(result.usage, u);
      result.costUsd += agent.costs.costUsd;
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  if (meter) result.usage = addU(result.usage, meter.take());
  result.wallClockMs = Math.round(now() - started);
  return result;
}

function scoreProbe(
  question: string,
  probe: Probe,
  response: string,
  events: AgentEvent[],
  retrieves: boolean,
  session: number,
): ProbeResult {
  const grade = gradeProbe(response, probe);
  const out: ProbeResult = { question, expected: probe.answer, response, ...grade, session };
  if (retrieves && probe.retrievable) {
    const first = events.find((e) => isEvent(e, "model.request"));
    const retrieved =
      first && isEvent(first, "model.request") ? (first.payload.retrieved ?? []) : [];
    const relevant = retrieved.filter((r) => contains(r.text, probe.answer)).length;
    out.recallHit = relevant > 0;
    out.precision = retrieved.length > 0 ? relevant / retrieved.length : 0;
  }
  return out;
}

function addU(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
