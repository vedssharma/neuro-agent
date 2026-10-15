import { spawn } from "node:child_process";
import { defineTool } from "@neuro-agent/core";
import { z } from "zod";
import { resolveInWorkspace } from "./sandbox.js";

/** Environment variables passed through to commands; everything else (API keys, tokens) is dropped. */
const SAFE_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "USER", "NODE_ENV"];

const MAX_OUTPUT = 30_000;

export interface ShellResult {
  exitCode: number | null;
  signal: string | null;
  output: string;
  timedOut: boolean;
}

/**
 * Runs a command with `sh -c` in the workspace with a scrubbed environment,
 * a timeout, and capped output. This limits accidents, not a hostile model:
 * the command still runs as the current user, so every call needs approval.
 */
export function runShell(
  command: string,
  options: { cwd: string; timeoutMs: number; signal: AbortSignal },
): Promise<ShellResult> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];

  return new Promise((resolvePromise, reject) => {
    const child = spawn("sh", ["-c", command], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let dropped = 0;
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const room = MAX_OUTPUT - output.length;
      if (room > 0) output += text.slice(0, room);
      dropped += Math.max(0, text.length - Math.max(room, 0));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const kill = () => {
      try {
        if (child.pid !== undefined && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already exited
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => kill();
    options.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (dropped > 0) output += `\n[output truncated: ${dropped} more characters]`;
      resolvePromise({ exitCode, signal, output, timedOut });
    });
  });
}

export const shellTool = defineTool({
  name: "shell",
  description:
    "Run a shell command (sh -c) in the workspace. Environment secrets are removed; default timeout 120s. Requires user approval.",
  permission: "execute",
  input: z.object({
    command: z.string().min(1),
    cwd: z.string().optional().describe("Working directory relative to the workspace root"),
    timeout_ms: z.number().int().min(1).max(600_000).optional(),
  }),
  async execute({ command, cwd, timeout_ms }, ctx) {
    const result = await runShell(command, {
      cwd: resolveInWorkspace(ctx.cwd, cwd ?? "."),
      timeoutMs: timeout_ms ?? 120_000,
      signal: ctx.signal,
    });
    const status = result.timedOut
      ? "timed out"
      : result.exitCode !== null
        ? `exit code ${result.exitCode}`
        : `killed by ${result.signal}`;
    return {
      content: `${result.output}${result.output.endsWith("\n") || !result.output ? "" : "\n"}[${status}]`,
      isError: result.timedOut || result.exitCode !== 0,
    };
  },
});
