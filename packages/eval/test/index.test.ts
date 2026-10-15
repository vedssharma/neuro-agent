import { describe, expect, it } from "vitest";
import { PACKAGE } from "@neuro-agent/eval";

describe("@neuro-agent/eval", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("@neuro-agent/eval");
  });
});
