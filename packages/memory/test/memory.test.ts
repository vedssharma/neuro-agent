import { describe, expect, it } from "vitest";
import type { Message } from "@neuro-agent/core";
import {
  cosine,
  extractiveSummarizer,
  HashingEmbedder,
  InMemoryVectorStore,
  llmSummarizer,
  messageText,
  SummaryBuffer,
  VectorRag,
} from "@neuro-agent/memory";
import { ScriptedProvider } from "@neuro-agent/providers";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const pad = (n: number) => "lorem ipsum dolor ".repeat(n);

describe("HashingEmbedder", () => {
  it("is deterministic, normalized, and ranks related text higher", async () => {
    const e = new HashingEmbedder(256);
    const [a, b, c, a2] = await e.embed([
      "the wifi password for the lab",
      "lab wifi password changed",
      "lunch menu on friday",
      "the wifi password for the lab",
    ]);
    expect(a).toEqual(a2);
    expect(Math.hypot(...a!)).toBeCloseTo(1);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  });

  it("returns a zero vector for empty text", async () => {
    const [v] = await new HashingEmbedder(8).embed(["the of and"]);
    expect(v).toEqual(new Array(8).fill(0));
  });
});

describe("InMemoryVectorStore", () => {
  it("searches by cosine, best first, with exclusions", () => {
    const store = new InMemoryVectorStore();
    store.add([
      { id: "a", text: "a", vector: [1, 0] },
      { id: "b", text: "b", vector: [0.6, 0.8] },
      { id: "c", text: "c", vector: [0, 1] },
    ]);
    expect(store.search([1, 0], 2).map((h) => h.item.id)).toEqual(["a", "b"]);
    expect(store.search([1, 0], 2, new Set(["a"])).map((h) => h.item.id)).toEqual(["b", "c"]);
    expect(store.size).toBe(3);
  });
});

describe("summarizers", () => {
  it("extractive: keeps informative sentences, newest first within budget", async () => {
    const s = extractiveSummarizer({ maxTokens: 14 });
    const out = await s("", [
      user("Hello there friend. The room is B12. Nothing much else to say here."),
      user("Weather looks nice. The code is 4821; the other code is 9999."),
    ]);
    expect(out.split("\n")).toEqual(["The code is 4821;", "the other code is 9999."]);
    expect(await s("", [user("The room is B12.")])).toBe("The room is B12.");
  });

  it("llm: sends previous summary and evicted messages, returns the reply", async () => {
    const provider = new ScriptedProvider([
      { content: [{ type: "text", text: " new summary " }], usage: { inputTokens: 5 } },
    ]);
    const seen: number[] = [];
    const s = llmSummarizer({
      provider,
      model: "m",
      maxTokens: 100,
      onUsage: (u) => seen.push(u.inputTokens),
    });
    expect(await s("old", [user("fact A"), assistant("ok")])).toBe("new summary");
    const prompt = messageText(provider.requests[0]!.messages[0]!);
    expect(prompt).toContain("<summary>\nold\n</summary>");
    expect(prompt).toContain("USER: fact A\n\nASSISTANT: ok");
    expect(seen).toEqual([5]);
  });
});

describe("SummaryBuffer", () => {
  it("summarizes what slid out of the window and prepends it", async () => {
    const calls: number[] = [];
    const strategy = new SummaryBuffer({
      windowTokens: 60,
      summarizer: async (prev, evicted) => {
        calls.push(evicted.length);
        return [prev, ...evicted.map(messageText)].filter(Boolean).join(" | ").slice(0, 40);
      },
    });
    const t: Message[] = [
      user(`first ${pad(5)}`),
      assistant("a1"),
      user(`second ${pad(5)}`),
      assistant("a2"),
      user("third"),
    ];
    const sel = await strategy.select(t);
    expect(sel.dropped).toBeGreaterThan(0);
    expect(sel.rewritten).toBe(true);
    const first = sel.messages[0]!;
    expect(first.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^Summary of the earlier conversation:\nfirst/),
    });
    // Summarized once; selecting again summarizes nothing new.
    await strategy.select(t);
    expect(calls).toHaveLength(1);
    expect(t[0]!.content).toHaveLength(1); // transcript untouched
  });

  it("passes through when nothing was dropped", async () => {
    const strategy = new SummaryBuffer({ windowTokens: 1000, summarizer: async () => "x" });
    const sel = await strategy.select([user("hi")]);
    expect(sel).toMatchObject({ dropped: 0 });
    expect(sel.rewritten).toBeUndefined();
  });
});

describe("VectorRag", () => {
  it("recalls messages from an earlier session sharing the store", async () => {
    const store = new InMemoryVectorStore();
    const embedder = new HashingEmbedder();
    const s1 = new VectorRag({ store, embedder, windowTokens: 1000, topK: 2 });
    await s1.select([
      user("Remember: the wifi password for the lab is KX-1234."),
      assistant("Noted."),
      user("Unrelated lunch plans."),
    ]);
    expect(store.size).toBe(3);

    const s2 = new VectorRag({ store, embedder, windowTokens: 1000, topK: 1 });
    const sel = await s2.select([user("What is the wifi password for the lab?")]);
    expect(sel.retrieved).toEqual([
      {
        id: expect.any(String),
        score: expect.any(Number),
        text: "Remember: the wifi password for the lab is KX-1234.",
      },
    ]);
    expect(sel.rewritten).toBe(true);
    expect(messageText(sel.messages[0]!)).toMatch(
      /memories[\s\S]*KX-1234[\s\S]*What is the wifi password/,
    );
  });

  it("does not recall what is already in the window", async () => {
    const store = new InMemoryVectorStore();
    const rag = new VectorRag({ store, embedder: new HashingEmbedder(), windowTokens: 1000 });
    const sel = await rag.select([
      user("the code is 1"),
      assistant("ok"),
      user("what is the code?"),
    ]);
    expect(sel.retrieved).toBeUndefined();
    expect(sel.rewritten).toBeUndefined();
  });
});
