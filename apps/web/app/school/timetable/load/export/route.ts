import { AppError, exportTeacherLoadCsv, rolesIn } from "@examio/core";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";

/** Teacher load (periods and hours per week) as CSV for the school's administrators; audited, never cached. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const s = await getSession();
  if (!s || s.user.mustChangePassword || !s.ctx.schoolId || !rolesIn(s, s.ctx.schoolId).includes("school_admin")) {
    return new Response("Not allowed.", { status: 403, headers: { "cache-control": "no-store" } });
  }
  try {
    const csv = await exportTeacherLoadCsv(db, s.ctx, s.ctx.schoolId, new URL(request.url).searchParams.get("year") ?? "");
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="teacher-load-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "FORBIDDEN" ? 403 : e.code === "VALIDATION" ? 400 : 404, headers: { "cache-control": "no-store" } });
    throw e;
  }
}
