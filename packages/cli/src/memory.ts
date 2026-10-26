import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { exportJsonl, exportMarkdown, LongTermMemory } from "@neuro-agent/memory";
import { SqliteBackend } from "@neuro-agent/store-sqlite";
import type { CommandIO } from "./eval.js";

export const MEMORY_USAGE = `Usage: neuro memory <command> [options]

Inspect the long-term memory a session started with --memory wrote.

Commands:
  stats                     count episodes, facts and entities
  search <query>            show what recall returns for a query, with each channel's rank
  export [--format md|jsonl]  print everything (default: md)

Options:
      --db <file>           memory database (default: <cwd>/.neuro/memory.db)
  -C, --cwd <dir>           directory whose memory to use (default: current directory)
  -k <n>                    results for search (default: 8)`;

export const defaultMemoryPath = (cwd: string) => resolve(cwd, ".neuro", "memory.db");

export async function memoryCommand(argv: string[], io: CommandIO): Promise<number> {
  const out = (s: string) => io.stdout.write(s);
  const err = (s: string) => io.stderr.write(s);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        db: { type: "string" },
        cwd: { type: "string", short: "C" },
        format: { type: "string" },
        k: { type: "string", short: "k" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`${(e as Error).message}\n\n${MEMORY_USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    (values.help ? out : err)(`${MEMORY_USAGE}\n`);
    return values.help ? 0 : 2;
  }
  const path = resolve(values.db ?? defaultMemoryPath(resolve(values.cwd ?? process.cwd())));
  const backend = new SqliteBackend({ path });
  try {
    switch (command) {
      case "stats": {
        const facts = await backend.facts();
        const superseded = facts.filter((f) => f.supersededBy).length;
        out(
          `${path}\n` +
            `episodes: ${(await backend.episodes()).length}\n` +
            `facts:    ${facts.length - superseded} current, ${superseded} superseded\n` +
            `entities: ${(await backend.entities()).length}\n`,
        );
        return 0;
      }
      case "search": {
        const query = rest.join(" ").trim();
        if (!query) {
          err("Usage: neuro memory search <query>\n");
          return 2;
        }
        const k = Number(values.k ?? 8);
        const memory = new LongTermMemory({ backend });
        const hits = await memory.recall(query, { k: Number.isInteger(k) && k > 0 ? k : 8 });
        if (hits.length === 0) out("Nothing recalled.\n");
        for (const h of hits) {
          const ranks = Object.entries(h.ranks)
            .map(([c, r]) => `${c} #${r}`)
            .join(", ");
          out(
            `${h.id} · ${h.label} · ${h.score.toFixed(4)} (${ranks})\n  ${h.text.replace(/\s+/g, " ")}\n`,
          );
        }
        return 0;
      }
      case "export": {
        const format = values.format ?? "md";
        if (format !== "md" && format !== "jsonl") {
          err(`Unknown format: ${format} (md or jsonl)\n`);
          return 2;
        }
        out(format === "md" ? await exportMarkdown(backend) : await exportJsonl(backend));
        return 0;
      }
      default:
        err(`Unknown memory command: ${command}\n\n${MEMORY_USAGE}\n`);
        return 2;
    }
  } finally {
    await backend.close();
  }
}
