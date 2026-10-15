import { VERSION } from "@neuro-agent/core";

export function run(argv: string[]): number {
  const [cmd] = argv;
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  console.log(
    `neuro-agent ${VERSION}\n\nUsage: neuro [--version]\n\nThe agent loop arrives in Phase 1 (see ROADMAP.md).`,
  );
  return 0;
}
