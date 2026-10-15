/**
 * Provider-neutral conversation model. Adapters translate these to and from
 * each vendor's wire format, so the agent loop never sees vendor shapes.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  /** Raw arguments as produced by the model; validated by the tool's schema before use. */
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError: boolean;
}

/**
 * A provider-specific block (e.g. a reasoning/thinking block) that must be
 * echoed back verbatim to the provider that produced it. Other providers ignore it.
 */
export interface OpaqueBlock {
  type: "opaque";
  provider: string;
  data: unknown;
}

export type UserContent = TextBlock | ToolResultBlock;
export type AssistantContent = TextBlock | ToolCallBlock | OpaqueBlock;

export interface UserMessage {
  role: "user";
  content: UserContent[];
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
}

export type Message = UserMessage | AssistantMessage;

export function userText(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export function textOf(message: Message): string {
  return message.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function toolCallsOf(message: AssistantMessage): ToolCallBlock[] {
  return message.content.filter((b): b is ToolCallBlock => b.type === "tool_call");
}
