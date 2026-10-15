import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { AgentEventSchema, type AgentEvent } from "./events.js";

/** Receives every event the agent emits. */
export type EventSink = (event: AgentEvent) => void;

/**
 * Appends events to a JSONL file, one event per line. Writes are synchronous
 * so a crash loses at most the event being written.
 */
export class JsonlTraceWriter {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  readonly write: EventSink = (event) => {
    appendFileSync(this.path, JSON.stringify(event) + "\n");
  };
}

/** Reads and validates a JSONL trace. */
export function readTrace(path: string): AgentEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      try {
        return AgentEventSchema.parse(JSON.parse(line));
      } catch (err) {
        throw new Error(`${path}:${i + 1}: invalid trace event: ${(err as Error).message}`);
      }
    });
}

/** Fans one event out to several sinks. */
export function teeSinks(...sinks: (EventSink | undefined)[]): EventSink {
  const active = sinks.filter((s): s is EventSink => s !== undefined);
  return (event) => {
    for (const sink of active) sink(event);
  };
}
