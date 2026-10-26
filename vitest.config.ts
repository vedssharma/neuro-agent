import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

// Tests run against source, so no build step is needed before `pnpm test`.
export default defineConfig({
  resolve: {
    alias: {
      "@neuro-agent/core": src("core"),
      "@neuro-agent/memory": src("memory"),
      "@neuro-agent/store-sqlite": src("store-sqlite"),
      "@neuro-agent/providers": src("providers"),
      "@neuro-agent/tools": src("tools"),
      "@neuro-agent/eval": src("eval"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
