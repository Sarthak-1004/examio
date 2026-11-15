import { AppError, exportCollectionsCsv, exportDefaultersCsv, rolesIn } from "@examio/core";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";

/** Fee report CSVs (collections, defaulters) for finance staff and administrators; audited, never cached. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const s = await getSession();
  const roles = s?.ctx.schoolId ? rolesIn(s, s.ctx.schoolId) : [];
  if (!s || s.user.mustChangePassword || !s.ctx.schoolId || !(roles.includes("school_admin") || roles.includes("finance"))) {
    return new Response("Not allowed.", { status: 403, headers: { "cache-control": "no-store" } });
  }
  const url = new URL(request.url);
  const report = url.searchParams.get("report");
  try {
    const csv =
      report === "defaulters"
        ? await exportDefaultersCsv(db, s.ctx, s.ctx.schoolId)
        : await exportCollectionsCsv(db, s.ctx, s.ctx.schoolId, { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" });
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${report === "defaulters" ? "defaulters" : "collections"}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "FORBIDDEN" ? 403 : e.code === "VALIDATION" ? 400 : 404, headers: { "cache-control": "no-store" } });
    throw e;
  }
}
