import { databaseReachable } from "@examio/core";
import { db } from "@/lib/db";

/**
 * Public liveness check for uptime monitors and load balancers: 200 when this server can reach
 * its database, 503 otherwise. Reveals nothing else; detailed health is on /admin/system.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const ok = await databaseReachable(db);
  return Response.json({ status: ok ? "ok" : "unavailable" }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
