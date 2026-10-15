import {
  estimateTokens,
  type AssistantContent,
  type Message,
  type ModelRequest,
  type Provider,
  type StreamEvent,
} from "@neuro-agent/core";

/**
 * A fact is any "the <key> is <value>" statement. The simulated model can only
 * use facts it can see in its context, so its answers measure exactly what a
 * context strategy delivered to it.
 */
const FACT = /\bthe ([a-z0-9][a-z0-9 ._'-]*?) is (?:now |still )?([^.,;\n]+)/gi;

export function visibleFacts(text: string): Map<string, string> {
  const facts = new Map<string, string>();
  for (const match of text.matchAll(FACT)) {
    const key = match[1]!.toLowerCase().trim();
    facts.delete(key); // latest statement wins
    facts.set(key, match[2]!.trim());
  }
  return facts;
}

const QUESTION = /^(?:what|which|who) is the (.+?)\?$/i;
const TOTAL = /^compute the total of the values of (.+?)\.?$/i;

export class ContextLimitError extends Error {
  override name = "ContextLimitError";
}

export interface SimulatedReaderOptions {
  /** Requests whose estimated input exceeds this many tokens fail, like a real context window. Default 16000. */
  contextLimit?: number;
}

/**
 * Deterministic stand-in for an LLM, for offline evaluation. It reads the
 * request it is given (and nothing else), answers "What is the X?" from facts
 * visible in that request, acknowledges statements, and solves "compute the
 * total of the values of a.txt, b.txt" by reading each file it cannot already
 * see a value for. It never remembers anything between calls.
 */
export class SimulatedReader implements Provider {
  readonly name = "simulated";

  constructor(private readonly options: SimulatedReaderOptions = {}) {}

  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    request.signal?.throwIfAborted();
    const inputTokens =
      request.messages.reduce((n, m) => n + estimateTokens(m), 0) +
      Math.ceil(((request.system ?? "").length + JSON.stringify(request.tools).length) / 4);
    const limit = this.options.contextLimit ?? 16_000;
    if (inputTokens > limit) {
      throw new ContextLimitError(
        `prompt is ${inputTokens} tokens, over the ${limit}-token context window`,
      );
    }

    const content = this.respond(
      request.messages,
      request.tools.map((t) => t.name),
    );
    const outText = content.map((b) => (b.type === "text" ? b.text : JSON.stringify(b))).join("");
    const text = content.find((b) => b.type === "text");
    if (text?.type === "text") yield { type: "text_delta", text: text.text };
    yield {
      type: "done",
      message: { role: "assistant", content },
      stopReason: content.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn",
      usage: {
        inputTokens,
        outputTokens: Math.ceil(outText.length / 4),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }

  private respond(messages: readonly Message[], tools: string[]): AssistantContent[] {
    const request = latestRequest(messages);
    const visible = messages.map(allText).join("\n");
    const facts = visibleFacts(visible);

    const question = QUESTION.exec(request);
    if (question) {
      const key = question[1]!.toLowerCase().trim();
      const value = facts.get(key);
      return [
        { type: "text", text: value ? `The ${key} is ${value}.` : `I don't know the ${key}.` },
      ];
    }

    const total = TOTAL.exec(request);
    if (total) {
      const files = total[1]!
        .split(/,\s*|\s+and\s+/)
        .map((f) => f.trim())
        .filter(Boolean);
      let sum = 0;
      for (const file of files) {
        const value = facts.get(`value of ${file.toLowerCase()}`);
        if (value === undefined || Number.isNaN(Number(value))) {
          if (!tools.includes("read_file"))
            return [{ type: "text", text: `I can't read ${file}.` }];
          const id = `call_${messages.length}_${file}`;
          return [{ type: "tool_call", id, name: "read_file", input: { path: file } }];
        }
        sum += Number(value);
      }
      return [{ type: "text", text: `The total is ${sum}.` }];
    }

    return [{ type: "text", text: "Noted." }];
  }
}

function allText(message: Message): string {
  return message.content
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
    .join("\n");
}

/** The user's latest typed request (the last text block of the last user message that has one). */
function latestRequest(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const texts = m.content.filter((b) => b.type === "text");
    const last = texts.at(-1);
    if (last?.type === "text") return last.text.trim();
  }
  return "";
}
