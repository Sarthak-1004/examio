import type { Metadata } from "next";
import { listPlatformAuditEvents, parsePageRequest } from "@examio/core";
import { requirePlatformAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { AuditTable, auditDates } from "@/components/audit-table";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Audit log" };

/** Platform-level events. School events are visible to each school, and here only under support access. */
export default async function PlatformAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requirePlatformAdmin();
  const params = await searchParams;
  const req = parsePageRequest(params);
  const { from, to } = auditDates(params);
  const page = await listPlatformAuditEvents(db, s.ctx, { ...req, from, to });
  return (
    <>
      <PageHeader title="Audit log" description="Platform-level events: sign-ins, school creation, lookups, platform administrator actions." />
      <AuditTable timeZone={s.timeZone} basePath="/admin/audit" page={page} search={req.search} from={from} to={to} />
    </>
  );
}
