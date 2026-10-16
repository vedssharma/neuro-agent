import type { Message } from "@neuro-agent/core";

/** Flattens a message to plain text: text blocks, tool calls, and tool results. */
export function messageText(message: Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "tool_result") parts.push(block.content);
    else if (block.type === "tool_call")
      parts.push(`${block.name}(${JSON.stringify(block.input ?? {})})`);
  }
  return parts.join("\n").trim();
}

/** The user's own words in a message (tool results excluded). */
export function userWords(message: Message): string {
  return message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
}

/** Returns a copy of `messages` with `text` prepended to the first message. */
export function prependToFirst(messages: Message[], text: string): Message[] {
  const [first, ...rest] = messages;
  if (!first || first.role !== "user") {
    return [{ role: "user", content: [{ type: "text", text }] }, ...messages];
  }
  return [{ role: "user", content: [{ type: "text", text }, ...first.content] }, ...rest];
}
