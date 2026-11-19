import "server-only";
import { AppError, rolesIn } from "@examio/core";
import type { RequestContext } from "@examio/db";
import { getSession } from "@/lib/auth";

/**
 * A CSV download for signed-in members with one of `roles` in their current school. The
 * service still checks its own capability and audits the export; this only refuses early and
 * sets headers that keep the file out of caches.
 */
export async function csvDownload(
  roles: readonly ("school_admin" | "teacher" | "finance")[],
  name: string,
  build: (ctx: RequestContext, schoolId: string) => Promise<string>,
): Promise<Response> {
  const s = await getSession();
  const mine = s?.ctx.schoolId ? rolesIn(s, s.ctx.schoolId) : [];
  if (!s || s.user.mustChangePassword || !s.ctx.schoolId || !mine.some((r) => (roles as readonly string[]).includes(r))) {
    return new Response("Not allowed.", { status: 403, headers: { "cache-control": "no-store" } });
  }
  try {
    const csv = await build(s.ctx, s.ctx.schoolId);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "FORBIDDEN" ? 403 : 404, headers: { "cache-control": "no-store" } });
    throw e;
  }
}
