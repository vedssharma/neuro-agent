import type { AnyTool } from "@neuro-agent/core";
import { editFileTool, readFileTool, writeFileTool } from "./files.js";
import { listFilesTool, searchTool } from "./search.js";
import { shellTool } from "./shell.js";

export { editFileTool, readFileTool, writeFileTool } from "./files.js";
export { globToRegExp, listFilesTool, searchTool } from "./search.js";
export { runShell, shellTool } from "./shell.js";
export type { ShellResult } from "./shell.js";
export { displayPath, resolveInWorkspace, SandboxError } from "./sandbox.js";

/** The built-in Phase 1 tool set. */
export function builtinTools(): AnyTool[] {
  return [readFileTool, listFilesTool, searchTool, writeFileTool, editFileTool, shellTool];
}
