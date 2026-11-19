import { exportLibraryLoansCsv } from "@examio/core";
import { csvDownload } from "@/lib/csv-response";
import { db } from "@/lib/db";

/** Books on loan (or only overdue ones) as CSV for school administrators; audited. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const overdueOnly = new URL(request.url).searchParams.get("show") === "overdue";
  return csvDownload(["school_admin"], overdueOnly ? "library-overdue" : "library-loans", (ctx, schoolId) => exportLibraryLoansCsv(db, ctx, schoolId, { overdueOnly }));
}
