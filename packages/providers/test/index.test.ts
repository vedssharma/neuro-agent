import { describe, expect, it } from "vitest";
import { PACKAGE } from "@neuro-agent/providers";

describe("@neuro-agent/providers", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("@neuro-agent/providers");
  });
});
