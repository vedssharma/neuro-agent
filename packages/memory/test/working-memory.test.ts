import { describe, expect, it } from "vitest";
import type { Message } from "@neuro-agent/core";
import { InMemoryVectorStore, salience, WorkingMemory } from "@neuro-agent/memory";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const call = (id: string, path: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_call", id, name: "read_file", input: { path } }],
});
const result = (id: string, content: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", toolCallId: id, content, isError: false }],
});
const filler = (n: number) => "Lunch notes about the garden and the weather. ".repeat(n);
const allText = (messages: Message[]) =>
  messages
    .flatMap((m) =>
      m.content.map((b) =>
        b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "",
      ),
    )
    .join("\n");

/** A conversation: one fact, then many filler turns, then a question. */
function conversation(fillers: number): Message[] {
  const t: Message[] = [
    user("Please remember this: the wifi password is QX-4821."),
    assistant("Noted."),
  ];
  for (let i = 0; i < fillers; i++) t.push(user(`Background: ${filler(40)}`), assistant("Noted."));
  t.push(user("What is the wifi password?"));
  return t;
}

describe("salience", () => {
  it("scores numbers, statements and explicit cues above chatter", () => {
    expect(salience("Please remember this: the code is 4821.")).toBe(1);
    expect(salience("Lunch notes about the garden.")).toBe(0);
  });
});

describe("WorkingMemory", () => {
  it("keeps a relevant old fact in focus within the budget", async () => {
    const wm = new WorkingMemory({ budgetTokens: 1000 });
    const transcript = conversation(30);
    const selection = await wm.select(transcript);
    const text = allText(selection.messages);
    expect(text).toContain("<working-memory>");
    expect(text).toContain("the wifi password is QX-4821");
    expect(selection.estimatedTokens).toBeLessThanOrEqual(1000);
    expect(selection.dropped).toBeGreaterThan(0);
    expect(selection.rewritten).toBe(true);
    expect(selection.retrieved?.some((r) => r.text.includes("QX-4821"))).toBe(true);
    // The current request stays last, verbatim.
    expect(selection.messages.at(-1)).toEqual(transcript.at(-1));
  });

  it("loses the fact when the attention gate is replaced by recency", async () => {
    const wm = new WorkingMemory({ budgetTokens: 1000, features: { attention: false } });
    const selection = await wm.select(conversation(30));
    expect(allText(selection.messages)).not.toContain("QX-4821");
  });

  it("compresses older tool outputs in the current turn to goal-relevant sentences", async () => {
    const transcript: Message[] = [user("Compute the total of the values of a.txt, b.txt, c.txt.")];
    for (const [i, name] of ["a.txt", "b.txt", "c.txt"].entries()) {
      transcript.push(
        call(`k${i}`, name),
        result(`k${i}`, `${filler(60)}\nThe value of ${name} is ${i + 10}.\n${filler(60)}`),
      );
    }
    const wm = new WorkingMemory({ budgetTokens: 3000 });
    const selection = await wm.select(transcript);
    const results = selection.messages.flatMap((m) =>
      m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])),
    );
    expect(results).toHaveLength(3);
    expect(results[0]).toMatch(/^\[c\d+ · read_file\(a\.txt\) · [\d,]+ tokens, compressed/);
    expect(results[0]).toContain("The value of a.txt is 10.");
    expect(results[0]!.length).toBeLessThan(400);
    expect(results[1]).toContain("The value of b.txt is 11.");
    // The newest output is kept raw.
    expect(results[2]).toContain(filler(1).trim());
    expect(selection.dropped).toBe(0);

    const raw = await new WorkingMemory({
      budgetTokens: 3000,
      features: { chunking: false },
    }).select(transcript);
    expect(raw.estimatedTokens).toBeGreaterThan(selection.estimatedTokens * 2);
  });

  it("recalls promoted chunks from an earlier session, newest last", async () => {
    const store = new InMemoryVectorStore();
    const first = new WorkingMemory({ budgetTokens: 1000, store });
    await first.select([
      user("For the record, the deploy region is eu-west-2."),
      assistant("Noted."),
      user("Correction, I changed my mind: the deploy region is now us-east-1."),
    ]);
    expect(store.size).toBeGreaterThanOrEqual(2);

    const second = new WorkingMemory({ budgetTokens: 1000, store });
    const selection = await second.select([user("What is the deploy region?")]);
    const text = allText(selection.messages);
    expect(text).toContain("Recalled from earlier sessions");
    expect(text.indexOf("eu-west-2")).toBeLessThan(text.indexOf("us-east-1"));

    const off = new WorkingMemory({ budgetTokens: 1000, store, features: { activation: false } });
    expect(
      allText((await off.select([user("What is the deploy region?")])).messages),
    ).not.toContain("us-east-1");
  });

  it("drops the activated region before the focus region as the budget shrinks", async () => {
    const store = new InMemoryVectorStore();
    await new WorkingMemory({ budgetTokens: 1000, store }).select([
      user("Keep in mind: the budget code for the offsite is BK-7710."),
    ]);
    const transcript = conversation(10);
    transcript.splice(
      -1,
      1,
      user("What is the wifi password and the budget code for the offsite?"),
    );
    const big = await new WorkingMemory({ budgetTokens: 400, store }).select(transcript);
    expect(allText(big.messages)).toContain("BK-7710");
    expect(allText(big.messages)).toContain("QX-4821");

    const small = await new WorkingMemory({ budgetTokens: 175, store }).select(transcript);
    expect(allText(small.messages)).toContain("QX-4821");
    expect(allText(small.messages)).not.toContain("BK-7710");
    expect(small.estimatedTokens).toBeLessThanOrEqual(175);
  });

  it("refreshes rehearsed chunks and forgets unattended chatter", async () => {
    const wm = new WorkingMemory({ budgetTokens: 1000, sensoryChunks: 6 });
    const transcript = conversation(12);
    await wm.select(transcript);
    const fact = wm.held.find((c) => c.text.includes("QX-4821"));
    expect(fact?.rehearsal).toBe(1);
    expect(fact?.promoted).toBe(true);
    expect(wm.held.length).toBeLessThan(10);

    transcript.push(assistant("The wifi password is QX-4821."), user(`Background: ${filler(40)}`));
    await wm.select(transcript);
    expect(fact!.rehearsal).toBeLessThan(1);
  });
});
