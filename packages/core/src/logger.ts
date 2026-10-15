export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Receives one JSON line per record (default: stderr). */
  write?: (line: string) => void;
  now?: () => number;
  fields?: Record<string, unknown>;
}

/** Structured logger emitting one JSON object per line. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const write = options.write ?? ((line: string) => process.stderr.write(line + "\n"));
  const now = options.now ?? Date.now;
  const base = options.fields ?? {};

  const log =
    (at: Exclude<LogLevel, "silent">) => (msg: string, fields?: Record<string, unknown>) => {
      if (RANK[at] < RANK[level]) return;
      write(
        JSON.stringify({ time: new Date(now()).toISOString(), level: at, msg, ...base, ...fields }),
      );
    };

  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: (fields) => createLogger({ level, write, now, fields: { ...base, ...fields } }),
  };
}

export const isLogLevel = (value: string): value is LogLevel => value in RANK;
