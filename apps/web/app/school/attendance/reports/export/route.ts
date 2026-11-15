import { AppError, exportSectionAttendanceCsv, rolesIn } from "@examio/core";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";

/** A section's attendance over a period as CSV, for the school's administrators; audited, never cached. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const s = await getSession();
  if (!s || s.user.mustChangePassword || !s.ctx.schoolId || !rolesIn(s, s.ctx.schoolId).includes("school_admin")) {
    return new Response("Not allowed.", { status: 403, headers: { "cache-control": "no-store" } });
  }
  const url = new URL(request.url);
  const q = (k: string) => url.searchParams.get(k) ?? "";
  try {
    const csv = await exportSectionAttendanceCsv(db, s.ctx, s.ctx.schoolId, { sectionId: q("section"), from: q("from"), to: q("to") });
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="attendance-${q("from")}-to-${q("to")}.csv"`.replace(/[^\x20-\x7e]/g, ""),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "FORBIDDEN" ? 403 : e.code === "VALIDATION" ? 400 : 404, headers: { "cache-control": "no-store" } });
    throw e;
  }
}
