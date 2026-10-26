import {
  isTurnStart,
  sumTokens,
  type ContextSelection,
  type ContextStrategy,
  type Message,
  type RetrievedItem,
} from "@neuro-agent/core";
import { cosine, HashingEmbedder, type Embedder, type InMemoryVectorStore } from "./embedding.js";
import { prependToFirst, userWords } from "./text.js";

/** Mechanisms that can be switched off one at a time for ablations. */
export interface WorkingMemoryFeatures {
  /** Compress older tool outputs in the current turn into goal-relevant chunks. Off: sent verbatim. */
  chunking: boolean;
  /** Admit chunks to the focus region by relevance, salience, recency and rehearsal. Off: by recency only. */
  attention: boolean;
  /** Chunks kept in focus get a bonus that decays once they leave it. */
  rehearsal: boolean;
  /** Recall chunks from earlier sessions (the shared store) into the activated region. */
  activation: boolean;
}

export interface WorkingMemoryOptions {
  /** Total prompt budget in estimated tokens. */
  budgetTokens: number;
  /** Long-term store shared across sessions; attended or salient chunks are promoted into it. */
  store?: InMemoryVectorStore;
  embedder?: Embedder;
  /** Active chunks in the focus region. Default 4. */
  focusSlots?: number;
  /** Share of the budget the focus region may use. Default 0.3. */
  focusShare?: number;
  /** Share of the budget the activated region may use. Default 0.2. */
  activatedShare?: number;
  /** Items recalled into the activated region. Default 4. */
  activatedSlots?: number;
  /** Longest rendering of one chunk, in estimated tokens. Default 80. */
  chunkTokens?: number;
  /** Newest tool-result messages of the current turn kept verbatim. Default 1. */
  rawToolResults?: number;
  /** Unattended, unsalient chunks are forgotten once this many newer chunks exist. Default 48. */
  sensoryChunks?: number;
  /** Minimum goal relevance for a chunk to enter focus or be recalled. Default 0.1. */
  minRelevance?: number;
  /** Recency half-life, in chunks. Default 20. */
  recencyHalfLife?: number;
  features?: Partial<WorkingMemoryFeatures>;
}

export type ChunkKind = "user" | "assistant" | "tool";

/** A compressed, typed unit of the conversation with a pointer back to its source. */
export interface Chunk {
  /** Short id shown to the model (c1, c2, …). */
  id: string;
  /** Id in the long-term store. */
  key: string;
  kind: ChunkKind;
  /** e.g. read_file(src/a.ts), or the role. */
  label: string;
  /** Transcript index of the message the chunk came from. */
  message: number;
  /** Full text: the artifact the chunk points to. */
  text: string;
  tokens: number;
  salience: number;
  /** Bonus for having been in focus; halves on every call the chunk is not admitted. */
  rehearsal: number;
  promoted: boolean;
  seq: number;
}

interface Sentence {
  text: string;
  vector: number[];
  salience: number;
}

const DEFAULT_FEATURES: WorkingMemoryFeatures = {
  chunking: true,
  attention: true,
  rehearsal: true,
  activation: true,
};

/** Earlier requests listed under the current goal. */
const GOAL_STACK_DEPTH = 2;
const tokensOf = (text: string) => Math.ceil(text.length / 4);
const SENTENCE = /(?<=[.!?;])\s+|\n+/;
const CUES =
  /\b(remember|keep in mind|keep track|correction|changed my mind|important|note that|for the record|deadline|must|never|always)\b/i;

/** How much a piece of text looks worth keeping: numbers and codes, statements, explicit cues. */
export function salience(text: string): number {
  let s = 0;
  if (/\d/.test(text)) s += 0.4;
  if (/\b(is|are|was|were)\b/i.test(text)) s += 0.3;
  if (CUES.test(text)) s += 0.4;
  return Math.min(1, s);
}

