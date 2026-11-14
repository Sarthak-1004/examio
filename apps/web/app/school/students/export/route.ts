import { AppError, exportStudentsCsv, rolesIn } from "@examio/core";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Student list as CSV for the school's administrators. Same scope and filters as the students
 * page, audited, formulas neutralised, never cached.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const s = await getSession();
  if (!s || s.user.mustChangePassword || !s.ctx.schoolId || !rolesIn(s, s.ctx.schoolId).includes("school_admin")) {
    return new Response("Not allowed.", { status: 403, headers: { "cache-control": "no-store" } });
  }
  const url = new URL(request.url);
  const p = (k: string) => url.searchParams.get(k) ?? undefined;
  const status = p("status");
  const section = p("section");
  try {
    const csv = await exportStudentsCsv(db, s.ctx, s.ctx.schoolId, {
      search: (p("q") ?? "").slice(0, 100),
      status: status === "left" ? "left" : status === "any" ? undefined : "active",
      yearId: p("year"),
      sectionId: section && section !== "none" ? section : undefined,
      enrolled: section === "none" ? "none" : undefined,
    });
    const day = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="students-${day}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "FORBIDDEN" ? 403 : 404, headers: { "cache-control": "no-store" } });
    throw e;
  }
}
