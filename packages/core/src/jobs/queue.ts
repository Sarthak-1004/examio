import { sql } from "drizzle-orm";
import { withWorkerContext, type Db, type Tx } from "@examio/db";
import { createLogger, redactText, type Logger } from "../logger";

/**
 * Durable background jobs (outbox pattern).
 *
 * Enqueue with `enqueueJob(tx, …)` inside the same transaction as the business change, so the
 * job exists exactly when the change commits. The worker (`pnpm worker`) claims due jobs,
 * runs their handler, and records success or failure:
 * - a thrown error retries later with exponential backoff and jitter;
 * - `PermanentJobError` (or running out of attempts) moves the job to the dead-letter state,
 *   where a platform administrator can inspect and retry it;
 * - a worker that dies mid-job loses its lease and the job is claimed again.
 * Handlers must therefore be idempotent: the same job can run more than once.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface EnqueueOptions {
  kind: string;
  /** Identifiers only: never names, contacts, answers or other personal data. */
  payload: { [key: string]: JsonValue };
  /** Enqueuing again with the same kind and key returns the existing job. */
  dedupeKey?: string;
  schoolId?: string | null;
  runAt?: Date;
  maxAttempts?: number;
}

interface IdRow extends Record<string, unknown> {
  id: string;
}

export async function enqueueJob(tx: Tx, opts: EnqueueOptions): Promise<string> {
  const rows = (await tx.execute<IdRow>(sql`select job_enqueue(
    ${opts.kind}, ${JSON.stringify(opts.payload)}::jsonb, ${opts.dedupeKey ?? null}, ${opts.schoolId ?? null}::uuid,
    ${opts.runAt ? opts.runAt.toISOString() : null}::timestamptz, ${opts.maxAttempts ?? null}::integer
  ) as id`)) as unknown as IdRow[];
  const id = rows[0]?.id;
  if (!id) throw new Error("job_enqueue returned no id");
  return id;
}

/** A failure that retrying cannot fix (bad payload, unknown template). The job goes straight to dead. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export interface ClaimedJob {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  schoolId: string | null;
  attempts: number;
  maxAttempts: number;
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;
export type JobHandlers = Readonly<Record<string, JobHandler>>;

/** 30 s, 1 min, 2 min, … capped at 1 hour, each scaled by a random 50–150 % to spread retries. */
export function retryDelaySeconds(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(base * (0.5 + random())));
}

interface ClaimRow extends Record<string, unknown> {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  school_id: string | null;
  attempts: number;
  max_attempts: number;
}

export interface WorkerRunResult {
  claimed: number;
  succeeded: number;
  retried: number;
  dead: number;
}

export async function workerHeartbeat(db: Db, workerId: string): Promise<void> {
  await withWorkerContext(db, null, (tx) => tx.execute(sql`select worker_heartbeat(${workerId})`));
}

/**
 * Claims and runs up to `maxJobs` due jobs once. Returns what happened; never throws for a
 * failing handler (that is recorded on the job instead).
 */
export async function runWorkerOnce(
  db: Db,
  opts: {
    workerId: string;
    handlers: JobHandlers;
    maxJobs?: number;
    leaseSeconds?: number;
    log?: Logger;
    /** Called when a job moves to the dead-letter state, e.g. to raise an alert. */
    onDead?: (job: ClaimedJob, error: string) => Promise<void> | void;
  },
): Promise<WorkerRunResult> {
  const log = opts.log ?? createLogger({ component: "worker", workerId: opts.workerId });
  const kinds = Object.keys(opts.handlers);
  const result: WorkerRunResult = { claimed: 0, succeeded: 0, retried: 0, dead: 0 };
  if (kinds.length === 0) return result;

  const claimed = (await withWorkerContext(db, null, (tx) =>
    tx.execute<ClaimRow>(
      sql`select * from job_claim(${opts.workerId}, array[${sql.join(kinds.map((k) => sql`${k}`), sql`, `)}]::text[], ${opts.maxJobs ?? 10}::integer, ${opts.leaseSeconds ?? 120}::integer)`,
    ),
  )) as unknown as ClaimRow[];
  result.claimed = claimed.length;

  for (const row of claimed) {
    const job: ClaimedJob = {
      id: row.id,
      kind: row.kind,
      payload: row.payload ?? {},
      schoolId: row.school_id,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
    };
    const handler = opts.handlers[job.kind];
    try {
      if (!handler) throw new PermanentJobError(`no handler for job kind ${job.kind}`);
      await handler(job);
      await withWorkerContext(db, job.schoolId, (tx) => tx.execute(sql`select job_complete(${job.id}::uuid, ${opts.workerId})`));
      result.succeeded++;
      log.debug("job.succeeded", { jobId: job.id, kind: job.kind, attempt: job.attempts });
    } catch (e) {
      const permanent = e instanceof PermanentJobError;
      const message = redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      const delay = permanent ? null : retryDelaySeconds(job.attempts);
      const statusRows = (await withWorkerContext(db, job.schoolId, (tx) =>
        tx.execute<{ status: string | null } & Record<string, unknown>>(
          sql`select job_fail(${job.id}::uuid, ${opts.workerId}, ${message}, ${delay}::integer) as status`,
        ),
      )) as unknown as { status: string | null }[];
      const status = statusRows[0]?.status;
      if (status === "dead") {
        result.dead++;
        log.error("job.dead", { jobId: job.id, kind: job.kind, attempt: job.attempts, error: message });
        await opts.onDead?.(job, message);
      } else {
        result.retried++;
        log.warn("job.retry", { jobId: job.id, kind: job.kind, attempt: job.attempts, retryInSeconds: delay, error: message });
      }
    }
  }
  return result;
}
