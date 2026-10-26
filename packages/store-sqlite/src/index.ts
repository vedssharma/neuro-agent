import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  BruteForceIndex,
  episodeSearchText,
  factSearchText,
  tokenize,
  type Entity,
  type Episode,
  type Fact,
  type Hit,
  type MemoryBackend,
  type RecordKind,
  type VectorIndex,
} from "@neuro-agent/memory";

export interface SqliteBackendOptions {
  /** Database file, or ":memory:". Parent directories are created. */
  path: string;
  /** Vector index; vectors are persisted in the database and loaded into it on open. */
  index?: VectorIndex;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, time INTEGER NOT NULL, session TEXT NOT NULL, data TEXT NOT NULL, vector BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, time INTEGER NOT NULL, subject TEXT NOT NULL, data TEXT NOT NULL, vector BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS facts_subject ON facts (subject);
CREATE TABLE IF NOT EXISTS entities (name TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5 (id UNINDEXED, kind UNINDEXED, body);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', '1');
`;

const toBlob = (v: readonly number[]) => Buffer.from(new Float32Array(v).buffer);
const fromBlob = (b: Buffer) =>
  Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));

/**
 * Long-term memory in one SQLite file: episodes, facts and entities as JSON
 * rows, full-text search with FTS5 (BM25), and embeddings stored alongside
 * for the vector index.
 */
export class SqliteBackend implements MemoryBackend {
  readonly db: Database.Database;
  private readonly index: VectorIndex;

  constructor(options: SqliteBackendOptions) {
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.db = new Database(options.path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.index = options.index ?? new BruteForceIndex();
    for (const row of this.db.prepare("SELECT id, vector FROM episodes").all() as {
      id: string;
      vector: Buffer;
    }[])
      this.index.add(row.id, "episode", fromBlob(row.vector));
    for (const row of this.db.prepare("SELECT id, vector FROM facts").all() as {
      id: string;
      vector: Buffer;
    }[])
      this.index.add(row.id, "fact", fromBlob(row.vector));
  }

  private indexText(id: string, kind: RecordKind, body: string): void {
    this.db.prepare("DELETE FROM search WHERE id = ?").run(id);
    this.db.prepare("INSERT INTO search (id, kind, body) VALUES (?, ?, ?)").run(id, kind, body);
  }

  async putEpisode(episode: Episode, vector: readonly number[]): Promise<void> {
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO episodes (id, time, session, data, vector) VALUES (?, ?, ?, ?, ?)",
        )
        .run(episode.id, episode.time, episode.session, JSON.stringify(episode), toBlob(vector));
      this.indexText(episode.id, "episode", episodeSearchText(episode));
    })();
    this.index.add(episode.id, "episode", vector);
  }

  async putFact(fact: Fact, vector: readonly number[]): Promise<void> {
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO facts (id, time, subject, data, vector) VALUES (?, ?, ?, ?, ?)",
        )
        .run(fact.id, fact.time, fact.subject, JSON.stringify(fact), toBlob(vector));
      this.indexText(fact.id, "fact", factSearchText(fact));
    })();
    this.index.add(fact.id, "fact", vector);
  }

  async putEntity(entity: Entity): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO entities (name, data) VALUES (?, ?)")
      .run(entity.name, JSON.stringify(entity));
  }

  private one<T>(sql: string, key: string): T | undefined {
    const row = this.db.prepare(sql).get(key) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  private many<T>(sql: string, ...params: unknown[]): T[] {
    return (this.db.prepare(sql).all(...params) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as T,
    );
  }

  async getEpisode(id: string) {
    return this.one<Episode>("SELECT data FROM episodes WHERE id = ?", id);
  }

  async getFact(id: string) {
    return this.one<Fact>("SELECT data FROM facts WHERE id = ?", id);
  }

  async getEntity(name: string) {
    return this.one<Entity>("SELECT data FROM entities WHERE name = ?", name);
  }

  async factsAbout(subject: string) {
    return this.many<Fact>("SELECT data FROM facts WHERE subject = ? ORDER BY time", subject);
  }

  async episodes() {
    return this.many<Episode>("SELECT data FROM episodes ORDER BY time");
  }

  async facts() {
    return this.many<Fact>("SELECT data FROM facts ORDER BY time");
  }

  async entities() {
    return this.many<Entity>("SELECT data FROM entities ORDER BY name");
  }

  async lexical(query: string, k: number): Promise<Hit[]> {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"`).join(" OR ");
    const rows = this.db
      .prepare(
        "SELECT id, kind, bm25(search) AS rank FROM search WHERE search MATCH ? ORDER BY rank, id LIMIT ?",
      )
      .all(match, k) as { id: string; kind: RecordKind; rank: number }[];
    return rows.map((r) => ({ id: r.id, kind: r.kind, score: -r.rank }));
  }

  async similar(vector: readonly number[], k: number, kind?: RecordKind) {
    return this.index.search(vector, k, kind);
  }

  async latestTime(): Promise<number> {
    const row = this.db
      .prepare(
        "SELECT MAX(t) AS t FROM (SELECT MAX(time) AS t FROM episodes UNION ALL SELECT MAX(time) FROM facts)",
      )
      .get() as { t: number | null };
    return row.t ?? 0;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
