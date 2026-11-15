import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schools, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { addDays, schoolToday } from "../../dates";
import { AppError } from "../../errors";
import { isoDate, parse } from "../setup/common";

/**
 * Attendance settings and school days (Phase 6).
 *
 * A school day is a date inside an academic year that is not one of the school's weekly days off
 * and not inside a holiday on the school calendar. Attendance is only taken on school days.
 */

export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** ISO weekday (1 = Monday … 7 = Sunday) of a YYYY-MM-DD date. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export interface AttendanceSettings {
  timezone: string;
  today: string;
  editDays: number;
  weeklyOffDays: number[];
  lockedThrough: string | null;
}

export async function attendanceSettingsTx(tx: Tx, schoolId: string): Promise<AttendanceSettings> {
  const [s] = await tx
    .select({ timezone: schools.timezone, editDays: schools.attendanceEditDays, off: schools.weeklyOffDays, locked: schools.attendanceLockedThrough })
    .from(schools)
    .where(eq(schools.id, schoolId));
  if (!s) throw new AppError("NOT_FOUND", "School not found.");
  return { timezone: s.timezone, today: schoolToday(s.timezone), editDays: s.editDays, weeklyOffDays: [...s.off].sort(), lockedThrough: s.locked };
}

export async function getAttendanceSettings(db: Db, ctx: RequestContext, schoolId: string): Promise<AttendanceSettings> {
  return withCapability(db, ctx, schoolId, "school.attendance.mark", (tx) => attendanceSettingsTx(tx, schoolId));
}

const settingsSchema = z.object({
  editDays: z.coerce.number({ message: "Enter a number of days." }).int("Enter a whole number of days.").min(0, "At least 0 days.").max(31, "At most 31 days."),
  weeklyOffDays: z.array(z.coerce.number().int().min(1).max(7)).max(6, "At least one day of the week must be a school day."),
  lockedThrough: z.union([z.literal("").transform(() => null), isoDate("lock date")]).nullable().optional(),
});

/** Changes the edit window, weekly days off and lock date. Locking a future date is refused. */
export async function updateAttendanceSettings(db: Db, ctx: RequestContext, schoolId: string, input: z.input<typeof settingsSchema>): Promise<void> {
  const d = parse(settingsSchema, input);
  await withCapability(db, ctx, schoolId, "school.attendance.manage", async (tx, actor) => {
    const cur = await attendanceSettingsTx(tx, schoolId);
    const locked = d.lockedThrough ?? null;
    if (locked && locked > cur.today) throw new AppError("VALIDATION", "The lock date cannot be in the future.", { lockedThrough: "In the future." });
    const off = [...new Set(d.weeklyOffDays)].sort();
    await tx.update(schools).set({ attendanceEditDays: d.editDays, weeklyOffDays: off, attendanceLockedThrough: locked }).where(eq(schools.id, schoolId));
    await audit(tx, { action: "attendance.settings_changed", actorUserId: actor.userId, schoolId, entityType: "school", entityId: schoolId, data: { editDays: d.editDays, weeklyOffDays: off, lockedThrough: locked, previousLock: cur.lockedThrough } });
  });
}

export type NonSchoolDayReason = "weekly_off" | "holiday" | "outside_year" | "future";

export interface DayInfo {
  date: string;
  schoolDay: boolean;
  reason: NonSchoolDayReason | null;
  /** Calendar entries covering the date (holidays, events, exam periods). */
  events: { title: string; kind: "holiday" | "event" | "exam" }[];
}

/** Day information for every date from..to (inclusive) for one academic year. */
export async function daysInRange(tx: Tx, schoolId: string, yearId: string, from: string, to: string, settings: AttendanceSettings): Promise<DayInfo[]> {
  const [y] = (await tx.execute(sql`select starts_on::text as "startsOn", ends_on::text as "endsOn" from academic_years where school_id = ${schoolId}::uuid and id = ${yearId}::uuid`)) as unknown as { startsOn: string; endsOn: string }[];
  if (!y) throw new AppError("NOT_FOUND", "Academic year not found.");
  const events = (await tx.execute(sql`
    select title, kind::text as kind, starts_on::text as "startsOn", ends_on::text as "endsOn" from calendar_events
    where school_id = ${schoolId}::uuid and academic_year_id = ${yearId}::uuid and starts_on <= ${to}::date and ends_on >= ${from}::date
    order by starts_on`)) as unknown as { title: string; kind: "holiday" | "event" | "exam"; startsOn: string; endsOn: string }[];
  const out: DayInfo[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const here = events.filter((e) => e.startsOn <= d && e.endsOn >= d).map((e) => ({ title: e.title, kind: e.kind }));
    let reason: NonSchoolDayReason | null = null;
    if (d < y.startsOn || d > y.endsOn) reason = "outside_year";
    else if (settings.weeklyOffDays.includes(isoWeekday(d))) reason = "weekly_off";
    else if (here.some((e) => e.kind === "holiday")) reason = "holiday";
    else if (d > settings.today) reason = "future";
    out.push({ date: d, schoolDay: reason === null, reason, events: here });
    if (out.length > 400) throw new AppError("VALIDATION", "Choose a period of at most 400 days.");
  }
  return out;
}

export const NON_SCHOOL_DAY_MESSAGE: Record<NonSchoolDayReason, string> = {
  weekly_off: "That day is a weekly day off.",
  holiday: "That day is a holiday on the school calendar.",
  outside_year: "That date is outside the section's academic year.",
  future: "Attendance cannot be taken for a future date.",
};
