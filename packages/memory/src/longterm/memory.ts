import { HashingEmbedder, tokenize, type Embedder } from "../embedding.js";
import { salience } from "../text.js";
import type { MemoryBackend } from "./backend.js";
import { extractEntities, extractFacts, indexOf, subjectParts } from "./encode.js";
import type { Episode, Fact, Hit, MemoryEvent, RecordKind } from "./types.js";

/** Retrieval channels, each switchable for ablations. */
export interface RetrievalFeatures {
  /** Full-text (BM25) search. */
  lexical: boolean;
  /** Embedding similarity. */
  vector: boolean;
  /** Entities named in the query and their neighbourhood in the knowledge graph. */
  graph: boolean;
  /** Recall facts from the semantic store (off: episodes only). */
  semantic: boolean;
}

export interface LongTermMemoryOptions {
  backend: MemoryBackend;
  embedder?: Embedder;
  /** Episodes below this salience are not written unless attended or carrying a fact. Default 0.5. */
  minSalience?: number;
  /** Longest episode index, in characters. Default 400. */
  indexChars?: number;
  /** Episodes at least this similar to an earlier one get a note of what differs. Default 0.5. */
  separationThreshold?: number;
  /** A vector-only match needs at least this cosine similarity. Default 0.1. */
  minSimilarity?: number;
  features?: Partial<RetrievalFeatures>;
}

/** An event offered for encoding; `attended` events skip the salience gate. */
export interface EncodingEvent extends MemoryEvent {
  attended?: boolean;
}

export interface EncodeResult {
  episodes: Episode[];
  facts: Fact[];
  /** Events the salience gate turned away. */
  gated: number;
}

/** One item recalled from long-term memory. */
export interface Recollection {
  id: string;
  kind: RecordKind;
  /** Encoding time: sort by it to present recollections chronologically. */
  time: number;
  /** e.g. "fact", "user", "read_file(a.txt)". */
  label: string;
  text: string;
  /** Fused score (reciprocal-rank fusion over the retrieval channels). */
  score: number;
  /** 1-based rank in each channel that found it. */
  ranks: Partial<Record<"lexical" | "vector" | "graph", number>>;
}

export interface RecallOptions {
  k?: number;
  /** Leave out what only this session supplied (it is already in working memory). */
  excludeSession?: string;
  /** Include facts that a later statement replaced. */
  includeSuperseded?: boolean;
}

/** The port working memory uses to write to and read from long-term memory. */
export interface LongTermStore {
  encode(events: EncodingEvent[]): Promise<EncodeResult>;
  recall(query: string, options?: RecallOptions): Promise<Recollection[]>;
}

const DEFAULT_FEATURES: RetrievalFeatures = {
  lexical: true,
  vector: true,
  graph: true,
  semantic: true,
};
const RRF_K = 60;
const CHANNEL_DEPTH = 30;

/**
 * Long-term memory v1 (Phase 4): an episodic store written fast and
 * append-mostly, and a semantic store of facts and preferences linked into a
 * knowledge graph with provenance back to the episodes that support them.
 *
 * Encoding: event → candidate episode and facts → salience gate → write.
 * Retrieval: lexical, embedding and graph-neighbourhood channels fused by
 * reciprocal rank; superseded facts are left out unless asked for.
 */
export class LongTermMemory implements LongTermStore {
  readonly features: RetrievalFeatures;
  private readonly embedder: Embedder;
  private clock: number | undefined;
  private entityCache: Map<string, { facts: string[]; episodes: string[] }> | undefined;

  constructor(private readonly options: LongTermMemoryOptions) {
    this.embedder = options.embedder ?? new HashingEmbedder();
    this.features = { ...DEFAULT_FEATURES, ...options.features };
  }

  get backend(): MemoryBackend {
    return this.options.backend;
  }

  private async tick(): Promise<number> {
    this.clock ??= await this.backend.latestTime();
    return ++this.clock;
  }

