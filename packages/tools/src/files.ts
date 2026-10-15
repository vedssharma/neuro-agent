import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool } from "@neuro-agent/core";
import { z } from "zod";
import { displayPath, resolveInWorkspace } from "./sandbox.js";

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a UTF-8 text file in the workspace. Returns numbered lines. Use offset/limit for large files.",
  permission: "read",
  input: z.object({
    path: z.string().describe("Path relative to the workspace root"),
    offset: z.number().int().min(1).optional().describe("First line to return (1-based)"),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines (default 2000)"),
  }),
  async execute({ path, offset, limit }, ctx) {
    const file = resolveInWorkspace(ctx.cwd, path);
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    const start = (offset ?? 1) - 1;
    const end = Math.min(lines.length, start + (limit ?? 2000));
    const body = lines
      .slice(start, end)
      .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
      .join("\n");
    const more = end < lines.length ? `\n[${lines.length - end} more lines]` : "";
    return { content: body + more };
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  description: "Create or overwrite a text file in the workspace, creating parent directories.",
  permission: "write",
  input: z.object({
    path: z.string().describe("Path relative to the workspace root"),
    content: z.string().describe("Full file contents"),
  }),
  async execute({ path, content }, ctx) {
    const file = resolveInWorkspace(ctx.cwd, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    return { content: `Wrote ${content.length} characters to ${displayPath(ctx.cwd, file)}` };
  },
});

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Replace an exact string in a workspace file. old_string must match exactly once unless replace_all is true.",
  permission: "write",
  input: z.object({
    path: z.string().describe("Path relative to the workspace root"),
    old_string: z.string().min(1).describe("Exact text to replace"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence"),
  }),
  async execute({ path, old_string, new_string, replace_all }, ctx) {
    const file = resolveInWorkspace(ctx.cwd, path);
    const text = await readFile(file, "utf8");
    const count = text.split(old_string).length - 1;
    if (count === 0) return { content: `old_string not found in ${path}`, isError: true };
    if (count > 1 && !replace_all) {
      return {
        content: `old_string occurs ${count} times in ${path}; add context or set replace_all`,
        isError: true,
      };
    }
    const updated = replace_all
      ? text.split(old_string).join(new_string)
      : text.replace(old_string, () => new_string);
    await writeFile(file, updated, "utf8");
    return {
      content: `Replaced ${replace_all ? count : 1} occurrence(s) in ${displayPath(ctx.cwd, file)}`,
    };
  },
});
