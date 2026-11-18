import { sql } from "drizzle-orm";
import { withContext, type Db, type RequestContext } from "@examio/db";
import { requirePlatformAdmin, requireUuid } from "../authz";
import { isRlsViolation } from "../db-errors";
import { AppError } from "../errors";

/** Platform-administrator views of the job queue: counts, dead letters, retry. */
export interface JobStats {
  queued: number;
  running: number;
  dead: number;
  /** How long the oldest due job has waited, in seconds (0 when none is waiting). */
  oldestDueSeconds: number;
  lastWorkerSeen: Date | null;
}

interface StatsRow extends Record<string, unknown> {
  queued: string | number;
  running: string | number;
  dead: string | number;
  oldest_due_seconds: number;
  last_worker_seen: Date | string | null;
}

const toStats = (r: StatsRow | undefined): JobStats => ({
  queued: Number(r?.queued ?? 0),
  running: Number(r?.running ?? 0),
  dead: Number(r?.dead ?? 0),
  oldestDueSeconds: Number(r?.oldest_due_seconds ?? 0),
  lastWorkerSeen: r?.last_worker_seen ? new Date(r.last_worker_seen) : null,
});

const forbidden = (e: unknown): never => {
  if (isRlsViolation(e)) throw new AppError("FORBIDDEN", "Only platform administrators can do this.");
  throw e;
};

export async function getJobStats(db: Db, ctx: RequestContext): Promise<JobStats> {
  requirePlatformAdmin(ctx);
  const rows = await withContext(db, ctx, (tx) => tx.execute<StatsRow>(sql`select * from job_stats()`)).catch(forbidden);
  return toStats((rows as unknown as StatsRow[])[0]);
}

export interface JobSummary {
  id: string;
  kind: string;
  schoolId: string | null;
  status: "queued" | "running" | "succeeded" | "dead";
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: Date;
  runAt: Date;
  finishedAt: Date | null;
}

interface ListRow extends Record<string, unknown> {
  id: string;
  kind: string;
  school_id: string | null;
  status: JobSummary["status"];
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: Date | string;
  run_at: Date | string;
  finished_at: Date | string | null;
}

export async function listJobs(db: Db, ctx: RequestContext, status: JobSummary["status"], limit = 50): Promise<JobSummary[]> {
  requirePlatformAdmin(ctx);
  const rows = (await withContext(db, ctx, (tx) =>
    tx.execute<ListRow>(sql`select * from job_admin_list(${status}::job_status, ${limit}::integer)`),
  ).catch(forbidden)) as unknown as ListRow[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    schoolId: r.school_id,
    status: r.status,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    lastError: r.last_error,
    createdAt: new Date(r.created_at),
    runAt: new Date(r.run_at),
    finishedAt: r.finished_at ? new Date(r.finished_at) : null,
  }));
}

/** Put a dead job back in the queue with fresh attempts. Audited. */
export async function retryDeadJob(db: Db, ctx: RequestContext, jobId: string): Promise<void> {
  requirePlatformAdmin(ctx);
  requireUuid(jobId, "Job");
  const rows = (await withContext(db, ctx, (tx) =>
    tx.execute<{ ok: boolean } & Record<string, unknown>>(sql`select job_admin_retry(${jobId}::uuid) as ok`),
  ).catch(forbidden)) as unknown as { ok: boolean }[];
  if (rows[0]?.ok !== true) throw new AppError("NOT_FOUND", "Job not found or not in the dead-letter list.");
}
