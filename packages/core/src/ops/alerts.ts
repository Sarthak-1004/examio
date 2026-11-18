import { createLogger, redactText, type Logger } from "../logger";

/**
 * Alerts for operators: dead-lettered jobs, a stalled worker, files stuck in quarantine,
 * failed health checks. Sinks:
 * - `log` (default): an error-level log line. Fine for development; nobody is woken up.
 * - `webhook`: POSTs `{"text": "..."}` to ALERT_WEBHOOK_URL (Slack/Teams-style incoming
 *   webhook). Required in staging and production.
 * Alert text is redacted and never includes personal data or payloads.
 */
export type AlertSeverity = "warning" | "critical";

export interface Alert {
  /** Stable identifier of the condition, used to avoid repeating the same alert. */
  key: string;
  severity: AlertSeverity;
  summary: string;
  detail?: string;
}

export interface AlertSink {
  readonly name: string;
  send(alert: Alert): Promise<void>;
}

export function logAlertSink(log: Logger = createLogger({ component: "alerts" })): AlertSink {
  return {
    name: "log",
    async send(alert) {
      log.error("alert", { alertKey: alert.key, severity: alert.severity, summary: alert.summary, detail: alert.detail });
    },
  };
}

export function webhookAlertSink(url: string, environment: string, fetchImpl: typeof fetch = fetch): AlertSink {
  return {
    name: "webhook",
    async send(alert) {
      const text = redactText(`[${environment}] ${alert.severity.toUpperCase()}: ${alert.summary}${alert.detail ? `\n${alert.detail}` : ""}`);
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Alert webhook answered ${res.status}`);
    },
  };
}

export function alertSinkFromEnv(env: NodeJS.ProcessEnv, log?: Logger): AlertSink {
  const sink = (env.ALERT_SINK ?? "log").trim() || "log";
  if (sink === "log") return logAlertSink(log);
  if (sink === "webhook") {
    const url = env.ALERT_WEBHOOK_URL?.trim();
    if (!url) throw new Error("ALERT_SINK=webhook needs ALERT_WEBHOOK_URL.");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("ALERT_WEBHOOK_URL is not a valid URL.");
    }
    if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
      throw new Error("ALERT_WEBHOOK_URL must use https.");
    }
    return webhookAlertSink(url, env.EXAMIO_ENV ?? "development");
  }
  throw new Error(`ALERT_SINK "${sink}" is not supported. Supported: log, webhook.`);
}
