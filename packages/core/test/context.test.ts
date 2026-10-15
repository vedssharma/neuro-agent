import { describe, expect, it } from "vitest";
import { estimateTokens, FullTranscript, SlidingWindow, type Message } from "@neuro-agent/core";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const call = (id: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_call", id, name: "t", input: {} }],
});
const result = (id: string, content = "ok"): Message => ({
  role: "user",
  content: [{ type: "tool_result", toolCallId: id, content, isError: false }],
});

describe("estimateTokens", () => {
  it("is roughly chars / 4 plus overhead", () => {
    expect(estimateTokens(user("x".repeat(400)))).toBe(104);
  });
});

describe("FullTranscript", () => {
  it("keeps everything", () => {
    const t = [user("a"), assistant("b")];
    expect(new FullTranscript().select(t)).toMatchObject({ messages: t, dropped: 0 });
  });
});

describe("SlidingWindow", () => {
  it("keeps everything that fits", () => {
    const t = [user("a"), assistant("b"), user("c")];
    expect(new SlidingWindow(1000).select(t).dropped).toBe(0);
  });

  it("drops oldest whole turns and starts at a user turn", () => {
    const big = "x".repeat(400); // ~104 tokens each
    const t = [user(big), assistant(big), user(big), assistant(big), user("latest")];
    const sel = new SlidingWindow(250).select(t);
    expect(sel.dropped).toBe(2);
    expect(sel.messages[0]).toEqual(t[2]);
    expect(sel.estimatedTokens).toBeLessThanOrEqual(250);
  });

  it("never splits a tool call from its result", () => {
    const big = "x".repeat(400);
    const t = [
      user("task"),
      call("1"),
      result("1", big),
      call("2"),
      result("2", big),
      assistant("done"),
    ];
    // Budget fits the tail but would start at a tool_result; the cut must move to a turn start.
    const sel = new SlidingWindow(150).select(t);
    expect(sel.messages[0]?.role).toBe("user");
    expect(sel.messages[0]?.content.every((b) => b.type !== "tool_result")).toBe(true);
    // Only one turn exists, so it is kept whole even though it is over budget.
    expect(sel.dropped).toBe(0);
  });

  it("keeps the latest turn whole when it alone exceeds the budget", () => {
    const t = [user("old"), assistant("old"), user("x".repeat(4000))];
    const sel = new SlidingWindow(10).select(t);
    expect(sel.messages).toEqual([t[2]]);
    expect(sel.dropped).toBe(2);
  });

  it("rejects a non-positive budget", () => {
    expect(() => new SlidingWindow(0)).toThrow(RangeError);
  });
});
