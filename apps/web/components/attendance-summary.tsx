import { formatBp, type StudentAttendance } from "@examio/core";
import { Card, CardHeader } from "./ui";

const LABEL: Record<string, string> = { absent: "Absent", late: "Late", excused: "Excused" };

/** One student's attendance over a period: counts, percentage and the days not marked present. */
export function AttendanceSummary({ a, title = "Attendance" }: { a: StudentAttendance; title?: string }) {
  return (
    <Card>
      <CardHeader title={title} description={`${a.from} to ${a.to}`} />
      <div className="p-5">
        <p className="text-3xl font-bold tabular-nums text-slate-900">{formatBp(a.bp)}</p>
        <p className="mt-1 text-xs text-slate-500">(present + late) ÷ (present + late + absent); excused days are not counted.</p>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
          {(
            [
              ["Present", a.present],
              ["Late", a.late],
              ["Absent", a.absent],
              ["Excused", a.excused],
              ["Not recorded", a.missing],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded-md bg-slate-50 px-3 py-2">
              <dt className="text-slate-600">{k}</dt>
              <dd className="text-lg font-semibold tabular-nums text-slate-900">{v}</dd>
            </div>
          ))}
        </dl>
        {a.entries.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-100 text-sm">
            {a.entries.map((e, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  {e.date} · {e.session}
                </span>
                <span className="text-slate-700">
                  {LABEL[e.status] ?? e.status}
                  {e.note ? ` · ${e.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
