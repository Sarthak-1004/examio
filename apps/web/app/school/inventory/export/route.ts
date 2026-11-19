import { exportInventoryCsv } from "@examio/core";
import { csvDownload } from "@/lib/csv-response";
import { db } from "@/lib/db";

/** The asset register or consumable balances as CSV for school administrators; audited. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const kind = new URL(request.url).searchParams.get("kind") === "stock" ? "stock" : "assets";
  return csvDownload(["school_admin"], kind === "stock" ? "inventory-stock" : "inventory-assets", (ctx, schoolId) => exportInventoryCsv(db, ctx, schoolId, kind));
}