  async encode(events: EncodingEvent[]): Promise<EncodeResult> {
    const result: EncodeResult = { episodes: [], facts: [], gated: 0 };
    for (const event of events) {
      const text = event.text.trim();
      if (!text) continue;
      // Assistant statements are recorded as episodes but never become facts:
      // the model repeating (or misremembering) a value is not evidence for it.
      const candidates = event.who === "assistant" ? [] : extractFacts(text);
      const score = salience(text);
      const gate = this.options.minSalience ?? 0.5;
      if (!event.attended && candidates.length === 0 && score < gate && !event.outcome) {
        result.gated++;
        continue;
      }

      const time = await this.tick();
      const index = indexOf(text, this.options.indexChars ?? 400);
      const [vector] = await this.embedder.embed([`${event.where}\n${index}`]);
      const episode: Episode = {
        id: `e${time}`,
        time,
        session: event.session,
        who: event.who,
        where: event.where,
        index,
        entities: extractEntities(text, candidates),
        facts: [],
        salience: score,
        ...(index !== text ? { artifact: text } : {}),
        ...(event.outcome ? { outcome: event.outcome } : {}),
      };

      // Pattern separation: note what distinguishes a near-duplicate episode.
      const [nearest] = await this.backend.similar(vector!, 1, "episode");
      if (nearest && nearest.score >= (this.options.separationThreshold ?? 0.5)) {
        const other = await this.backend.getEpisode(nearest.id);
        if (other && other.index !== episode.index) {
          const seen = new Set(tokenize(`${other.where} ${other.index}`));
          const novel = [...new Set(tokenize(`${episode.where} ${episode.index}`))].filter(
            (w) => !seen.has(w),
          );
          if (novel.length > 0)
            episode.distinct = `unlike ${other.id}: ${novel.slice(0, 8).join(", ")}`;
        }
      }
      await this.backend.putEpisode(episode, vector!);
      result.episodes.push(episode);

      const facts: Fact[] = [];
      for (const candidate of candidates) facts.push(await this.writeFact(candidate, episode));
      result.facts.push(...facts);
      if (facts.length > 0) {
        episode.facts = facts.map((f) => f.id);
        await this.backend.putEpisode(episode, vector!);
      }
      await this.link(episode, facts);
    }
    return result;
  }

  private async writeFact(
    candidate: ReturnType<typeof extractFacts>[number],
    episode: Episode,
  ): Promise<Fact> {
    const existing = (await this.backend.factsAbout(candidate.subject)).filter(
      (f) => !f.supersededBy,
    );
    const same = existing.find((f) => f.value.toLowerCase() === candidate.value.toLowerCase());
    if (same) {
      // Reinforced: one more supporting episode.
      same.episodes.push(episode.id);
      same.time = episode.time;
      if (!same.sessions.includes(episode.session)) same.sessions.push(episode.session);
      await this.backend.putFact(same, await this.vectorOf(same.text));
      return same;
    }
    const time = await this.tick();
    const fact: Fact = {
      id: `f${time}`,
      kind: candidate.kind,
      subject: candidate.subject,
      value: candidate.value,
      text: candidate.text,
      time,
      episodes: [episode.id],
      sessions: [episode.session],
    };
    for (const old of existing) {
      // Contradiction: the newer statement wins; the old one is kept, marked superseded.
      old.supersededBy = fact.id;
      fact.supersedes = old.id;
      await this.backend.putFact(old, await this.vectorOf(old.text));
    }
    await this.backend.putFact(fact, await this.vectorOf(fact.text));
    return fact;
  }

  private async vectorOf(text: string): Promise<number[]> {
    const [v] = await this.embedder.embed([text]);
    return v!;
  }

  /** Adds graph edges: entity → episode, entity → fact. */
  private async link(episode: Episode, facts: Fact[]): Promise<void> {
    const touched = new Map<string, Set<string>>();
    const add = (name: string, id: string) => {
      if (!touched.has(name)) touched.set(name, new Set());
      touched.get(name)!.add(id);
    };
    for (const name of episode.entities) add(name, episode.id);
    for (const fact of facts) for (const part of subjectParts(fact.subject)) add(part, fact.id);
    for (const [name, ids] of touched) {
      const entity = (await this.backend.getEntity(name)) ?? { name, facts: [], episodes: [] };
      for (const id of ids) {
        const list = id.startsWith("f") ? entity.facts : entity.episodes;
        if (!list.includes(id)) list.push(id);
      }
      await this.backend.putEntity(entity);
      this.entityCache?.set(name, { facts: entity.facts, episodes: entity.episodes });
    }
  }

