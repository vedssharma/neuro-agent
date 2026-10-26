import { cosine, tokenize } from "../embedding.js";
import type { Entity, Episode, Fact, Hit, RecordKind } from "./types.js";

/**
 * Storage for the episodic and semantic stores. Implementations: the
 * in-memory backend below (tests, evaluation) and SQLite
 * (`@neuro-agent/store-sqlite`). Methods are async so remote backends fit.
 */
export interface MemoryBackend {
  putEpisode(episode: Episode, vector: readonly number[]): Promise<void>;
  /** Inserts or replaces a fact. */
  putFact(fact: Fact, vector: readonly number[]): Promise<void>;
  /** Inserts or replaces an entity. */
  putEntity(entity: Entity): Promise<void>;
  getEpisode(id: string): Promise<Episode | undefined>;
  getFact(id: string): Promise<Fact | undefined>;
  getEntity(name: string): Promise<Entity | undefined>;
  /** Facts about a subject, superseded ones included. */
  factsAbout(subject: string): Promise<Fact[]>;
  episodes(): Promise<Episode[]>;
  facts(): Promise<Fact[]>;
  entities(): Promise<Entity[]>;
  /** Full-text search (BM25), best first. */
  lexical(query: string, k: number): Promise<Hit[]>;
  /** Nearest neighbours by embedding, best first. */
  similar(vector: readonly number[], k: number, kind?: RecordKind): Promise<Hit[]>;
  /** Highest `time` stored so far (0 when empty). */
  latestTime(): Promise<number>;
  close(): Promise<void>;
}

/** A vector index the backends delegate to; brute force for now, swappable later. */
export interface VectorIndex {
  add(id: string, kind: RecordKind, vector: readonly number[]): void;
  search(vector: readonly number[], k: number, kind?: RecordKind): Hit[];
}

export class BruteForceIndex implements VectorIndex {
  private readonly items = new Map<string, { kind: RecordKind; vector: readonly number[] }>();

  add(id: string, kind: RecordKind, vector: readonly number[]): void {
    this.items.set(id, { kind, vector });
  }

  search(vector: readonly number[], k: number, kind?: RecordKind): Hit[] {
    const hits: Hit[] = [];
    for (const [id, item] of this.items) {
      if (kind && item.kind !== kind) continue;
      hits.push({ id, kind: item.kind, score: cosine(vector, item.vector) });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, k);
  }
}

/** Text that full-text search indexes for each record. */
export const episodeSearchText = (e: Episode) => [e.where, e.index, e.distinct ?? ""].join("\n");
export const factSearchText = (f: Fact) => f.text;

/** Okapi BM25 over an in-memory corpus. */
export class Bm25 {
  private readonly docs = new Map<
    string,
    { kind: RecordKind; tf: Map<string, number>; len: number }
  >();
  private readonly df = new Map<string, number>();
  private totalLength = 0;

  set(id: string, kind: RecordKind, text: string): void {
    this.remove(id);
    const tf = new Map<string, number>();
    const words = tokenize(text);
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    this.docs.set(id, { kind, tf, len: words.length });
    this.totalLength += words.length;
  }

  private remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const w of doc.tf.keys()) this.df.set(w, this.df.get(w)! - 1);
    this.totalLength -= doc.len;
    this.docs.delete(id);
  }

  search(query: string, k: number): Hit[] {
    const terms = [...new Set(tokenize(query))];
    const n = this.docs.size;
    if (n === 0 || terms.length === 0) return [];
    const avg = this.totalLength / n;
    const hits: Hit[] = [];
    for (const [id, doc] of this.docs) {
      let score = 0;
      for (const t of terms) {
        const f = doc.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * doc.len) / avg));
      }
      if (score > 0) hits.push({ id, kind: doc.kind, score });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, k);
  }
}

/** Everything in process memory; lives as long as the object. */
export class InMemoryBackend implements MemoryBackend {
  private readonly episodeMap = new Map<string, Episode>();
  private readonly factMap = new Map<string, Fact>();
  private readonly entityMap = new Map<string, Entity>();
  private readonly text = new Bm25();
  private time = 0;

  constructor(private readonly index: VectorIndex = new BruteForceIndex()) {}

  async putEpisode(episode: Episode, vector: readonly number[]): Promise<void> {
    this.episodeMap.set(episode.id, structuredClone(episode));
    this.text.set(episode.id, "episode", episodeSearchText(episode));
    this.index.add(episode.id, "episode", vector);
    this.time = Math.max(this.time, episode.time);
  }

  async putFact(fact: Fact, vector: readonly number[]): Promise<void> {
    this.factMap.set(fact.id, structuredClone(fact));
    this.text.set(fact.id, "fact", factSearchText(fact));
    this.index.add(fact.id, "fact", vector);
    this.time = Math.max(this.time, fact.time);
  }

  async putEntity(entity: Entity): Promise<void> {
    this.entityMap.set(entity.name, structuredClone(entity));
  }

  async getEpisode(id: string) {
    const e = this.episodeMap.get(id);
    return e && structuredClone(e);
  }

  async getFact(id: string) {
    const f = this.factMap.get(id);
    return f && structuredClone(f);
  }

  async getEntity(name: string) {
    const e = this.entityMap.get(name);
    return e && structuredClone(e);
  }

  async factsAbout(subject: string): Promise<Fact[]> {
    return [...this.factMap.values()]
      .filter((f) => f.subject === subject)
      .map((f) => structuredClone(f));
  }

  async episodes() {
    return [...this.episodeMap.values()].map((e) => structuredClone(e));
  }

  async facts() {
    return [...this.factMap.values()].map((f) => structuredClone(f));
  }

  async entities() {
    return [...this.entityMap.values()].map((e) => structuredClone(e));
  }

  async lexical(query: string, k: number) {
    return this.text.search(query, k);
  }

  async similar(vector: readonly number[], k: number, kind?: RecordKind) {
    return this.index.search(vector, k, kind);
  }

  async latestTime() {
    return this.time;
  }

  async close() {}
}
