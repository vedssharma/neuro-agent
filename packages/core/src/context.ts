import type { Message } from "./messages.js";

export interface ContextSelection {
  messages: Message[];
  /** How many leading transcript messages were left out. */
  dropped: number;
  estimatedTokens: number;
}

/** Chooses which part of the transcript is sent to the model on each turn. */
export interface ContextStrategy {
  readonly name: string;
  select(transcript: readonly Message[]): ContextSelection;
}

/** Rough, provider-independent token estimate (~4 characters per token). */
export function estimateTokens(message: Message): number {
  let chars = 0;
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        chars += block.text.length;
        break;
      case "tool_call":
        chars += block.name.length + JSON.stringify(block.input ?? null).length;
        break;
      case "tool_result":
        chars += block.content.length;
        break;
      case "opaque":
        break;
    }
  }
  return Math.ceil(chars / 4) + 4;
}

const sum = (messages: readonly Message[]) => messages.reduce((n, m) => n + estimateTokens(m), 0);

/** Sends the whole transcript every turn. */
export class FullTranscript implements ContextStrategy {
  readonly name = "full-transcript";
  select(transcript: readonly Message[]): ContextSelection {
    return { messages: [...transcript], dropped: 0, estimatedTokens: sum(transcript) };
  }
}

/** A user message that starts a turn (rather than carrying tool results). */
function isTurnStart(message: Message): boolean {
  return message.role === "user" && message.content.every((b) => b.type !== "tool_result");
}

/**
 * Keeps the newest messages that fit in `maxTokens`, always cutting at the
 * start of a user turn so tool calls and their results stay paired. If even
 * the latest turn is over budget it is kept whole.
 */
export class SlidingWindow implements ContextStrategy {
  readonly name = "sliding-window";

  constructor(readonly maxTokens: number) {
    if (!(maxTokens > 0)) throw new RangeError("maxTokens must be positive");
  }

  select(transcript: readonly Message[]): ContextSelection {
    let lastTurnStart = -1;
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (isTurnStart(transcript[i]!)) {
        lastTurnStart = i;
        break;
      }
    }

    let start = transcript.length;
    let tokens = 0;
    while (start > 0) {
      const next = tokens + estimateTokens(transcript[start - 1]!);
      if (next > this.maxTokens) break;
      tokens = next;
      start--;
    }
    while (start < transcript.length && !isTurnStart(transcript[start]!)) start++;
    if (lastTurnStart >= 0 && start > lastTurnStart) start = lastTurnStart;
    if (lastTurnStart < 0) start = 0;

    const messages = transcript.slice(start);
    return { messages, dropped: start, estimatedTokens: sum(messages) };
  }
}
