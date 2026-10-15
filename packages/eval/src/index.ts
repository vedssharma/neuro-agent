import {
  isEvent,
  readTrace,
  type AgentEvent,
  type RunEndReason,
  type Usage,
  ZERO_USAGE,
  addUsage,
} from "@neuro-agent/core";

/** Headline numbers for one recorded session: the Phase 1 baseline metrics. */
export interface TraceSummary {
  sessionId: string;
  provider?: string;
  model?: string;
  contextStrategy?: string;
  runs: number;
  runEndReasons: Partial<Record<RunEndReason, number>>;
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  toolDenials: number;
  toolsByName: Record<string, number>;
  /** Largest number of transcript messages dropped by the context strategy on one call. */
  maxDroppedMessages: number;
  usage: Usage;
  costUsd: number;
  wallClockMs: number;
}

export function summarizeEvents(events: readonly AgentEvent[]): TraceSummary {
  const summary: TraceSummary = {
    sessionId: events[0]?.sessionId ?? "",
    runs: 0,
    runEndReasons: {},
    modelCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolDenials: 0,
    toolsByName: {},
    maxDroppedMessages: 0,
    usage: ZERO_USAGE,
    costUsd: 0,
    wallClockMs: events.length > 0 ? events.at(-1)!.timestamp - events[0]!.timestamp : 0,
  };
  for (const event of events) {
    if (isEvent(event, "session.start")) {
      summary.provider = event.payload.provider;
      summary.model = event.payload.model;
      summary.contextStrategy = event.payload.contextStrategy;
    } else if (isEvent(event, "model.request")) {
      summary.modelCalls++;
      summary.maxDroppedMessages = Math.max(
        summary.maxDroppedMessages,
        event.payload.droppedMessages,
      );
    } else if (isEvent(event, "message.assistant")) {
      summary.usage = addUsage(summary.usage, event.payload.usage);
      summary.costUsd += event.payload.costUsd;
    } else if (isEvent(event, "tool.call")) {
      summary.toolCalls++;
      summary.toolsByName[event.payload.name] = (summary.toolsByName[event.payload.name] ?? 0) + 1;
    } else if (isEvent(event, "tool.result")) {
      if (event.payload.isError) summary.toolErrors++;
    } else if (isEvent(event, "tool.denied")) {
      summary.toolDenials++;
    } else if (isEvent(event, "run.end")) {
      summary.runs++;
      const reason = event.payload.reason;
      summary.runEndReasons[reason] = (summary.runEndReasons[reason] ?? 0) + 1;
    }
  }
  return summary;
}

/** Reads a JSONL trace and summarizes it. */
export function summarizeTrace(path: string): TraceSummary {
  return summarizeEvents(readTrace(path));
}
