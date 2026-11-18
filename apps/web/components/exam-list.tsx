import type { FamilyExamRow } from "@examio/core";
import { formatDateTime } from "@/lib/format";
import { Badge, EmptyState } from "./ui";

const WINDOW = {
  upcoming: { label: "Upcoming", tone: "blue" },
  open: { label: "Open now", tone: "green" },
  closed: { label: "Closed", tone: "slate" },
  cancelled: { label: "Cancelled", tone: "red" },
} as const;

/** An exam schedule for a student (with actions) or a parent (read-only). */
export function ExamList({
  rows,
  timeZone,
  action,
  detail,
  empty,
}: {
  rows: FamilyExamRow[];
  timeZone: string;
  action?: (r: FamilyExamRow) => React.ReactNode;
  detail?: (r: FamilyExamRow) => string;
  empty: string;
}) {
  if (rows.length === 0) return <EmptyState title="No exams">{empty}</EmptyState>;
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => {
        const w = r.inProgressAttemptId ? ({ label: "In progress", tone: "amber" } as const) : WINDOW[r.window];
        return (
          <li key={r.examId} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm">
              <p className="font-medium text-slate-900">
                {r.title} <Badge tone={w.tone}>{w.label}</Badge>
              </p>
              <p className="text-slate-600">
                {r.subjectName} · {formatDateTime(r.opensAt, timeZone)} to {formatDateTime(r.closesAt, timeZone)} · {r.durationMinutes + r.extraMinutes} min
                {r.extraMinutes ? ` (includes ${r.extraMinutes} extra)` : ""}
              </p>
              <p className="text-xs text-slate-500">
                {detail ? `${detail(r)} · ` : ""}
                Attempts: {r.attemptsUsed} of {r.attemptsAllowed}
                {r.lastSubmittedAt ? ` · submitted ${formatDateTime(r.lastSubmittedAt, timeZone)}, receipt ${r.lastReceipt}` : ""}
              </p>
            </div>
            {action?.(r)}
          </li>
        );
      })}
    </ul>
  );
}
