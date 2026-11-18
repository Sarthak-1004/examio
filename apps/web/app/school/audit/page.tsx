import type { Metadata } from "next";
import { listSchoolAuditEvents, parsePageRequest } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { AuditTable, auditDates } from "@/components/audit-table";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Audit log" };

/** The school's own audit log, including any platform support access. School admins only. */
export default async function SchoolAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const params = await searchParams;
  const req = parsePageRequest(params);
  const { from, to } = auditDates(params);
  const page = await listSchoolAuditEvents(db, s.ctx, s.ctx.schoolId, { ...req, from, to });
  return (
    <>
      <PageHeader title="Audit log" description="Who did what in your school, including platform support access. Read-only." />
      <AuditTable timeZone={s.timeZone} basePath="/school/audit" page={page} search={req.search} from={from} to={to} />
    </>
  );
}
