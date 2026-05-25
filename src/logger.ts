/**
 * logger.ts — Structured JSON-line logger for pi-subagents.
 *
 * Outputs newline-delimited JSON (ndjson) to stderr for consumption by log
 * aggregation services (CloudWatch, Logstash, etc.). Each log line includes
 * timestamp, level, module, and optional context fields.
 *
 * In production / CloudWatch environments, capture stderr with:
 *   <command> 2>&1 | tee -a /var/log/subagents.log
 * or configure the Pi host process to redirect stderr to CloudWatch.
 *
 * Log levels (RFC 5424 severity):
 *   error (3), warn (4), info (6), debug (7)
 */

/** Reserved keys that cannot be overwritten by LogContext fields. */
const RESERVED_LOG_KEYS = new Set(["timestamp", "level", "module", "message"]);

/** Context fields attached to log entries for correlation. */
export interface LogContext {
  /** The conversation/session ID from the Pi host. */
  conversationId?: string;
  /** The agent ID involved in the operation. */
  agentId?: string;
  /** Arbitrary extra key-value pairs. */
  [key: string]: unknown;
}

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  error: 3,
  warn: 4,
  info: 6,
  debug: 7,
};

/** Minimum severity to emit. Default: debug (emit everything). */
let minSeverity = LEVEL_SEVERITY.debug;

/**
 * Set the minimum log level. Messages below this severity are dropped.
 */
export function setLogLevel(level: LogLevel): void {
  minSeverity = LEVEL_SEVERITY[level];
}

/**
 * Emit a structured JSON line to stderr.
 * Reserved keys (timestamp, level, module, message) in context are silently
 * dropped to prevent callers from corrupting the log schema.
 */
function emit(level: LogLevel, module: string, message: string, ctx?: LogContext): void {
  if (LEVEL_SEVERITY[level] > minSeverity) return;

  // Filter out any reserved keys from context to prevent schema corruption
  const safeCtx: Record<string, unknown> = {};
  if (ctx) {
    for (const key of Object.keys(ctx)) {
      if (!RESERVED_LOG_KEYS.has(key)) {
        safeCtx[key] = ctx[key];
      }
    }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    ...safeCtx,
  };

  // stderr → captured by CloudWatch / log shippers
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  error: (module: string, message: string, ctx?: LogContext) => emit("error", module, message, ctx),
  warn: (module: string, message: string, ctx?: LogContext) => emit("warn", module, message, ctx),
  info: (module: string, message: string, ctx?: LogContext) => emit("info", module, message, ctx),
  debug: (module: string, message: string, ctx?: LogContext) => emit("debug", module, message, ctx),
};
