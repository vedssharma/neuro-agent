import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "@neuro-agent/core";
import { run } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("cli", () => {
  it("prints the version", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(run(["--version"])).toBe(0);
    expect(log).toHaveBeenCalledWith(VERSION);
  });
});
