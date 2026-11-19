import type { Metadata } from "next";
import Link from "next/link";
import {
  formatPaise,
  getAdmissionsSummary,
  getCollections,
  getInventorySummary,
  getLibrarySummary,
  getOutstandingByClass,
  getSchoolReport,
  getTransportSummary,
  schoolToday,
  type PlanModule,
} from "@examio/core";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Reports" };

interface Tile {
  title: string;
  href: string;
  main: string;
  detail: string;
}

/** One page with the school's figures across the modules in its plan, and every download (Phase 15.2). */
export default async function ReportsPage() {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const r = await getSchoolReport(db, s.ctx, schoolId);
  const on = (m: PlanModule) => r.modules.includes(m);
  const today = schoolToday(s.timeZone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [collections, outstanding, adm, lib, inv, trn] = await Promise.all([
    on("fees") ? getCollections(db, s.ctx, schoolId, { from: monthStart, to: today }) : null,
    on("fees") ? getOutstandingByClass(db, s.ctx, schoolId) : null,
    on("admissions") ? getAdmissionsSummary(db, s.ctx, schoolId) : null,
    on("library") ? getLibrarySummary(db, s.ctx, schoolId) : null,
    on("inventory") ? getInventorySummary(db, s.ctx, schoolId) : null,
    on("transport") ? getTransportSummary(db, s.ctx, schoolId) : null,
  ]);
  const owed = outstanding?.reduce((a, x) => a + x.outstandingPaise, 0) ?? 0;
  const overdue = outstanding?.reduce((a, x) => a + x.overduePaise, 0) ?? 0;

  const tiles: Tile[] = [
    { title: "Students", href: "/school/students", main: `${r.students.active} active`, detail: `${r.students.admittedThisYear} admitted this year · ${r.staff.active} staff` },
    {
      title: "Attendance (30 days)",
      href: "/school/attendance/reports",
      main: r.attendance.presentPercent === null ? "No marks" : `${r.attendance.presentPercent}% present`,
      detail: `${r.attendance.marks} marks recorded`,
    },
    { title: "Homework", href: "/school/homework", main: `${r.homework.dueNext7} due this week`, detail: `${r.homework.publishedLast30} set in the last 30 days` },
    ...(collections
      ? [{ title: "Fees", href: "/school/fees/reports", main: `${formatPaise(collections.totalPaise)} collected`, detail: `this month · ${formatPaise(owed)} outstanding, ${formatPaise(overdue)} overdue` }]
      : []),
    ...(r.exams ? [{ title: "Exams", href: "/school/results", main: `${r.exams.publishedThisYear} this year`, detail: `${r.exams.attemptsLast30} attempts in 30 days · ${r.exams.resultsReleased} result sets released` }] : []),
    ...(adm ? [{ title: "Admissions", href: "/school/admissions", main: `${adm.open} open`, detail: `${adm.enrolledThisYear} enrolled this year · ${adm.approvedNotEnrolled} approved, not enrolled` }] : []),
    ...(lib ? [{ title: "Library", href: "/school/library", main: `${lib.onLoan} on loan`, detail: `${lib.overdue} overdue · ${lib.titles} titles` }] : []),
    ...(inv ? [{ title: "Inventory", href: "/school/inventory", main: `${inv.lowStock} low on stock`, detail: `${inv.allocated} assets with staff · ${inv.underRepair} in repair` }] : []),
    ...(trn ? [{ title: "Transport", href: "/school/transport", main: `${trn.students} students`, detail: `${trn.seats} seats on ${trn.routes} routes` }] : []),
    ...(r.leave ? [{ title: "Staff leave", href: "/school/hr/leave", main: `${r.leave.pending} pending`, detail: `${r.leave.onLeaveToday} on leave today` }] : []),
    ...(r.payroll
      ? [
          {
            title: "Payroll",
            href: "/school/payroll",
            main: r.payroll.lastMonth ? `${r.payroll.lastMonth}: ${r.payroll.lastStatus}` : "No runs yet",
            detail: `${r.payroll.lastNetPaise !== null ? `${formatPaise(r.payroll.lastNetPaise)} net · ` : ""}${r.payroll.adjustmentsPending} adjustments pending`,
          },
        ]
      : []),
  ];

  const downloads: [label: string, href: string, module?: PlanModule][] = [
    ["Students (CSV)", "/school/students/export"],
    ["Class strength by section (CSV)", "/school/students/reports/export"],
    ["Staff (CSV)", "/school/staff/export"],
    ["Admissions applications (CSV)", "/school/admissions/export", "admissions"],
    ["Library books on loan (CSV)", "/school/library/export", "library"],
    ["Inventory asset register (CSV)", "/school/inventory/export?kind=assets", "inventory"],
    ["Inventory stock (CSV)", "/school/inventory/export?kind=stock", "inventory"],
    ["Transport routes (CSV)", "/school/transport/export", "transport"],
  ];
  const withFilters: [label: string, href: string, module?: PlanModule][] = [
    ["Attendance reports", "/school/attendance/reports"],
    ["Teacher load", "/school/timetable/load"],
    ["Fee collections and dues", "/school/fees/reports", "fees"],
    ["Exam and paper results", "/school/results", "exams"],
    ["Payroll bank files", "/school/payroll", "payroll"],
    ["Audit log", "/school/audit"],
  ];
  const visible = <T extends [string, string, PlanModule?]>(list: T[]) => list.filter(([, , m]) => !m || on(m));

  return (
    <>
      <PageHeader title="Reports" description={`Figures as of ${today} for the modules in your school's plan, and every download. Each tile opens its module for detail.`} />
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <li key={t.title}>
            <Card className="h-full">
              <Link href={t.href} className="block h-full px-5 py-4 hover:bg-slate-50">
                <p className="text-sm text-slate-500">{t.title}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{t.main}</p>
                <p className="mt-1 text-sm text-slate-600">{t.detail}</p>
              </Link>
            </Card>
          </li>
        ))}
      </ul>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Downloads" description="Each download is recorded in the audit log." />
          <ul className="divide-y divide-slate-100 text-sm">
            {visible(downloads).map(([label, href]) => (
              <li key={href} className="px-5 py-2.5">
                <a href={href} className="font-medium text-brand-700 hover:underline">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Reports with dates or filters" description="Choose the period or the exam on the report's page, then download." />
          <ul className="divide-y divide-slate-100 text-sm">
            {visible(withFilters).map(([label, href]) => (
              <li key={href} className="px-5 py-2.5">
                <Link href={href} className="font-medium text-brand-700 hover:underline">
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
