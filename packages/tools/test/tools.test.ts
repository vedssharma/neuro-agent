import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AnyTool, ToolContext } from "@neuro-agent/core";
import {
  builtinTools,
  editFileTool,
  globToRegExp,
  listFilesTool,
  readFileTool,
  resolveInWorkspace,
  searchTool,
  shellTool,
  writeFileTool,
} from "@neuro-agent/tools";

let root: string;
let ctx: ToolContext;
const run = (tool: AnyTool, input: unknown) => tool.execute(tool.input.parse(input), ctx);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "neuro-tools-"));
  ctx = { cwd: root, signal: new AbortController().signal };
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\nexport default a;\n");
  writeFileSync(join(root, "src", "deep", "b.ts"), "export const B = 'needle';\n");
  writeFileSync(join(root, "README.md"), "# needle in readme\n");
  writeFileSync(join(root, "node_modules", "x", "c.ts"), "needle\n");
});

describe("sandbox", () => {
  it("refuses paths outside the workspace", () => {
    expect(() => resolveInWorkspace(root, "../etc/passwd")).toThrow(/outside the workspace/);
    expect(() => resolveInWorkspace(root, "/etc/passwd")).toThrow(/outside the workspace/);
    expect(resolveInWorkspace(root, "src/../README.md")).toMatch(/README\.md$/);
    expect(resolveInWorkspace(root, "..not-a-parent")).toMatch(/\.\.not-a-parent$/);
  });

  it("refuses symlink escapes, including for files that don't exist yet", () => {
    const outside = mkdtempSync(join(tmpdir(), "neuro-outside-"));
    symlinkSync(outside, join(root, "link"));
    expect(() => resolveInWorkspace(root, "link/secret")).toThrow(/outside the workspace/);
    expect(() => resolveInWorkspace(root, "link/new/dir/file")).toThrow(/outside the workspace/);
  });
});

describe("file tools", () => {
  it("reads with line numbers and paging", async () => {
    expect((await run(readFileTool, { path: "src/a.ts" })).content).toBe(
      "     1\tconst a = 1;\n     2\texport default a;\n     3\t",
    );
    expect((await run(readFileTool, { path: "src/a.ts", offset: 2, limit: 1 })).content).toBe(
      "     2\texport default a;\n[1 more lines]",
    );
  });

  it("writes files, creating directories", async () => {
    const out = await run(writeFileTool, { path: "new/dir/f.txt", content: "hello" });
    expect(out.content).toBe("Wrote 5 characters to new/dir/f.txt");
    expect(readFileSync(join(root, "new/dir/f.txt"), "utf8")).toBe("hello");
  });

  it("edits exactly one occurrence unless replace_all", async () => {
    writeFileSync(join(root, "e.txt"), "x x y $&");
    expect(
      await run(editFileTool, { path: "e.txt", old_string: "x", new_string: "z" }),
    ).toMatchObject({ isError: true });
    expect(
      await run(editFileTool, { path: "e.txt", old_string: "q", new_string: "z" }),
    ).toMatchObject({ isError: true });
    await run(editFileTool, { path: "e.txt", old_string: "y", new_string: "$1" });
    await run(editFileTool, { path: "e.txt", old_string: "x", new_string: "w", replace_all: true });
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("w w $1 $&");
  });
});

describe("search tools", () => {
  it("converts globs", () => {
    expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("c.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a/c.ts")).toBe(false);
    expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
  });

  it("lists files, skipping node_modules", async () => {
    expect((await run(listFilesTool, {})).content.split("\n")).toEqual([
      "README.md",
      "src/a.ts",
      "src/deep/b.ts",
    ]);
    expect((await run(listFilesTool, { path: "src", glob: "deep/*.ts" })).content).toBe(
      "src/deep/b.ts",
    );
  });

  it("searches by regex with optional glob", async () => {
    expect((await run(searchTool, { pattern: "needle" })).content.split("\n")).toEqual([
      "README.md:1: # needle in readme",
      "src/deep/b.ts:1: export const B = 'needle';",
    ]);
    expect(
      (await run(searchTool, { pattern: "NEEDLE", ignore_case: true, glob: "**/*.ts" })).content,
    ).toBe("src/deep/b.ts:1: export const B = 'needle';");
    expect((await run(searchTool, { pattern: "(" })).isError).toBe(true);
    expect((await run(searchTool, { pattern: "zzz" })).content).toBe("No matches.");
  });
});

describe("shell", () => {
  it("runs in the workspace with a scrubbed environment", async () => {
    process.env.NEURO_TEST_SECRET = "s3cret";
    const out = await run(shellTool, {
      command: 'pwd; echo "secret=${NEURO_TEST_SECRET:-unset}"',
      cwd: "src",
    });
    delete process.env.NEURO_TEST_SECRET;
    expect(out.isError).toBe(false);
    expect(out.content).toMatch(/src\nsecret=unset\n\[exit code 0\]$/);
  });

  it("reports failures and timeouts", async () => {
    expect(await run(shellTool, { command: "echo oops >&2; exit 3" })).toEqual({
      content: "oops\n[exit code 3]",
      isError: true,
    });
    const slow = await run(shellTool, { command: "sleep 5", timeout_ms: 100 });
    expect(slow).toMatchObject({ isError: true, content: expect.stringContaining("[timed out]") });
  });

  it("requires approval-level permissions for mutating tools", () => {
    const perms = Object.fromEntries(builtinTools().map((t) => [t.name, t.permission]));
    expect(perms).toEqual({
      read_file: "read",
      list_files: "read",
      search: "read",
      write_file: "write",
      edit_file: "write",
      shell: "execute",
    });
  });
});