/**
 * Working memory as a context strategy (Phase 3): each prompt is compiled
 * from slots instead of a raw transcript suffix.
 *
 * - goal stack: the current request (and earlier ones not otherwise visible);
 * - focus region: a few chunks of this session admitted by an attention gate
 *   (relevance to the goal, salience, recency, rehearsal);
 * - activated region: chunks recalled from earlier sessions;
 * - sensory tail: the most recent raw turns that still fit;
 * - the current turn, with older tool outputs compressed to goal-relevant
 *   sentences plus a pointer to the full output.
 *
 * Budget priority is goal → current turn → focus → activated → tail, so as the
 * budget shrinks the tail goes first, then the activated region, then focus.
 * One instance per session; the store is what carries across sessions.
 */
export class WorkingMemory implements ContextStrategy {
  readonly name: string;
  readonly features: WorkingMemoryFeatures;
  private readonly embedder: Embedder;
  private readonly session: string;
  private chunks: Chunk[] = [];
  private seq = 0;
  /** Blocks already chunked, per transcript message. */
  private seen: number[] = [];
  private pendingCalls = new Map<string, { name: string; input: unknown }>();
  /** Tool-result chunks by tool call id, for compressing the current turn. */
  private byCall = new Map<string, Chunk>();
  private sentences = new Map<string, Sentence[]>();
  private relevance = new Map<string, number>();
  private relevanceGoal = "";

  constructor(private readonly options: WorkingMemoryOptions) {
    if (!(options.budgetTokens > 0)) throw new RangeError("budgetTokens must be positive");
    this.features = { ...DEFAULT_FEATURES, ...options.features };
    this.embedder = options.embedder ?? new HashingEmbedder();
    this.name = "working-memory";
    const epoch = String(options.store?.size ?? 0).padStart(6, "0");
    this.session = `${epoch}-${globalThis.crypto.randomUUID().slice(0, 4)}`;
  }

  /** The chunks this session currently holds (for inspection and tests). */
  get held(): readonly Chunk[] {
    return this.chunks;
  }

  async select(transcript: readonly Message[]): Promise<ContextSelection> {
    await this.ingest(transcript);
    let turnStart = -1;
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (isTurnStart(transcript[i]!)) {
        turnStart = i;
        break;
      }
    }
    if (turnStart < 0) {
      return { messages: [...transcript], dropped: 0, estimatedTokens: sumTokens(transcript) };
    }

    const budget = this.options.budgetTokens;
    const goal = userWords(transcript[turnStart]!);
    const goalVector = await this.vector(goal);
    await this.scoreRelevance(goal, goalVector);

    // Current turn: always sent, older tool outputs compressed.
    const current = await this.compileCurrentTurn(transcript, turnStart, goalVector, budget);
    let remaining = budget - sumTokens(current);

    // Goal stack: earlier requests are listed only if they don't fit in the tail.
    // Their room (and the section headings') is reserved up front.
    const header = `Current goal: ${clip(goal, 300)}`;
    remaining -= tokensOf(header) + GOAL_STACK_DEPTH * 30 + 40;

    // Sensory tail candidates: whole previous turns, newest first.
    const turnStarts: number[] = [];
    for (let i = 0; i < turnStart; i++) if (isTurnStart(transcript[i]!)) turnStarts.push(i);

    // Focus region.
    const focusBudget = Math.min(Math.round(budget * (this.options.focusShare ?? 0.3)), remaining);
    const focus = await this.admitFocus(turnStart, goalVector, focusBudget);
    remaining -= focus.tokens;

    // Activated region (dropped before focus when the budget is short).
    const activatedBudget = Math.min(
      Math.round(budget * (this.options.activatedShare ?? 0.2)),
      remaining,
    );
    const activated = await this.activate(goalVector, activatedBudget);
    remaining -= activated.tokens;

