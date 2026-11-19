import { exportBankCsv } from "@examio/core";
import { csvDownload } from "@/lib/csv-response";
import { db } from "@/lib/db";

/** The bank file of an approved payroll run, for administrators and finance; audited. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return csvDownload(["school_admin", "finance"], "salary-bank-file", (c, schoolId) => exportBankCsv(db, c, schoolId, id));
}
