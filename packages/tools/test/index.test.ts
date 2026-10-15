import { describe, expect, it } from "vitest";
import { PACKAGE } from "@neuro-agent/tools";

describe("@neuro-agent/tools", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("@neuro-agent/tools");
  });
});
