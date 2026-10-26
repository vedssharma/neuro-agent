import type { MemoryBackend } from "./backend.js";

/** One JSON object per line: every episode, fact and entity, in that order. */
export async function exportJsonl(backend: MemoryBackend): Promise<string> {
  const lines: string[] = [];
  for (const e of await backend.episodes()) lines.push(JSON.stringify({ type: "episode", ...e }));
  for (const f of await backend.facts()) lines.push(JSON.stringify({ type: "fact", ...f }));
  for (const n of await backend.entities()) lines.push(JSON.stringify({ type: "entity", ...n }));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** A human-readable dump: current facts, superseded facts, then episodes. */
export async function exportMarkdown(backend: MemoryBackend): Promise<string> {
  const episodes = (await backend.episodes()).sort((a, b) => a.time - b.time);
  const facts = (await backend.facts()).sort((a, b) => a.time - b.time);
  const current = facts.filter((f) => !f.supersededBy);
  const replaced = facts.filter((f) => f.supersededBy);
  const out = ["# Memory", ""];
  out.push(
    `${episodes.length} episodes · ${current.length} current facts · ${replaced.length} superseded`,
    "",
  );
  out.push("## Facts", "");
  for (const f of current) out.push(`- ${f.text} _(${f.id}; from ${f.episodes.join(", ")})_`);
  if (replaced.length > 0) {
    out.push("", "## Superseded", "");
    for (const f of replaced)
      out.push(`- ~~${f.text}~~ _(${f.id}; replaced by ${f.supersededBy})_`);
  }
  out.push("", "## Episodes", "");
  for (const e of episodes) {
    const index = e.index.replace(/\s+/g, " ");
    out.push(`- **${e.id}** · session ${e.session} · ${e.who} · ${e.where}: ${index}`);
  }
  return `${out.join("\n")}\n`;
}
