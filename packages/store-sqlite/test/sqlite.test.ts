import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportMarkdown, HashingEmbedder, LongTermMemory } from "@neuro-agent/memory";
import { SqliteBackend } from "@neuro-agent/store-sqlite";

const said = (session: string, text: string) => ({
  session,
  who: "user" as const,
  where: "user",
  text,
});

describe("SqliteBackend", () => {
  it("persists episodes, facts and entities across reopenings", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "neuro-sqlite-")), "nested", "memory.db");
    const first = new SqliteBackend({ path });
    const a = new LongTermMemory({ backend: first });
    await a.encode([
      said("s1", "For the record, the deploy region is eu-west-2."),
      said("s1", "Please remember: the code for locker 7 in building north is 1111."),
    ]);
    await first.close();

    const second = new SqliteBackend({ path });
    expect(await second.latestTime()).toBeGreaterThan(0);
    const b = new LongTermMemory({ backend: second });
    const { facts } = await b.encode([
      said("s2", "Correction: the deploy region is now us-east-1."),
    ]);
    // The clock continues where the file left off.
    expect(Number(facts[0]!.id.slice(1))).toBeGreaterThan(4);

    const [top] = await b.recall("What is the deploy region?");
    expect(top).toMatchObject({ kind: "fact", text: "the deploy region is us-east-1" });
    // Vectors were reloaded into the index on open.
    const [query] = await new HashingEmbedder().embed([
      "user\nthe code for locker 7 in building north",
    ]);
    const third = new SqliteBackend({ path });
    const [near] = await third.similar(query!, 1, "episode");
    expect(near?.id).toBe("e3");
    await third.close();
    expect(await exportMarkdown(second)).toContain("~~the deploy region is eu-west-2~~");
    expect((await second.getEntity("locker 7"))?.facts).toHaveLength(1);
    await second.close();
  });

  it("searches full text with BM25 and finds neighbours by vector", async () => {
    const backend = new SqliteBackend({ path: ":memory:" });
    const memory = new LongTermMemory({ backend, features: { graph: false, vector: false } });
    await memory.encode([
      said("s1", "the code for locker 7 is 1234"),
      said("s1", "the code for locker 8 is 4321"),
      said("s1", "lunch is at noon"),
    ]);
    const lexical = await backend.lexical("locker 7", 10);
    expect(lexical[0]!.score).toBeGreaterThan(lexical.at(-1)!.score);
    expect(lexical.some((h) => h.kind === "fact")).toBe(true);
    const hits = await memory.recall("code for locker 7", { k: 2 });
    expect(hits[0]!.text).toContain("1234");
    expect(await backend.lexical("...", 5)).toEqual([]);
    await backend.close();
  });
});