    // Sensory tail: the most recent raw turns that still fit.
    let tailStart = turnStart;
    for (let k = turnStarts.length - 1; k >= 0; k--) {
      const cost = sumTokens(transcript.slice(turnStarts[k]!, tailStart));
      if (cost > remaining) break;
      remaining -= cost;
      tailStart = turnStarts[k]!;
    }
    // Chunks now visible raw in the tail don't need a focus slot; free it up.
    const focusItems = focus.items.filter((f) => f.chunk.message < tailStart);
    for (const f of focus.items) if (f.chunk.message >= tailStart) f.chunk.rehearsal = 1;

    const earlier = turnStarts
      .filter((i) => i < tailStart)
      .slice(-GOAL_STACK_DEPTH)
      .map((i) => clip(userWords(transcript[i]!), 100))
      .filter((t) => t !== "");

    const lines = ["<working-memory>", header];
    if (earlier.length > 0) {
      lines.push("Earlier requests (oldest first):", ...earlier.map((t) => `- ${t}`));
    }
    if (activated.items.length > 0) {
      lines.push(
        "Recalled from earlier sessions (oldest first):",
        ...activated.items.map((a) => a.rendered),
      );
    }
    if (focusItems.length > 0) {
      lines.push(
        "In focus from this session (oldest first):",
        ...focusItems.map((f) => f.rendered),
      );
    }
    lines.push("</working-memory>");

