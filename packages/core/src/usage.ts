/** Token counts for one or more model calls. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** USD per million tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Known list prices (USD / 1M tokens). Unknown models (including local ones)
 * cost 0; pass your own table to `CostTracker` to override.
 */
export const DEFAULT_PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export function costOf(usage: Usage, pricing: ModelPricing | undefined): number {
  if (!pricing) return 0;
  const perToken = (usd: number) => usd / 1_000_000;
  return (
    usage.inputTokens * perToken(pricing.input) +
    usage.outputTokens * perToken(pricing.output) +
    usage.cacheReadTokens * perToken(pricing.cacheRead ?? pricing.input) +
    usage.cacheWriteTokens * perToken(pricing.cacheWrite ?? pricing.input)
  );
}

/** Accumulates usage and cost across calls, per model and in total. */
export class CostTracker {
  private readonly byModel = new Map<string, Usage>();

  constructor(private readonly pricing: Readonly<Record<string, ModelPricing>> = DEFAULT_PRICING) {}

  /** Records one call and returns its cost in USD. */
  add(model: string, usage: Usage): number {
    this.byModel.set(model, addUsage(this.byModel.get(model) ?? ZERO_USAGE, usage));
    return costOf(usage, this.pricing[model]);
  }

  get usage(): Usage {
    let total = ZERO_USAGE;
    for (const u of this.byModel.values()) total = addUsage(total, u);
    return total;
  }

  get costUsd(): number {
    let total = 0;
    for (const [model, u] of this.byModel) total += costOf(u, this.pricing[model]);
    return total;
  }

  models(): Record<string, Usage> {
    return Object.fromEntries(this.byModel);
  }
}
