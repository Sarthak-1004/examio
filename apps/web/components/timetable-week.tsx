import type { ReactNode } from "react";
import { WEEKDAY_NAMES, formatMinutes, type TimetableSlot } from "@examio/core";
import { EmptyState } from "./ui";

/**
 * A weekly timetable as a list per weekday (readable on phones and by screen readers; no wide
 * grid). `show` picks the secondary line: the section (teacher's view) or the teacher.
 */
export function TimetableWeek({
  slots,
  show,
  action,
  emptyText = "No periods yet.",
}: {
  slots: TimetableSlot[];
  show: "section" | "teacher" | "none";
  action?: (slot: TimetableSlot) => ReactNode;
  emptyText?: string;
}) {
  if (slots.length === 0) return <EmptyState title="No timetable">{emptyText}</EmptyState>;
  const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => slots.some((s) => s.weekday === d));
  return (
    <div className="divide-y divide-slate-100">
      {days.map((d) => (
        <section key={d} aria-labelledby={`tt-day-${d}`} className="px-5 py-3">
          <h3 id={`tt-day-${d}`} className="mb-2 text-sm font-semibold text-slate-900">
            {WEEKDAY_NAMES[d - 1]}
          </h3>
          <ul className="space-y-1">
            {slots
              .filter((s) => s.weekday === d)
              .map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    <span className="inline-block w-28 tabular-nums text-slate-600">
                      {formatMinutes(s.startMinute)}–{formatMinutes(s.endMinute)}
                    </span>
                    <span className="font-medium text-slate-900">{s.subjectName}</span>
                    {show === "section" && <span className="text-slate-600"> · {s.sectionLabel}</span>}
                    {show === "teacher" && s.teacherName && <span className="text-slate-600"> · {s.teacherName}</span>}
                    {s.room && <span className="text-slate-500"> · {s.room}</span>}
                  </span>
                  {action?.(s)}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
