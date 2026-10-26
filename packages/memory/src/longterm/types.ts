/** Who produced an event. */
export type Actor = "user" | "assistant" | "tool";

/** Something that happened, offered to long-term memory for encoding. */
export interface MemoryEvent {
  /** Session the event belongs to. */
  session: string;
  who: Actor;
  /** Where it happened: a tool call such as read_file(src/a.ts), or the role. */
  where: string;
  text: string;
  /** Optional outcome, e.g. "error". */
  outcome?: string;
}

/** An episodic memory: one event, with a compact index pointing at its full artifact. */
export interface Episode {
  /** e1, e2, … */
  id: string;
  /** Global, monotonic encoding order. */
  time: number;
  session: string;
  who: Actor;
  where: string;
  /** Compact index: the event's most informative sentences. */
  index: string;
  /** The full text, when it is longer than the index. */
  artifact?: string;
  entities: string[];
  /** Facts this episode stated (filled in after they are written). */
  facts: string[];
  /** Pattern separation: what tells this episode apart from its nearest neighbour. */
  distinct?: string;
  salience: number;
  outcome?: string;
}

export type FactKind = "fact" | "preference";

/** A semantic memory: a subject/value statement with provenance. */
export interface Fact {
  /** f1, f2, … */
  id: string;
  kind: FactKind;
  /** Normalized subject, e.g. "deploy region for the api". */
  subject: string;
  value: string;
  /** The statement as it will be shown, e.g. "the deploy region for the api is eu-west-2". */
  text: string;
  /** Time of the latest supporting episode. */
  time: number;
  /** Supporting episodes (provenance), oldest first. */
  episodes: string[];
  /** Sessions those episodes came from. */
  sessions: string[];
  supersedes?: string;
  supersededBy?: string;
}

/** A node in the knowledge graph; facts and episodes link to it by name. */
export interface Entity {
  /** Normalized name; also the id. */
  name: string;
  facts: string[];
  episodes: string[];
}

export type RecordKind = "episode" | "fact";

export interface Hit {
  id: string;
  kind: RecordKind;
  score: number;
}
