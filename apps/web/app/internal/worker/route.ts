import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
  alertSinkFromEnv,
  createJobHandlers,
  emailAdapterFromEnv,
  fileScannerFromEnv,
  fileStorageFromEnv,
  runWorkerTick,
  type WorkerDeps,
} from "@examio/core";
import { db } from "@/lib/db";
import { ensureRootEnv } from "@/lib/env";
import { serverLog } from "@/lib/runtime";

/**
 * Scheduled background work, for hosting without an always-on worker process (the free demo
 * on Vercel). A scheduler calls this URL every few minutes with `Authorization: Bearer
 * <CRON_SECRET>`; each call runs due jobs for up to ~20 seconds and checks health.
 *
 * Disabled (404) unless CRON_SECRET is set. Wrong or missing secret: 401, with no detail.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request, secret: string): boolean {
  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(request: Request): Promise<Response> {
  ensureRootEnv();
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return new Response("Not found", { status: 404 });
  if (!authorized(request, secret)) return new Response("Unauthorized", { status: 401 });

  const log = serverLog().child({ component: "scheduled-worker" });
  const deps: WorkerDeps = {
    db,
    email: emailAdapterFromEnv(process.env.EMAIL_PROVIDER),
    log,
    storage: fileStorageFromEnv(process.env, path.resolve(process.cwd(), "../..")),
    scanner: fileScannerFromEnv(process.env),
    alerts: alertSinkFromEnv(process.env, log),
  };
  const result = await runWorkerTick(deps, {
    workerId: "scheduled",
    handlers: createJobHandlers(deps),
    budgetMs: 20_000,
    checkHealth: true,
    skipWorkerCheck: true,
  });
  log.info("scheduled-worker.run", { ...result });
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
