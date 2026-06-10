/**
 * Structured logging (SPEC §"Observability" → "Structured Logging").
 *
 * Every line carries optional context (issue_id, issue_identifier, session_id)
 * plus a concise action/outcome. Output is JSON lines by default; set
 * SYMPHONY_LOG_PRETTY=1 for human-readable lines when watching in a tmux pane.
 *
 * Secret handling (SPEC §"Secret Handling"): the logger never receives token
 * values — call sites validate presence without printing. As a backstop, any
 * field name matching /key|token|secret|password/i is redacted.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string;
  [key: string]: unknown;
}

const SECRET_KEY = /(key|token|secret|password)/i;
const pretty = process.env.SYMPHONY_LOG_PRETTY === "1";
const threshold: LogLevel = (process.env.SYMPHONY_LOG_LEVEL as LogLevel) || "info";

function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key) && typeof value === "string" && value.length > 0) {
    return "[redacted]";
  }
  return value;
}

function emit(level: LogLevel, msg: string, ctx: LogContext, fields: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  for (const [k, v] of Object.entries(ctx)) {
    if (v !== undefined) record[k] = redact(v, k);
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) record[k] = redact(v, k);
  }

  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (pretty) {
    const ctxStr = Object.entries(record)
      .filter(([k]) => !["ts", "level", "msg"].includes(k))
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    stream.write(`${record["ts"]} ${level.toUpperCase().padEnd(5)} ${msg}${ctxStr ? "  " + ctxStr : ""}\n`);
  } else {
    stream.write(JSON.stringify(record) + "\n");
  }
}

export class Logger {
  constructor(private readonly ctx: LogContext = {}) {}

  /** Return a logger that carries additional bound context (e.g. per-issue). */
  child(ctx: LogContext): Logger {
    return new Logger({ ...this.ctx, ...ctx });
  }

  debug(msg: string, fields: Record<string, unknown> = {}): void {
    emit("debug", msg, this.ctx, fields);
  }
  info(msg: string, fields: Record<string, unknown> = {}): void {
    emit("info", msg, this.ctx, fields);
  }
  warn(msg: string, fields: Record<string, unknown> = {}): void {
    emit("warn", msg, this.ctx, fields);
  }
  error(msg: string, fields: Record<string, unknown> = {}): void {
    emit("error", msg, this.ctx, fields);
  }
}

/** Root logger; bind per-issue context with `.child({ issue_identifier })`. */
export const log = new Logger();
