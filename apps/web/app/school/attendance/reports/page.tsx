import type { Metadata } from "next";
import Link from "next/link";
import { AppError, addDays, formatBp, getAttendanceSettings, getMyTeaching, getSectionAttendanceReport, listAcademicYears, listClasses, listSections, type SectionReport } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Alert, Button, ButtonLink, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { chooseYear } from "../../setup/shared";
import { sectionOptions } from "../../students/shared";

export const metadata: Metadata = { title: "Attendance reports" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AttendanceReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const schoolId = s.ctx.schoolId;
  const isAdmin = s.roles.includes("school_admin");
  const sp = await searchParams;
  const settings = await getAttendanceSettings(db, s.ctx, schoolId);
  let options: { id: string; label: string }[];
  if (isAdmin) {
    const [years, classes] = await Promise.all([listAcademicYears(db, s.ctx, schoolId), listClasses(db, s.ctx, schoolId)]);
    const year = chooseYear(years, undefined);
    options = year ? sectionOptions(await listSections(db, s.ctx, schoolId, year.id), classes) : [];
  } else {
    const t = await getMyTeaching(db, s.ctx, schoolId);
    const seen = new Map<string, string>();
    for (const x of [...t.classTeacherOf, ...t.subjects]) seen.set(x.sectionId, x.label);
    options = [...seen.entries()].map(([id, label]) => ({ id, label }));
  }
  const sectionId = options.some((o) => o.id === one(sp.section)) ? one(sp.section) : (options[0]?.id ?? "");
  const to = DATE.test(one(sp.to)) ? one(sp.to) : settings.today;
  const from = DATE.test(one(sp.from)) ? one(sp.from) : addDays(to, -29);
  let report: SectionReport | null = null;
  let error: string | null = null;
  if (sectionId) {
    try {
      report = await getSectionAttendanceReport(db, s.ctx, schoolId, { sectionId, from, to });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      error = e.message;
    }
  }

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/attendance" className="text-brand-600 hover:text-brand-700">
          ← Attendance
        </Link>
      </p>
      <PageHeader
        title="Attendance reports"
        description="Attendance % = (present + late) ÷ (present + late + absent). Excused and not-recorded sessions are left out; N/A when there is nothing to count."
        action={
          isAdmin && report ? (
            <ButtonLink href={`/school/attendance/reports/export?section=${sectionId}&from=${from}&to=${to}`} variant="secondary" prefetch={false}>
              Export CSV
            </ButtonLink>
          ) : undefined
        }
      />
      <Card>
        <form method="get" className="grid gap-4 p-5 sm:grid-cols-4">
          <Field label="Section" htmlFor="ar-section">
            <Select id="ar-section" name="section" defaultValue={sectionId}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" htmlFor="ar-from">
            <Input id="ar-from" name="from" type="date" defaultValue={from} />
          </Field>
          <Field label="To" htmlFor="ar-to">
            <Input id="ar-to" name="to" type="date" defaultValue={to} max={settings.today} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="secondary">
              Show
            </Button>
          </div>
        </form>
      </Card>
      {error && (
        <div className="mt-6">
          <Alert>{error}</Alert>
        </div>
      )}
      {options.length === 0 && (
        <Card className="mt-6">
          <EmptyState title="No sections">{isAdmin ? "Add sections under School setup." : "You have no classes assigned today."}</EmptyState>
        </Card>
      )}
      {report && (
        <Card className="mt-6">
          <CardHeader
            title={`${report.sectionLabel}: ${report.from} to ${report.to}`}
            description={`${report.schoolDays} school day(s) × ${report.sessions} session(s).${report.incompleteDates.length ? ` Registers incomplete on ${report.incompleteDates.length} day(s): ${report.incompleteDates.slice(0, 6).join(", ")}${report.incompleteDates.length > 6 ? ", …" : ""}.` : " Every register is complete."}`}
          />
          {report.rows.length === 0 ? (
            <EmptyState title="No students">No students were enrolled in this period.</EmptyState>
          ) : (
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Attendance by student">
              <table className="min-w-full text-sm">
                <caption className="sr-only">Attendance by student</caption>
                <thead>
                  <tr className="text-left text-slate-700">
                    <th scope="col" className="px-5 py-2">Roll</th>
                    <th scope="col" className="px-5 py-2">Name</th>
                    <th scope="col" className="px-3 py-2 text-right">Present</th>
                    <th scope="col" className="px-3 py-2 text-right">Late</th>
                    <th scope="col" className="px-3 py-2 text-right">Absent</th>
                    <th scope="col" className="px-3 py-2 text-right">Excused</th>
                    <th scope="col" className="px-3 py-2 text-right">Not recorded</th>
                    <th scope="col" className="px-5 py-2 text-right">Attendance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.rows.map((r) => (
                    <tr key={r.studentId}>
                      <td className="px-5 py-2 tabular-nums text-slate-500">{r.rollNo ?? "—"}</td>
                      <td className="px-5 py-2">{r.displayName}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.present}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.late}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.absent}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.excused}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${r.missing ? "text-amber-800" : ""}`}>{r.missing}</td>
                      <td className={`px-5 py-2 text-right font-semibold tabular-nums ${r.bp !== null && r.bp < 7500 ? "text-red-700" : "text-slate-900"}`}>{formatBp(r.bp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
