import Link from "next/link";
import type { FamilyHomeworkRow } from "@examio/core";
import { Badge, EmptyState } from "./ui";

const when = (d: Date) => new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

/** Homework as a student or parent sees it, with the submission state. */
export function HomeworkList({ rows, hrefFor, empty = "No homework right now." }: { rows: FamilyHomeworkRow[]; hrefFor: (id: string) => string; empty?: string }) {
  if (rows.length === 0) return <EmptyState title="No homework">{empty}</EmptyState>;
  const now = Date.now();
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((h) => {
        const overdue = !h.submittedAt && new Date(h.dueAt).getTime() < now;
        return (
          <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
            <span>
              <Link href={hrefFor(h.id)} className="font-medium text-brand-700 hover:underline">
                {h.title}
              </Link>
              <span className="block text-xs text-slate-500">
                {h.subjectName} · due {when(h.dueAt)}
              </span>
            </span>
            {h.returned ? (
              <Badge tone="blue">Feedback returned</Badge>
            ) : h.submittedAt ? (
              <Badge tone={h.late ? "amber" : "green"}>{h.late ? "Submitted late" : "Submitted"}</Badge>
            ) : overdue ? (
              <Badge tone="red">{h.allowLate ? "Overdue" : "Missed"}</Badge>
            ) : (
              <Badge>To do</Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}
