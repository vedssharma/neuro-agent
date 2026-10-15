import { complete, type Message, type Provider, type Usage } from "@neuro-agent/core";
import { messageText } from "./text.js";

/** Folds newly evicted messages into a running summary. */
export type Summarizer = (previous: string, evicted: readonly Message[]) => Promise<string>;

const approxTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * Deterministic extractive summarizer: keeps sentences that look informative
 * (contain a number or an "is/are/was" statement), newest first within the budget.
 */
export function extractiveSummarizer(options: { maxTokens: number }): Summarizer {
  return async (previous, evicted) => {
    const lines = previous ? previous.split("\n") : [];
    for (const message of evicted) {
      for (const sentence of messageText(message).split(/(?<=[.!?;])\s+|\n+/)) {
        const s = sentence.replace(/^\s*\d+\t/, "").trim();
        if (s.length < 8 || s.length > 300) continue;
        if (/\d/.test(s) || /\b(is|are|was|were)\b/i.test(s)) lines.push(s);
      }
    }
    const unique = [...new Set(lines.reverse())]; // newest first
    const kept: string[] = [];
    let used = 0;
    for (const line of unique) {
      used += approxTokens(line) + 1;
      if (used > options.maxTokens) break;
      kept.push(line);
    }
    return kept.reverse().join("\n");
  };
}

/** Summarizes with a model call (the classic "summary buffer" baseline). */
export function llmSummarizer(options: {
  provider: Provider;
  model: string;
  maxTokens: number;
  onUsage?: (usage: Usage) => void;
}): Summarizer {
  return async (previous, evicted) => {
    const transcript = evicted
      .map((m) => `${m.role.toUpperCase()}: ${messageText(m)}`)
      .join("\n\n");
    const prompt =
      `Update the running summary of a conversation with the new messages below. ` +
      `Keep every concrete fact, value, name, decision and correction (newer facts replace older ones). ` +
      `Stay under ${options.maxTokens * 3} words. Reply with the summary only.\n\n` +
      `<summary>\n${previous}\n</summary>\n\n<new_messages>\n${transcript}\n</new_messages>`;
    const done = await complete(options.provider, {
      model: options.model,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      tools: [],
      maxTokens: options.maxTokens * 2,
    });
    options.onUsage?.(done.usage);
    return done.message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  };
}
