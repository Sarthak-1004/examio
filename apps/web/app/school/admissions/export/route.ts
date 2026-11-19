import { exportApplicationsCsv } from "@examio/core";
import { csvDownload } from "@/lib/csv-response";
import { db } from "@/lib/db";

/** Applications (optionally of one status or year) as CSV for school administrators; audited. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  return csvDownload(["school_admin"], "admissions", (ctx, schoolId) => exportApplicationsCsv(db, ctx, schoolId, { status: p.get("status") ?? undefined, yearId: p.get("year") ?? undefined }));
}
