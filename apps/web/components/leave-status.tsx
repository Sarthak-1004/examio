import { Badge } from "./ui";

const STATUS: Record<string, { label: string; tone: "amber" | "green" | "red" | "slate" }> = {
  pending: { label: "Pending", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  cancelled: { label: "Cancelled", tone: "slate" },
};

/** A leave request's status as a badge. */
export function LeaveStatus({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "slate" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** "3 Nov – 5 Nov · 3 days" style dates for a request. */
export function leaveDates(r: { fromOn: string; toOn: string; halfDay: boolean; days: string }): string {
  const range = r.fromOn === r.toOn ? r.fromOn : `${r.fromOn} to ${r.toOn}`;
  return `${range} · ${r.halfDay ? "half day" : `${r.days} day${r.days === "1" ? "" : "s"}`}`;
}