  private async entities(): Promise<Map<string, { facts: string[]; episodes: string[] }>> {
    if (!this.entityCache) {
      this.entityCache = new Map(
        (await this.backend.entities()).map((e) => [
          e.name,
          { facts: e.facts, episodes: e.episodes },
        ]),
      );
    }
    return this.entityCache;
  }

  /** Graph channel: entities named in the query, their records, and one hop beyond (at half weight). */
  private async graphHits(query: string): Promise<Hit[]> {
    const q = ` ${tokenize(query).join(" ")} `;
    const entities = await this.entities();
    const weights = new Map<string, number>();
    const add = (id: string, w: number) => weights.set(id, (weights.get(id) ?? 0) + w);
    const matched: string[] = [];
    for (const [name, links] of entities) {
      const words = tokenize(name).join(" ");
      if (!words || !q.includes(` ${words} `)) continue;
      matched.push(name);
      // Rare entities say more than common ones.
      const w = 1 / Math.log(2 + links.facts.length + links.episodes.length);
      for (const id of [...links.facts, ...links.episodes]) add(id, w);
    }
    if (matched.length > 0) {
      const direct = [...weights.keys()].filter((id) => id.startsWith("e"));
      const hop = new Set<string>();
      for (const id of direct.slice(0, 10)) {
        const episode = await this.backend.getEpisode(id);
        for (const name of episode?.entities ?? []) if (!matched.includes(name)) hop.add(name);
      }
      for (const name of hop) {
        const links = entities.get(name);
        if (!links) continue;
        const w = 0.5 / Math.log(2 + links.facts.length + links.episodes.length);
        for (const id of links.facts) add(id, w);
      }
    }
    return [...weights]
      .map(([id, score]) => ({
        id,
        kind: (id.startsWith("f") ? "fact" : "episode") as RecordKind,
        score,
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, CHANNEL_DEPTH);
  }

  /** True when every fact an episode stated has since been superseded. */
  private async outdated(episode: Episode): Promise<boolean> {
    if (episode.facts.length === 0) return false;
    for (const id of episode.facts) {
      const fact = await this.backend.getFact(id);
      if (!fact?.supersededBy) return false;
    }
    return true;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<Recollection[]> {
    const k = options.k ?? 4;
    const channels: ["lexical" | "vector" | "graph", Hit[]][] = [];
    if (this.features.lexical)
      channels.push(["lexical", await this.backend.lexical(query, CHANNEL_DEPTH)]);
    if (this.features.vector) {
      const minSimilarity = this.options.minSimilarity ?? 0.1;
      const hits = await this.backend.similar(await this.vectorOf(query), CHANNEL_DEPTH);
      channels.push(["vector", hits.filter((h) => h.score >= minSimilarity)]);
    }
    if (this.features.graph) channels.push(["graph", await this.graphHits(query)]);

    const fused = new Map<
      string,
      { kind: RecordKind; score: number; ranks: Recollection["ranks"] }
    >();
    for (const [channel, hits] of channels) {
      hits.forEach((hit, i) => {
        const entry = fused.get(hit.id) ?? { kind: hit.kind, score: 0, ranks: {} };
        entry.score += 1 / (RRF_K + i + 1);
        entry.ranks[channel] = i + 1;
        fused.set(hit.id, entry);
      });
    }

    const ranked = [...fused].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
    const out: Recollection[] = [];
    for (const [id, entry] of ranked) {
      if (out.length >= k) break;
      if (entry.kind === "fact") {
        if (!this.features.semantic) continue;
        const fact = await this.backend.getFact(id);
        if (!fact || (fact.supersededBy && !options.includeSuperseded)) continue;
        if (options.excludeSession && fact.sessions.every((s) => s === options.excludeSession))
          continue;
        out.push({
          id,
          kind: "fact",
          time: fact.time,
          label: fact.kind,
          text: fact.text,
          score: entry.score,
          ranks: entry.ranks,
        });
      } else {
        const episode = await this.backend.getEpisode(id);
        if (!episode || episode.session === options.excludeSession) continue;
        if (!options.includeSuperseded && (await this.outdated(episode))) continue;
        out.push({
          id,
          kind: "episode",
          time: episode.time,
          label: episode.where,
          text: episode.index,
          score: entry.score,
          ranks: entry.ranks,
        });
      }
    }
    return out;
  }
}
