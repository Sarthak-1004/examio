import { AppError, exportStaffCsv, rolesIn } from "@examio/core";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Staff list as CSV for the school's administrators. Same scope and filters as the staff page,
 * audited, formulas neutralised, never cached.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const s = await getSession();
  if (!s || s.user.mustChangePassword || !s.ctx.schoolId || !rolesIn(s, s.ctx.schoolId).includes("school_admin")) {
    return new Response("Not allowed.", { status: 403, headers: { "cache-control": "no-store" } });
  }
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  try {
    const csv = await exportStaffCsv(db, s.ctx, s.ctx.schoolId, {
      search: (url.searchParams.get("q") ?? "").slice(0, 100),
      status: status === "active" || status === "left" ? status : undefined,
      role: url.searchParams.get("role") ?? undefined,
    });
    const day = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="staff-${day}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "FORBIDDEN" ? 403 : 404, headers: { "cache-control": "no-store" } });
    throw e;
  }
}
