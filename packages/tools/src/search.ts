import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@neuro-agent/core";
import { z } from "zod";
import { displayPath, resolveInWorkspace } from "./sandbox.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".neuro"]);
const MAX_FILE_BYTES = 1_000_000;

async function* walk(dir: string, signal: AbortSignal): AsyncIterable<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    signal.throwIfAborted();
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full, signal);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Minimal glob: `*` within a segment, `**` across segments, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const listFilesTool = defineTool({
  name: "list_files",
  description:
    "List files under a workspace directory, optionally filtered by a glob (e.g. 'src/**/*.ts'). Skips .git, node_modules, dist.",
  permission: "read",
  input: z.object({
    path: z.string().optional().describe("Directory relative to the workspace root (default '.')"),
    glob: z.string().optional().describe("Glob relative to that directory"),
    limit: z.number().int().min(1).optional().describe("Maximum results (default 500)"),
  }),
  async execute({ path, glob, limit }, ctx) {
    const dir = resolveInWorkspace(ctx.cwd, path ?? ".");
    const pattern = glob ? globToRegExp(glob) : undefined;
    const max = limit ?? 500;
    const out: string[] = [];
    for await (const file of walk(dir, ctx.signal)) {
      const rel = displayPath(dir, file).split("\\").join("/");
      if (pattern && !pattern.test(rel)) continue;
      out.push(displayPath(ctx.cwd, file));
      if (out.length >= max) break;
    }
    return { content: out.length ? out.join("\n") : "No files found." };
  },
});

export const searchTool = defineTool({
  name: "search",
  description:
    "Search workspace files for a regular expression. Returns path:line: text matches. Skips .git, node_modules, dist and binary files.",
  permission: "read",
  input: z.object({
    pattern: z.string().min(1).describe("JavaScript regular expression"),
    path: z.string().optional().describe("Directory or file to search (default '.')"),
    glob: z.string().optional().describe("Only search files matching this glob, e.g. '**/*.ts'"),
    ignore_case: z.boolean().optional(),
    limit: z.number().int().min(1).optional().describe("Maximum matches (default 200)"),
  }),
  async execute({ pattern, path, glob, ignore_case, limit }, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignore_case ? "i" : "");
    } catch (err) {
      return { content: `Invalid regular expression: ${(err as Error).message}`, isError: true };
    }
    const root = resolveInWorkspace(ctx.cwd, path ?? ".");
    const files = (await stat(root)).isFile() ? [root] : walk(root, ctx.signal);
    const filter = glob ? globToRegExp(glob) : undefined;
    const max = limit ?? 200;
    const out: string[] = [];
    for await (const file of files) {
      if (filter && !filter.test(displayPath(root, file).split("\\").join("/"))) continue;
      if ((await stat(file)).size > MAX_FILE_BYTES) continue;
      const buf = await readFile(file);
      if (buf.includes(0)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          out.push(`${displayPath(ctx.cwd, file)}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
          if (out.length >= max)
            return { content: out.join("\n") + `\n[stopped at ${max} matches]` };
        }
      }
    }
    return { content: out.length ? out.join("\n") : "No matches." };
  },
});
