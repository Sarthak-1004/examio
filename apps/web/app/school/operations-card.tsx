import Link from "next/link";
import { getAdmissionsSummary, getInventorySummary, getLibrarySummary, getTransportSummary } from "@examio/core";
import type { RequestContext } from "@examio/db";
import { Card, CardHeader, cx } from "@/components/ui";
import { db } from "@/lib/db";

/** Administrators' at-a-glance figures for admissions, library, inventory and transport (Phase 13.5). */
export async function OperationsCard({ ctx, schoolId }: { ctx: RequestContext; schoolId: string }) {
  const [adm, lib, inv, trn] = await Promise.all([
    getAdmissionsSummary(db, ctx, schoolId),
    getLibrarySummary(db, ctx, schoolId),
    getInventorySummary(db, ctx, schoolId),
    getTransportSummary(db, ctx, schoolId),
  ]);
  const tiles: { href: string; title: string; main: string; detail: string; alert: boolean }[] = [
    {
      href: "/school/admissions",
      title: "Admissions",
      main: `${adm.open} open`,
      detail: `${adm.awaitingDecision} under review · ${adm.approvedNotEnrolled} approved, not enrolled`,
      alert: adm.approvedNotEnrolled > 0,
    },
    {
      href: lib.overdue > 0 ? "/school/library?show=overdue" : "/school/library",
      title: "Library",
      main: `${lib.onLoan} on loan`,
      detail: `${lib.overdue} overdue · ${lib.copies} copies of ${lib.titles} titles`,
      alert: lib.overdue > 0,
    },
    {
      href: inv.lowStock > 0 ? "/school/inventory?show=low" : "/school/inventory",
      title: "Inventory",
      main: `${inv.lowStock} low on stock`,
      detail: `${inv.allocated} assets with staff (${inv.overdueReturns} overdue) · ${inv.underRepair} in repair`,
      alert: inv.lowStock > 0 || inv.overdueReturns > 0,
    },
    {
      href: "/school/transport",
      title: "Transport",
      main: `${trn.students} students`,
      detail: `${trn.seats} seats on ${trn.routes} routes · ${trn.fullRoutes} full`,
      alert: trn.fullRoutes > 0,
    },
  ];
  return (
    <Card className="mt-6">
      <CardHeader title="School operations" />
      <ul className="grid gap-px bg-slate-100 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <li key={t.title} className="bg-white">
            <Link href={t.href} className="block h-full px-5 py-4 hover:bg-slate-50">
              <p className="text-sm text-slate-500">{t.title}</p>
              <p className={cx("mt-1 text-xl font-semibold tabular-nums", t.alert ? "text-amber-800" : "text-slate-900")}>{t.main}</p>
              <p className="mt-1 text-sm text-slate-600">{t.detail}</p>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
