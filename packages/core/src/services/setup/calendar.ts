import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { academicYears, attendanceSessions, calendarEvents, type Db, type RequestContext } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import { isoDate, mapSetupError, parse, trimmed, uuidField } from "./common";

/**
 * School calendar (holidays, events, exam periods) and attendance sessions.
 * - Calendar entries are local school dates and must fall inside their academic year.
 * - Attendance sessions are per school (not per year). A school always keeps at least one
 *   active session; a session in use is archived rather than deleted.
 */
export type CalendarKind = "holiday" | "event" | "exam";

export interface CalendarEntry {
  id: string;
  title: string;
  kind: CalendarKind;
  startsOn: string;
  endsOn: string;
}

const entrySchema = z
  .object({
    title: trimmed("Title", 1, 120),
    kind: z.enum(["holiday", "event", "exam"], { message: "Choose holiday, event or exam." }),
    startsOn: isoDate("start date"),
    endsOn: isoDate("end date"),
  })
  .refine((e) => e.startsOn <= e.endsOn, { message: "The end date cannot be before the start date.", path: ["endsOn"] });
export type CalendarInput = z.input<typeof entrySchema>;

export async function listCalendar(db: Db, ctx: RequestContext, schoolId: string, yearId: string): Promise<CalendarEntry[]> {
  parse(uuidField("Academic year"), yearId);
  return withCapability(db, ctx, schoolId, "school.setup.view", (tx) =>
    tx
      .select({ id: calendarEvents.id, title: calendarEvents.title, kind: calendarEvents.kind, startsOn: calendarEvents.startsOn, endsOn: calendarEvents.endsOn })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.schoolId, schoolId), eq(calendarEvents.academicYearId, yearId)))
      .orderBy(asc(calendarEvents.startsOn), asc(calendarEvents.id)),
  );
}

export async function addCalendarEntry(db: Db, ctx: RequestContext, schoolId: string, yearId: string, input: CalendarInput): Promise<{ id: string }> {
  parse(uuidField("Academic year"), yearId);
  const data = parse(entrySchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const [y] = await tx
        .select({ startsOn: academicYears.startsOn, endsOn: academicYears.endsOn, status: academicYears.status })
        .from(academicYears)
        .where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.id, yearId)));
      if (!y) throw new AppError("NOT_FOUND", "Academic year not found.");
      if (y.status === "closed") throw new AppError("CONFLICT", "This academic year is closed. Reopen it to make changes.");
      if (data.startsOn < y.startsOn || data.endsOn > y.endsOn) {
        throw new AppError("VALIDATION", `Dates must fall within the academic year (${y.startsOn} to ${y.endsOn}).`, { startsOn: "Outside the academic year." });
      }
      const [row] = await tx.insert(calendarEvents).values({ schoolId, academicYearId: yearId, ...data }).returning({ id: calendarEvents.id });
      await audit(tx, { action: "setup.calendar.added", actorUserId: actor.userId, schoolId, entityType: "calendar_event", entityId: row!.id, data: { yearId, ...data } });
      return { id: row!.id };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e);
  }
}

export async function deleteCalendarEntry(db: Db, ctx: RequestContext, schoolId: string, entryId: string): Promise<void> {
  parse(uuidField("Calendar entry"), entryId);
  try {
    await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const deleted = await tx
        .delete(calendarEvents)
        .where(and(eq(calendarEvents.schoolId, schoolId), eq(calendarEvents.id, entryId)))
        .returning({ id: calendarEvents.id, title: calendarEvents.title });
      if (deleted.length === 0) throw new AppError("NOT_FOUND", "Calendar entry not found, or its year is closed.");
      await audit(tx, { action: "setup.calendar.deleted", actorUserId: actor.userId, schoolId, entityType: "calendar_event", entityId: entryId, data: { title: deleted[0]!.title } });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e);
  }
}

/* ------------------------------------------------------------------ attendance sessions */

export interface AttendanceSession {
  id: string;
  name: string;
  sortOrder: number;
  archived: boolean;
}

const sessionSchema = z.object({
  name: trimmed("Session name", 1, 40),
  sortOrder: z.coerce.number().int("Order must be a whole number.").min(-1000).max(1000).default(0),
});
export type SessionInput = z.input<typeof sessionSchema>;
const sessionDuplicate = { attendance_sessions_school_name_unique: ["name", "A session with this name already exists."] as [string, string] };

export async function listAttendanceSessions(db: Db, ctx: RequestContext, schoolId: string, opts: { includeArchived?: boolean } = {}): Promise<AttendanceSession[]> {
  return withCapability(db, ctx, schoolId, "school.setup.view", async (tx) => {
    const rows = await tx
      .select({ id: attendanceSessions.id, name: attendanceSessions.name, sortOrder: attendanceSessions.sortOrder, archivedAt: attendanceSessions.archivedAt })
      .from(attendanceSessions)
      .where(and(eq(attendanceSessions.schoolId, schoolId), opts.includeArchived ? undefined : isNull(attendanceSessions.archivedAt)))
      .orderBy(asc(attendanceSessions.sortOrder), asc(attendanceSessions.name));
    return rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sortOrder, archived: r.archivedAt !== null }));
  });
}

export async function createAttendanceSession(db: Db, ctx: RequestContext, schoolId: string, input: SessionInput): Promise<{ id: string }> {
  const data = parse(sessionSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const [row] = await tx.insert(attendanceSessions).values({ schoolId, ...data }).returning({ id: attendanceSessions.id });
      await audit(tx, { action: "setup.session.created", actorUserId: actor.userId, schoolId, entityType: "attendance_session", entityId: row!.id, data: { name: data.name } });
      return { id: row!.id };
    });
  } catch (e) {
    mapSetupError(e, { duplicate: sessionDuplicate });
  }
}

/** Archive or restore a session. The last active session cannot be archived. */
export async function setAttendanceSessionArchived(db: Db, ctx: RequestContext, schoolId: string, sessionId: string, archived: boolean): Promise<void> {
  parse(uuidField("Session"), sessionId);
  await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
    if (archived) {
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(attendanceSessions)
        .where(and(eq(attendanceSessions.schoolId, schoolId), isNull(attendanceSessions.archivedAt)));
      if ((count?.n ?? 0) <= 1) throw new AppError("CONFLICT", "A school needs at least one attendance session.");
    }
    const updated = await tx
      .update(attendanceSessions)
      .set({ archivedAt: archived ? sql`now()` : null })
      .where(and(eq(attendanceSessions.schoolId, schoolId), eq(attendanceSessions.id, sessionId)))
      .returning({ id: attendanceSessions.id });
    if (updated.length === 0) throw new AppError("NOT_FOUND", "Session not found.");
    await audit(tx, { action: `setup.session.${archived ? "archived" : "restored"}`, actorUserId: actor.userId, schoolId, entityType: "attendance_session", entityId: sessionId });
  });
}
