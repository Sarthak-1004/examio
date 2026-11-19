import type { SchoolAccess } from "@examio/core";
import { Alert } from "./ui";

/**
 * The school's subscription state, shown above every school page (Phase 15.1): renewal due,
 * grace, or read-only. Nothing is shown while the subscription is active.
 */
export function AccessBanner({ a, isAdmin }: { a: SchoolAccess; isAdmin: boolean }) {
  const contact = isAdmin ? "Renew through the Examio team; see Subscription." : "Ask the school office about renewal.";
  if (a.access === "due" && a.daysLeft !== null) {
    return (
      <div className="mb-4 print:hidden">
        <Alert tone="amber">{`The school's Examio subscription ends on ${a.endsOn} (${a.daysLeft} day${a.daysLeft === 1 ? "" : "s"} left). ${contact}`}</Alert>
      </div>
    );
  }
  if (a.access === "grace") {
    return (
      <div className="mb-4 print:hidden">
        <Alert tone="amber">{`The school's Examio subscription ended on ${a.endsOn}. Everything works until ${a.graceEndsOn}; after that Examio becomes read-only. ${contact}`}</Alert>
      </div>
    );
  }
  if (a.access === "read_only") {
    return (
      <div className="mb-4 print:hidden">
        <Alert tone="red">{`The school's Examio subscription has ended, so Examio is read-only: you can view, print and export, but not make changes. An exam already started can still be finished. Nothing has been deleted. ${contact}`}</Alert>
      </div>
    );
  }
  return null;
}

/** The optional module behind a navigation link, if any (links of modules outside the plan are hidden). */
export const MODULE_OF_PATH: [prefix: string, module: SchoolAccess["modules"][number]][] = [
  ["/school/admissions", "admissions"],
  ["/school/library", "library"],
  ["/school/inventory", "inventory"],
  ["/school/transport", "transport"],
  ["/school/hr", "hr"],
  ["/school/my-leave", "hr"],
  ["/school/payroll", "payroll"],
  ["/school/my-payslips", "payroll"],
  ["/school/fees", "fees"],
  ["/school/practice", "practice"],
  ["/school/exams", "exams"],
  ["/school/results", "exams"],
  ["/student/exams", "exams"],
  ["/student/results", "exams"],
  ["/student/practice", "practice"],
  ["/student/progress", "practice"],
  ["/student/library", "library"],
  ["/student/transport", "transport"],
  ["/parent/fees", "fees"],
];

/** Keeps navigation items whose module (if any) is in the school's plan. */
export function withinPlan<T extends { href: string }>(items: T[], modules: readonly string[]): T[] {
  return items.filter((i) => {
    const m = MODULE_OF_PATH.find(([prefix]) => i.href === prefix || i.href.startsWith(`${prefix}/`));
    return !m || modules.includes(m[1]);
  });
}
