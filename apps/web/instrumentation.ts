import type { Instrumentation } from "next";

/**
 * Runs once when a server instance starts, before it handles requests.
 * Skipped during `next build`, which must not need a database.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { verifyStartup } = await import("./lib/startup-checks");
  await verifyStartup();
}

/**
 * Logs unexpected server errors as one redacted JSON line, keyed by the same `digest` the user
 * sees as their support reference. Never logs request bodies, cookies or headers.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { serverLog } = await import("./lib/runtime");
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : undefined;
  serverLog().error("request.error", {
    digest,
    error: err instanceof Error ? err : String(err),
    method: request.method,
    route: context.routePath,
    routeType: context.routeType,
  });
};
