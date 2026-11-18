import { AppError, exportOfflineCsv, rolesIn } from "@examio/core";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";

/** Results as CSV for staff who may see them; audited, formulas neutralised, never cached. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const s = await getSession();
  const roles = s?.ctx.schoolId ? rolesIn(s, s.ctx.schoolId) : [];
  if (!s || s.user.mustChangePassword || !s.ctx.schoolId || !(roles.includes("school_admin") || roles.includes("teacher"))) {
    return new Response("Not allowed.", { status: 403, headers: { "cache-control": "no-store" } });
  }
  const { id } = await ctx.params;
  try {
    const csv = await exportOfflineCsv(db, s.ctx, s.ctx.schoolId, id);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="paper-exam-marks-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "FORBIDDEN" ? 403 : e.code === "CONFLICT" ? 409 : 404, headers: { "cache-control": "no-store" } });
    throw e;
  }
}
