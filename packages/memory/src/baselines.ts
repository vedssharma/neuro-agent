import {
  SlidingWindow,
  sumTokens,
  type ContextSelection,
  type ContextStrategy,
  type Message,
  type RetrievedItem,
} from "@neuro-agent/core";
import type { InMemoryVectorStore } from "./embedding.js";
import { type Embedder } from "./embedding.js";
import type { Summarizer } from "./summarize.js";
import { messageText, prependToFirst, userWords } from "./text.js";

/**
 * Sliding window plus a running summary of everything that slid out
 * (the "summary buffer" baseline). Lives for one session.
 */
export class SummaryBuffer implements ContextStrategy {
  readonly name = "summary-buffer";
  private readonly window: SlidingWindow;
  private summary = "";
  private summarizedUpTo = 0;

  constructor(private readonly options: { windowTokens: number; summarizer: Summarizer }) {
    this.window = new SlidingWindow(options.windowTokens);
  }

  async select(transcript: readonly Message[]): Promise<ContextSelection> {
    const selection = this.window.select(transcript);
    if (selection.dropped > this.summarizedUpTo) {
      this.summary = await this.options.summarizer(
        this.summary,
        transcript.slice(this.summarizedUpTo, selection.dropped),
      );
      this.summarizedUpTo = selection.dropped;
    }
    if (!this.summary) return selection;
    const messages = prependToFirst(
      selection.messages,
      `Summary of the earlier conversation:\n${this.summary}`,
    );
    return { ...selection, messages, estimatedTokens: sumTokens(messages), rewritten: true };
  }
}

export interface VectorRagOptions {
  store: InMemoryVectorStore;
  embedder: Embedder;
  windowTokens: number;
  /** Memories recalled per model call. Default 4. */
  topK?: number;
  /** Long messages are cut to this many characters when recalled. Default 1500. */
  maxItemChars?: number;
}

/**
 * Sliding window plus "vanilla" vector RAG: every message is embedded into a
 * store (which can outlive the session); on each call the top-k messages most
 * similar to the current user request, outside the window, are recalled.
 */
export class VectorRag implements ContextStrategy {
  readonly name = "vector-rag";
  private readonly window: SlidingWindow;
  /** Ids sort chronologically across sessions (store size at start), so score ties break the same way every run. */
  private readonly session: string;
  private indexed = 0;

  constructor(private readonly options: VectorRagOptions) {
    this.window = new SlidingWindow(options.windowTokens);
    const epoch = String(options.store.size).padStart(6, "0");
    this.session = `${epoch}-${globalThis.crypto.randomUUID().slice(0, 4)}`;
  }

  private id(index: number): string {
    return `${this.session}:${String(index).padStart(6, "0")}`;
  }

  async select(transcript: readonly Message[]): Promise<ContextSelection> {
    const fresh: { id: string; text: string }[] = [];
    for (; this.indexed < transcript.length; this.indexed++) {
      const text = messageText(transcript[this.indexed]!);
      if (text) fresh.push({ id: this.id(this.indexed), text });
    }
    if (fresh.length > 0) {
      const vectors = await this.options.embedder.embed(fresh.map((f) => f.text));
      this.options.store.add(fresh.map((f, i) => ({ ...f, vector: vectors[i]! })));
    }

    const selection = this.window.select(transcript);
    const query = [...selection.messages]
      .reverse()
      .map(userWords)
      .find((t) => t !== "");
    if (!query) return selection;

    const inWindow = new Set<string>();
    for (let i = selection.dropped; i < transcript.length; i++) inWindow.add(this.id(i));
    const [queryVector] = await this.options.embedder.embed([query]);
    const hits = this.options.store.search(queryVector!, this.options.topK ?? 4, inWindow);
    if (hits.length === 0) return selection;

    const max = this.options.maxItemChars ?? 1500;
    const retrieved: RetrievedItem[] = hits.map(({ item, score }) => ({
      id: item.id,
      score: Math.round(score * 1000) / 1000,
      text: item.text.length > max ? `${item.text.slice(0, max)}…` : item.text,
    }));
    const block =
      "Possibly relevant memories from earlier conversations (most similar first):\n" +
      retrieved.map((r, i) => `[${i + 1}] ${r.text}`).join("\n");
    const messages = prependToFirst(selection.messages, block);
    return {
      ...selection,
      messages,
      estimatedTokens: sumTokens(messages),
      rewritten: true,
      retrieved,
    };
  }
}
