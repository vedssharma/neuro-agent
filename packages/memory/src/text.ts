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

const CUES =
  /\b(remember|keep in mind|keep track|correction|changed my mind|important|note that|for the record|deadline|must|never|always)\b/i;

/** How much a piece of text looks worth keeping: numbers and codes, statements, explicit cues. */
export function salience(text: string): number {
  let s = 0;
  if (/\d/.test(text)) s += 0.4;
  if (/\b(is|are|was|were)\b/i.test(text)) s += 0.3;
  if (CUES.test(text)) s += 0.4;
  return Math.min(1, s);
}

/** Sentence boundaries: after . ! ? ; or at a line break. */
export const SENTENCE = /(?<=[.!?;])\s+|\n+/;

/** Collapses whitespace and cuts to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
