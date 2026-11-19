import { exportTransportCsv } from "@examio/core";
import { csvDownload } from "@/lib/csv-response";
import { db } from "@/lib/db";

/** Students on routes (all, or one route) as CSV for school administrators; audited. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const route = new URL(request.url).searchParams.get("route") || undefined;
  return csvDownload(["school_admin"], "transport", (ctx, schoolId) => exportTransportCsv(db, ctx, schoolId, route));
}
