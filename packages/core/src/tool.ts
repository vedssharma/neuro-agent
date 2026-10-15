import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolSpec } from "./provider.js";

/**
 * What a tool may do. `read` tools run freely; `write` and `execute` tools go
 * through the agent's approval hook.
 */
export type Permission = "read" | "write" | "execute";

export interface ToolContext {
  /** Workspace root; filesystem tools must stay inside it. */
  cwd: string;
  signal: AbortSignal;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
}

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  permission: Permission;
  input: S;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

// Tools are stored heterogeneously; `any` keeps each tool's own input type at definition.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any>;

export function defineTool<S extends z.ZodTypeAny>(tool: Tool<S>): Tool<S> {
  return tool;
}

/** Converts a tool's zod schema to the JSON Schema object providers expect. */
export function toToolSpec(tool: AnyTool): ToolSpec {
  const schema = zodToJsonSchema(tool.input, { target: "jsonSchema7", $refStrategy: "none" });
  const inputSchema: Record<string, unknown> = { ...schema };
  delete inputSchema.$schema;
  return { name: tool.name, description: tool.description, inputSchema };
}

export interface ToolCallRequest {
  id: string;
  tool: AnyTool;
  input: unknown;
}

/** Decides whether a `write`/`execute` tool call may run. */
export type ApprovalHook = (call: ToolCallRequest) => boolean | Promise<boolean>;

export const allowAll: ApprovalHook = () => true;
export const denyAll: ApprovalHook = () => false;