    const messages = prependToFirst(
      [...transcript.slice(tailStart, turnStart), ...current],
      lines.join("\n"),
    );
    const retrieved: RetrievedItem[] = [...activated.items, ...focusItems].map((x) => ({
      id: x.key,
      score: Math.round(x.score * 1000) / 1000,
      text: x.rendered,
    }));
    return {
      messages,
      dropped: tailStart,
      estimatedTokens: sumTokens(messages),
      rewritten: true,
      retrieved,
    };
  }

  /** Turns new message blocks into chunks; forgets stale sensory chunks. */
  private async ingest(transcript: readonly Message[]): Promise<void> {
    const fresh: Chunk[] = [];
    for (let m = 0; m < transcript.length; m++) {
      const message = transcript[m]!;
      const from = this.seen[m] ?? 0;
      if (from >= message.content.length) continue;
      for (let b = from; b < message.content.length; b++) {
        const block = message.content[b]!;
        if (block.type === "tool_call") {
          this.pendingCalls.set(block.id, { name: block.name, input: block.input });
        } else if (block.type === "text" && block.text.trim()) {
          fresh.push(this.chunk(message.role, message.role, m, block.text.trim()));
        } else if (block.type === "tool_result") {
          const call = this.pendingCalls.get(block.toolCallId);
          this.pendingCalls.delete(block.toolCallId);
          const label = call ? `${call.name}(${describeInput(call.input)})` : "tool result";
          const text = block.isError ? `Error: ${block.content}` : block.content;
          const chunk = this.chunk("tool", label, m, text);
          this.byCall.set(block.toolCallId, chunk);
          fresh.push(chunk);
        }
      }
      this.seen[m] = message.content.length;
    }
    this.chunks.push(...fresh);

    // Sensory buffer: salient chunks are promoted at once, the rest only if attended.
    await this.promote(fresh.filter((c) => c.salience >= 0.5));
    const horizon = this.seq - (this.options.sensoryChunks ?? 48);
    this.chunks = this.chunks.filter((c) => {
      const keep = c.promoted || c.rehearsal > 0 || c.seq > horizon;
      if (!keep) this.sentences.delete(c.key);
      return keep;
    });
  }

  private chunk(kind: ChunkKind, label: string, message: number, text: string): Chunk {
    const seq = ++this.seq;
    return {
      id: `c${seq}`,
      key: `${this.session}:${String(seq).padStart(6, "0")}`,
      kind,
      label,
      message,
      text,
      tokens: tokensOf(text),
      salience: salience(text),
      rehearsal: 0,
      promoted: false,
      seq,
    };
  }

  private async promote(chunks: Chunk[]): Promise<void> {
    const store = this.options.store;
    const todo = chunks.filter((c) => !c.promoted);
    for (const c of todo) c.promoted = true;
    if (!store || todo.length === 0) return;
    const vectors = await this.embedder.embed(todo.map((c) => c.text));
    store.add(
      todo.map((c, i) => ({
        id: c.key,
        text: `[${c.label}] ${c.text}`,
        vector: vectors[i]!,
      })),
    );
  }

  private async vector(text: string): Promise<number[]> {
    const [v] = await this.embedder.embed([text]);
    return v!;
  }

  private async sentencesOf(key: string, text: string): Promise<Sentence[]> {
    const cached = this.sentences.get(key);
    if (cached) return cached;
    const parts = text
      .split(SENTENCE)
      .map((s) => s.replace(/^\s*\d+\t/, "").trim())
      .filter((s) => s.length > 0);
    const vectors = await this.embedder.embed(parts);
    const out = parts.map((s, i) => ({ text: s, vector: vectors[i]!, salience: salience(s) }));
    this.sentences.set(key, out);
    return out;
  }

  /** Relevance of each held chunk to the goal: its best-matching sentence. */
  private async scoreRelevance(goal: string, goalVector: number[]): Promise<void> {
    if (goal !== this.relevanceGoal) {
      this.relevance.clear();
      this.relevanceGoal = goal;
    }
    for (const c of this.chunks) {
      if (this.relevance.has(c.key)) continue;
      const sentences = await this.sentencesOf(c.key, c.text);
      let best = 0;
      for (const s of sentences) best = Math.max(best, cosine(goalVector, s.vector));
      this.relevance.set(c.key, best);
    }
  }

  /** The chunk's goal-relevant sentences, in their original order, with a pointer header. */
  private async render(
    chunk: { key: string; text: string; label: string },
    goalVector: number[],
    maxTokens: number,
    header: string,
  ): Promise<string> {
    const sentences = await this.sentencesOf(chunk.key, chunk.text);
    const scored = sentences
      .map((s, i) => ({ i, s, score: cosine(goalVector, s.vector) + 0.3 * s.salience }))
      .filter((x) => x.score > 0.1)
      .sort((a, b) => b.score - a.score || a.i - b.i);
    const kept: typeof scored = [];
    let used = tokensOf(header);
    for (const x of scored) {
      const cost = tokensOf(x.s.text) + 1;
      if (used + cost > maxTokens && kept.length > 0) continue;
      kept.push(x);
      used += cost;
    }
    kept.sort((a, b) => a.i - b.i);
    const body = kept.map((x) => clip(x.s.text, maxTokens * 4)).join(" ");
    return body ? `${header} ${body}` : `${header} (nothing relevant to the current goal)`;
  }

  private async compileCurrentTurn(
    transcript: readonly Message[],
    turnStart: number,
    goalVector: number[],
    budget: number,
  ): Promise<Message[]> {
    const turn = transcript.slice(turnStart);
    if (!this.features.chunking) return turn;
    const resultMessages = turn
      .map((m, i) => (m.content.some((b) => b.type === "tool_result") ? i : -1))
      .filter((i) => i >= 0);
    const keepRaw = this.options.rawToolResults ?? 1;
    const compress = async (indices: number[]) => {
      for (const i of indices) {
        const message = turn[i]!;
        if (message.role !== "user") continue;
        const content = [];
        for (const block of message.content) {
          if (block.type !== "tool_result") {
            content.push(block);
            continue;
          }
          const chunk = this.byCall.get(block.toolCallId);
          if (!chunk || chunk.tokens <= this.chunkTokens) {
            content.push(block);
            continue;
          }
          const header = `[${chunk.id} · ${chunk.label} · ${chunk.tokens.toLocaleString("en-US")} tokens, compressed to what bears on the goal]`;
          const text = await this.render(chunk, goalVector, this.chunkTokens, header);
          content.push({ ...block, content: text });
        }
        turn[i] = { role: "user", content };
      }
    };
    await compress(resultMessages.slice(0, Math.max(0, resultMessages.length - keepRaw)));
    if (sumTokens(turn) > budget) await compress(resultMessages.slice(-keepRaw));
    return turn;
  }

  private get chunkTokens(): number {
    return this.options.chunkTokens ?? 80;
  }

  private async admitFocus(
    turnStart: number,
    goalVector: number[],
    budget: number,
  ): Promise<{ items: (Rendered & { chunk: Chunk })[]; tokens: number }> {
    const candidates = this.chunks.filter((c) => c.message < turnStart);
    const halfLife = this.options.recencyHalfLife ?? 20;
    const scored = candidates.map((c) => {
      const relevance = this.relevance.get(c.key) ?? 0;
      const recency = Math.exp((-Math.LN2 * (this.seq - c.seq)) / halfLife);
      const rehearsal = this.features.rehearsal ? c.rehearsal : 0;
      const score = this.features.attention
        ? relevance + 0.3 * c.salience + 0.2 * recency + 0.2 * rehearsal
        : recency;
      return { chunk: c, relevance, score };
    });
    const eligible = this.features.attention
      ? scored.filter((s) => s.relevance >= (this.options.minRelevance ?? 0.1))
      : scored;
    eligible.sort((a, b) => b.score - a.score || b.chunk.seq - a.chunk.seq);

    const items: (Rendered & { chunk: Chunk })[] = [];
    let tokens = 0;
    for (const s of eligible) {
      if (items.length >= (this.options.focusSlots ?? 4)) break;
      const c = s.chunk;
      const header = `[${c.id} · ${c.label}${c.tokens > this.chunkTokens ? ` · ${c.tokens.toLocaleString("en-US")} tokens` : ""}]`;
      const rendered = await this.render(c, goalVector, this.chunkTokens, header);
      const cost = tokensOf(rendered) + 1;
      if (tokens + cost > budget) continue;
      items.push({ key: c.key, chunk: c, score: s.score, rendered });
      tokens += cost;
    }

    // Rehearsal: admitted chunks are refreshed, the rest decay; attended chunks are promoted.
    const admitted = new Set(items.map((i) => i.chunk));
    for (const c of this.chunks) c.rehearsal = admitted.has(c) ? 1 : c.rehearsal / 2;
    await this.promote([...admitted]);
    items.sort((a, b) => a.chunk.seq - b.chunk.seq);
    return { items, tokens };
  }

  private async activate(
    goalVector: number[],
    budget: number,
  ): Promise<{ items: Rendered[]; tokens: number }> {
    const store = this.options.store;
    if (!this.features.activation || !store || budget <= 0) return { items: [], tokens: 0 };
    const own = new Set(this.chunks.map((c) => c.key));
    const prefix = `${this.session}:`;
    const k = this.options.activatedSlots ?? 4;
    const hits = store
      .search(goalVector, k * 3, own)
      .filter((h) => !h.item.id.startsWith(prefix))
      .filter((h) => h.score >= (this.options.minRelevance ?? 0.1))
      .slice(0, k);
    const items: Rendered[] = [];
    let tokens = 0;
    for (const { item, score } of hits) {
      const label = /^\[([^\]]*)\]/.exec(item.text)?.[1] ?? "memory";
      const header = `[recalled · ${label}]`;
      const text = item.text.replace(/^\[[^\]]*\]\s*/, "");
      const rendered = await this.render(
        { key: item.id, text, label },
        goalVector,
        this.chunkTokens,
        header,
      );
      const cost = tokensOf(rendered) + 1;
      if (tokens + cost > budget) continue;
      items.push({ key: item.id, score, rendered });
      tokens += cost;
    }
    items.sort((a, b) => a.key.localeCompare(b.key));
    return { items, tokens };
  }
}

interface Rendered {
  /** Store key; sorts chronologically, across sessions too. */
  key: string;
  score: number;
  rendered: string;
}

function describeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const values = Object.values(input as Record<string, unknown>).filter(
      (v) => typeof v === "string" || typeof v === "number",
    );
    if (values.length > 0) return clip(values.map(String).join(", "), 60);
  }
  return "";
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
