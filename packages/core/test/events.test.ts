import { describe, expect, it } from "vitest";
import { AgentEventSchema, createEvent, VERSION } from "@neuro-agent/core";

describe("core", () => {
  it("exposes a semver version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("creates valid, timestamped events", () => {
    const e = createEvent(
      { type: "message.user", sessionId: "s1", payload: { text: "hi" } },
      () => 42,
    );
    expect(AgentEventSchema.parse(e)).toEqual(e);
    expect(e.timestamp).toBe(42);
  });

  it("rejects malformed events", () => {
    expect(() => createEvent({ type: "", sessionId: "s1", payload: {} })).toThrow();
  });
});
