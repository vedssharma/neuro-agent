/** Turns text into vectors for similarity search. */
export interface Embedder {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have i in is it its of on or that the this to was we were what which with you your".split(
    " ",
  ),
);

/**
 * Deterministic, dependency-free embedder: hashed bag of words and word
 * bigrams, L2-normalized. A stand-in for a neural embedding model so the
 * vector-RAG baseline runs offline and reproducibly.
 */
export class HashingEmbedder implements Embedder {
  readonly name = "hashing";

  constructor(readonly dimensions = 1024) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const words = tokenize(text).filter((w) => !STOPWORDS.has(w));
    const add = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      vector[h % this.dimensions]! += (h & 0x80000000 ? -1 : 1) * weight;
    };
    words.forEach((w, i) => {
      add(w, 1);
      if (i > 0) add(`${words[i - 1]} ${w}`, 0.5);
    });
    const norm = Math.hypot(...vector);
    return norm === 0 ? vector : vector.map((x) => x / norm);
  }
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface VectorItem {
  id: string;
  text: string;
  vector: number[];
}

/** Brute-force in-memory vector index; persists across sessions for as long as the object lives. */
export class InMemoryVectorStore {
  private readonly items = new Map<string, VectorItem>();

  get size(): number {
    return this.items.size;
  }

  add(items: VectorItem[]): void {
    for (const item of items) this.items.set(item.id, item);
  }

  search(
    vector: readonly number[],
    k: number,
    exclude: ReadonlySet<string> = new Set(),
  ): { item: VectorItem; score: number }[] {
    const scored: { item: VectorItem; score: number }[] = [];
    for (const item of this.items.values()) {
      if (!exclude.has(item.id)) scored.push({ item, score: cosine(vector, item.vector) });
    }
    scored.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
    return scored.slice(0, k);
  }
}
