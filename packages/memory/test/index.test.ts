import { describe, expect, it } from "vitest";
import { PACKAGE } from "@neuro-agent/memory";

describe("@neuro-agent/memory", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("@neuro-agent/memory");
  });
});
