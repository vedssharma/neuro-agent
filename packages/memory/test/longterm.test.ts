import { describe, expect, it } from "vitest";
import type { Message } from "@neuro-agent/core";
import {
  Bm25,
  exportJsonl,
  exportMarkdown,
  extractEntities,
  extractFacts,
  InMemoryBackend,
  indexOf,
  LongTermMemory,
  WorkingMemory,
  type EncodingEvent,
} from "@neuro-agent/memory";

const said = (
  session: string,
  text: string,
  who: EncodingEvent["who"] = "user",
): EncodingEvent => ({
  session,
  who,
  where: who,
  text,
});
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

describe("extraction", () => {
  it("finds statements and preferences", () => {
    expect(
      extractFacts(
        "Please remember: the code for locker 7 is 1234, and the code for locker 7 annex is 5678. I prefer tabs.",
      ),
    ).toEqual([
      {
        kind: "fact",
        subject: "code for locker 7",
        value: "1234",
        text: "the code for locker 7 is 1234",
      },
      {
        kind: "fact",
        subject: "code for locker 7 annex",
        value: "5678",
        text: "the code for locker 7 annex is 5678",
      },
      {
        kind: "preference",
        subject: "preference: tabs",
        value: "prefer",
        text: "the user prefers tabs",
      },
    ]);
    expect(extractFacts("What is the wifi password?")).toEqual([]);
  });

  it("finds entities: paths, codes, names and subject phrases", () => {
    const facts = extractFacts("the code for locker 7 in building north is 1234");
    expect(extractFacts("x")).toEqual([]);
    expect(
      extractEntities("Ask Priya to check src/app.ts and ticket AB-1234 today.", facts).sort(),
    ).toEqual(["ab-1234", "building north", "code", "locker 7", "priya", "src/app.ts"]);
  });

  it("indexes long text by its informative sentences", () => {
    const long = `${"Chatter about lunch. ".repeat(40)}The value of a.txt is 42. ${"More chatter. ".repeat(40)}`;
    expect(indexOf(long, 100)).toBe("The value of a.txt is 42.");
    expect(indexOf("short", 100)).toBe("short");
  });
});

describe("Bm25", () => {
  it("ranks rare matching terms first", () => {
    const bm = new Bm25();
    bm.set("a", "fact", "the code for locker 7 is 1234");
    bm.set("b", "fact", "the code for locker 8 is 4321");
    bm.set("c", "episode", "lunch notes");
    expect(bm.search("code for locker 7", 3).map((h) => h.id)).toEqual(["a", "b"]);
    bm.set("a", "fact", "replaced");
    expect(bm.search("locker 7", 3).map((h) => h.id)).toEqual(["b"]);
  });
});

