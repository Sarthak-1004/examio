import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { academicYears, schools, type Tx } from "@examio/db";
import { schoolToday } from "../../dates";
import { AppError } from "../../errors";

/** Shared rules for students, enrollments and guardians (Phase 5). */

export const admissionNo = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$/, "Admission number: up to 30 letters, digits, / _ or -, starting with a letter or digit.");

export const LEAVE_REASONS = ["withdrawn", "transferred", "graduated", "other"] as const;
export type LeaveReason = (typeof LEAVE_REASONS)[number];
export const RELATIONSHIPS = ["mother", "father", "guardian", "other"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/**
 * A student's sign-in name: the school code and the admission number, e.g. "gvps.2026-014".
 * Students often have no email or phone of their own.
 */
export function studentUsername(schoolCode: string, admission: string): string {
  const part = admission
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${schoolCode.toLowerCase()}.${part || "student"}`;
}

export async function schoolInfo(tx: Tx, schoolId: string): Promise<{ code: string; timezone: string; today: string }> {
  const [s] = await tx.select({ code: schools.code, timezone: schools.timezone }).from(schools).where(eq(schools.id, schoolId));
  if (!s) throw new AppError("NOT_FOUND", "School not found.");
  return { code: s.code, timezone: s.timezone, today: schoolToday(s.timezone) };
}

export interface SectionYear {
  sectionId: string;
  yearId: string;
  yearName: string;
  startsOn: string;
  endsOn: string;
  status: "planned" | "current" | "closed";
  label: string;
}

/** A section of this school that can take enrollments: its year open, the section not archived. */
export async function openSection(tx: Tx, schoolId: string, sectionId: string): Promise<SectionYear> {
  const rows = (await tx.execute(sql`
    select s.id as section_id, y.id as year_id, y.name as year_name, y.starts_on::text as starts_on, y.ends_on::text as ends_on,
           y.status::text as status, c.name || ' ' || s.name as label, (s.archived_at is not null or c.archived_at is not null) as archived
    from sections s join academic_years y on y.id = s.academic_year_id join classes c on c.id = s.class_id
    where s.school_id = ${schoolId}::uuid and s.id = ${sectionId}::uuid`)) as unknown as {
    section_id: string; year_id: string; year_name: string; starts_on: string; ends_on: string; status: SectionYear["status"]; label: string; archived: boolean;
  }[];
  const s = rows[0];
  if (!s) throw new AppError("NOT_FOUND", "Section not found.");
  if (s.status === "closed") throw new AppError("CONFLICT", "That academic year is closed. Reopen it to change enrollments.");
  if (s.archived) throw new AppError("CONFLICT", "That section is archived.");
  return { sectionId: s.section_id, yearId: s.year_id, yearName: s.year_name, startsOn: s.starts_on, endsOn: s.ends_on, status: s.status, label: s.label };
}

/** The school's current academic year, if one is set. */
export async function currentYearId(tx: Tx, schoolId: string): Promise<string | null> {
  const [y] = await tx.select({ id: academicYears.id }).from(academicYears).where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.status, "current")));
  return y?.id ?? null;
}

/** Clamp a start date into the year: default today (or the year's start if it has not begun). */
export function startWithinYear(year: { startsOn: string; endsOn: string }, today: string, requested?: string | null, notBefore?: string | null): string {
  let start = requested ?? (today < year.startsOn ? year.startsOn : today > year.endsOn ? year.startsOn : today);
  if (!requested && notBefore && start < notBefore) start = notBefore;
  if (start < year.startsOn || start > year.endsOn) {
    throw new AppError("VALIDATION", `The start date must be within the academic year (${year.startsOn} to ${year.endsOn}).`, { startsOn: "Outside the academic year." });
  }
  if (notBefore && start < notBefore) {
    throw new AppError("VALIDATION", `The start date cannot be before the admission date (${notBefore}).`, { startsOn: "Before the admission date." });
  }
  return start;
}
