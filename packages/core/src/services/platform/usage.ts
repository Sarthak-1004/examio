import { sql } from "drizzle-orm";
import { withContext, type Db, type RequestContext } from "@examio/db";
import { requirePlatformAdmin } from "../../authz";
import type { AccessState } from "../../capabilities";

/**
 * Platform usage (Phase 15.2): per-school counts for platform administrators, from the
 * database function platform_school_usage(), which returns counts only and refuses anyone
 * else. Reading a school's records still needs a support access grant.
 */

export interface SchoolUsageRow {
  schoolId: string;
  name: string;
  code: string;
  status: "onboarding" | "active" | "suspended";
  plan: string | null;
  access: AccessState;
  activeStudents: number;
  activeStaff: number;
  attendanceMarksMonth: number;
  examAttemptsMonth: number;
  fileBytes: number;
  deadJobs: number;
  lastActivity: Date | null;
  unpaidInvoices: number;
  unpaidPaise: number;
}

export async function listPlatformUsage(db: Db, ctx: RequestContext): Promise<SchoolUsageRow[]> {
  requirePlatformAdmin(ctx);
  return withContext(db, ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select school_id as "schoolId", name, code, status, plan, access, active_students as "activeStudents", active_staff as "activeStaff",
             attendance_marks_month as "attendanceMarksMonth", exam_attempts_month as "examAttemptsMonth", file_bytes::float8 as "fileBytes",
             dead_jobs as "deadJobs", last_activity as "lastActivity", unpaid_invoices as "unpaidInvoices", unpaid_paise::float8 as "unpaidPaise"
      from platform_school_usage()`)) as unknown as SchoolUsageRow[];
    return rows.map((r) => ({ ...r, lastActivity: r.lastActivity ? new Date(r.lastActivity) : null }));
  });
}
