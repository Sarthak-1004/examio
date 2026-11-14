import { AppError, exportEnrollmentReportCsv, rolesIn } from "@examio/core";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";

/** Class strength (students per section) as CSV for the school's administrators; audited, never cached. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const s = await getSession();
  if (!s || s.user.mustChangePassword || !s.ctx.schoolId || !rolesIn(s, s.ctx.schoolId).includes("school_admin")) {
    return new Response("Not allowed.", { status: 403, headers: { "cache-control": "no-store" } });
  }
  const year = new URL(request.url).searchParams.get("year") ?? undefined;
  try {
    const csv = await exportEnrollmentReportCsv(db, s.ctx, s.ctx.schoolId, year);
    const day = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="class-strength-${day}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "FORBIDDEN" ? 403 : 404, headers: { "cache-control": "no-store" } });
    throw e;
  }
}