describe("LongTermMemory", () => {
  it("gates unsalient events and writes episodes with facts and provenance", async () => {
    const memory = new LongTermMemory({ backend: new InMemoryBackend() });
    const result = await memory.encode([
      said("s1", "Lunch notes about the garden."),
      said("s1", "Please remember: the wifi password for the lab is QX-4821."),
      said("s1", "Lunch notes about the garden.", "assistant"),
      { ...said("s1", "Garden notes again."), attended: true },
    ]);
    expect(result.gated).toBe(2);
    expect(result.episodes.map((e) => e.index)).toEqual([
      "Please remember: the wifi password for the lab is QX-4821.",
      "Garden notes again.",
    ]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({
      subject: "wifi password for the lab",
      value: "QX-4821",
      episodes: [result.episodes[0]!.id],
      sessions: ["s1"],
    });
    const entity = await memory.backend.getEntity("wifi password");
    expect(entity?.facts).toEqual([result.facts[0]!.id]);
    expect(entity?.episodes).toEqual([result.episodes[0]!.id]);
  });

  it("supersedes contradicted facts, reinforces repeated ones, and ignores the assistant", async () => {
    const memory = new LongTermMemory({ backend: new InMemoryBackend() });
    await memory.encode([said("s1", "For the record, the deploy region is eu-west-2.")]);
    await memory.encode([said("s2", "The deploy region is eu-west-2, as before.")]);
    await memory.encode([said("s3", "The deploy region is ap-south-1.", "assistant")]);
    await memory.encode([said("s4", "Correction: the deploy region is now us-east-1.")]);
    const facts = await memory.backend.factsAbout("deploy region");
    expect(facts.map((f) => [f.value, f.supersededBy !== undefined, f.sessions])).toEqual([
      ["eu-west-2", true, ["s1", "s2"]],
      ["us-east-1", false, ["s4"]],
    ]);

    const recalled = await memory.recall("What is the deploy region?", { k: 4 });
    const text = recalled.map((r) => r.text).join("\n");
    expect(recalled[0]).toMatchObject({ kind: "fact", text: "the deploy region is us-east-1" });
    // Episodes whose facts were all superseded are left out too.
    expect(text).not.toContain("eu-west-2");
    const all = await memory.recall("What is the deploy region?", {
      k: 8,
      includeSuperseded: true,
    });
    expect(all.map((r) => r.text).join("\n")).toContain("eu-west-2");
  });

  it("separates near-duplicate episodes and recalls the right one", async () => {
    const memory = new LongTermMemory({ backend: new InMemoryBackend() });
    const { episodes } = await memory.encode([
      said("s1", "Building north: the code for locker 7 in building north is 1111."),
      said("s1", "Building south: the code for locker 7 in building south is 2222."),
    ]);
    expect(episodes[1]!.distinct).toBe(`unlike ${episodes[0]!.id}: south, 2222`);
    const hits = await memory.recall("What is the code for locker 7 in building south?", { k: 2 });
    expect(hits.map((h) => h.text).join("\n")).not.toContain("1111");
    expect(hits.map((h) => h.text)).toContain("the code for locker 7 in building south is 2222");
    expect(Object.keys(hits[0]!.ranks).sort()).toEqual(["graph", "lexical", "vector"]);
  });

  it("can leave out one session and switch channels off", async () => {
    const memory = new LongTermMemory({
      backend: new InMemoryBackend(),
      features: { semantic: false, lexical: false, graph: false },
    });
    await memory.encode([
      said("s1", "the budget code is BK-7710"),
      said("s2", "the budget code is BK-7710"),
    ]);
    const hits = await memory.recall("budget code", { excludeSession: "s2" });
    expect(hits.every((h) => h.kind === "episode")).toBe(true);
    expect(hits.map((h) => h.id)).toHaveLength(1);
    expect(Object.keys(hits[0]!.ranks)).toEqual(["vector"]);
  });

  it("exports to JSONL and Markdown", async () => {
    const memory = new LongTermMemory({ backend: new InMemoryBackend() });
    await memory.encode([
      said("s1", "the deploy region is eu-west-2"),
      said("s1", "the deploy region is us-east-1"),
    ]);
    const lines = (await exportJsonl(memory.backend))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["episode", "episode", "fact", "fact", "entity"]);
    const md = await exportMarkdown(memory.backend);
    expect(md).toContain("- the deploy region is us-east-1");
    expect(md).toContain("~~the deploy region is eu-west-2~~");
  });

  it("feeds working memory's activated region across sessions, oldest first", async () => {
    const longTerm = new LongTermMemory({ backend: new InMemoryBackend() });
    await new WorkingMemory({ budgetTokens: 1000, longTerm }).select([
      user("For the record, the deploy region is eu-west-2."),
    ]);
    await new WorkingMemory({ budgetTokens: 1000, longTerm }).select([
      user("Please remember: the budget code for the offsite is BK-7710."),
    ]);
    const selection = await new WorkingMemory({ budgetTokens: 1000, longTerm }).select([
      user("What is the deploy region and the budget code for the offsite?"),
    ]);
    const block = selection.messages[0]!.content[0]!;
    expect(block.type === "text" && block.text).toContain("Recalled from earlier sessions");
    const text = block.type === "text" ? block.text : "";
    expect(text).toContain("the deploy region is eu-west-2");
    expect(text.indexOf("eu-west-2")).toBeLessThan(text.indexOf("BK-7710"));
    expect(selection.retrieved?.some((r) => r.id.startsWith("f"))).toBe(true);
  });
});
