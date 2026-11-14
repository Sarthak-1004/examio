/**
 * Structured, redacting logger. Writes one JSON object per line to stdout/stderr so a hosting
 * platform can collect it. Before anything is written:
 * - values under sensitive keys (password, token, secret, code, key, cookie, authorization,
 *   email, phone, …) are replaced with "[redacted]";
 * - credentials embedded in text (connection strings with passwords, bearer tokens, one-time
 *   codes, long hex/base64 tokens) are masked.
 * Never log request bodies, answers, student records or payment payloads, even redacted.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const SENSITIVE_KEY = /pass(word)?|secret|token|cookie|authori[sz]ation|api[-_]?key|private|otp|totp|code|hash|email|phone|mobile|credential|session|dsn|url/i;
const MAX_DEPTH = 5;
const MAX_STRING = 2000;

const TEXT_PATTERNS: [RegExp, string][] = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^:/?#\s@]+):([^@/\s]+)@/gi, "$1$2:[redacted]@"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]"],
  [/\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/g, "[redacted-code]"],
  [/\b[0-9a-f]{40,}\b/gi, "[redacted-hex]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted-token]"],
];

export function redactText(text: string): string {
  let out = text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text;
  for (const [pattern, replacement] of TEXT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return { name: value.name, message: redactText(value.message), ...(typeof code === "string" ? { code } : {}) };
  }
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  bindings: Record<string, unknown> = {},
  opts: { level?: LogLevel; write?: (level: LogLevel, line: string) => void } = {},
): Logger {
  const min = ORDER[opts.level ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info"] ?? ORDER.info;
  const write =
    opts.write ??
    ((level: LogLevel, line: string) => {
      (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
    });
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const record = { time: new Date().toISOString(), level, event, ...(redact(bindings) as object), ...(redact(fields ?? {}) as object) };
    write(level, JSON.stringify(record));
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    child: (more) => createLogger({ ...bindings, ...more }, opts),
  };
}
