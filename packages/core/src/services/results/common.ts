import { sql } from "drizzle-orm";
import type { Tx } from "@examio/db";
import { AppError } from "../../errors";
import type { GradeBand } from "../setup/grading";

/**
 * Shared result arithmetic (Phase 12). Marks are integers in hundredths; percentages in basis
 * points. Grades are evaluated against the exact (unrounded) fraction: a score earns a band when
 * score × 10000 ≥ band minimum × maximum. The displayed percentage is rounded half-up to two
 * decimals. A zero maximum never reaches here (the database refuses it).
 */

/** Percentage in basis points, rounded half-up (for display). */
export function percentBp(scoreX100: number, maxX100: number): number {
  if (maxX100 <= 0) throw new Error("A result needs a positive maximum");
  return Math.floor((2 * scoreX100 * 10000 + maxX100) / (2 * maxX100));
}

/** The band whose minimum the exact fraction reaches; bands must include one starting at 0. */
export function gradeOf(scoreX100: number, maxX100: number, bands: readonly GradeBand[]): string {
  const sorted = [...bands].sort((a, b) => b.minBp - a.minBp);
  const band = sorted.find((b) => scoreX100 * 10000 >= b.minBp * maxX100);
  if (!band) throw new Error("Grading scheme has no band starting at 0");
  return band.label;
}

export function passesExact(scoreX100: number, maxX100: number, passBp: number): boolean {
  return scoreX100 * 10000 >= passBp * maxX100;
}

export interface SchemeInfo {
  id: string;
  name: string;
  passBp: number;
  bands: GradeBand[];
}

/** A grading scheme with its bands (any member may read them). */
export async function schemeById(tx: Tx, schemeId: string): Promise<SchemeInfo> {
  const [s] = (await tx.execute(sql`select id, name, pass_bp as "passBp" from grading_schemes where id = ${schemeId}::uuid`)) as unknown as Omit<SchemeInfo, "bands">[];
  if (!s) throw new Error("grading scheme not found");
  const bands = (await tx.execute(sql`select label, min_bp as "minBp", description from grading_bands where scheme_id = ${schemeId}::uuid order by min_bp desc`)) as unknown as GradeBand[];
  return { ...s, bands };
}

/** The school's current default scheme, or null when none is set. */
export async function defaultScheme(tx: Tx, schoolId: string): Promise<SchemeInfo | null> {
  const [s] = (await tx.execute(sql`select id from grading_schemes where school_id = ${schoolId}::uuid and is_default and archived_at is null`)) as unknown as { id: string }[];
  return s ? schemeById(tx, s.id) : null;
}

const MESSAGES: Record<string, [AppError["code"], string]> = {
  exam_not_found: ["NOT_FOUND", "Exam not found."],
  exam_not_gradable: ["CONFLICT", "Only a published exam can be graded."],
  exam_still_open: ["CONFLICT", "The exam is still open. Grading starts after it closes."],
  attempts_in_progress: ["CONFLICT", "Some students with extra time are still writing. Try again when they finish."],
  attempt_not_found: ["NOT_FOUND", "Attempt not found."],
  grading_not_started: ["CONFLICT", "Grading has not started for this exam."],
  results_released: ["CONFLICT", "Results are already released. Use a correction, with a reason."],
  results_not_released: ["CONFLICT", "Results are not released yet; change the marks in grading instead."],
  attempt_not_counted: ["CONFLICT", "This attempt does not count for the student's result."],
  item_not_found: ["NOT_FOUND", "That question is not part of this exam."],
  item_computed: ["CONFLICT", "Single-choice and true/false questions are scored automatically."],
  marks_out_of_range: ["VALIDATION", "Marks must be between 0 and the maximum."],
  result_not_found: ["NOT_FOUND", "Result not found."],
  reason_required: ["VALIDATION", "Give a reason (at least 3 characters)."],
  grading_incomplete: ["CONFLICT", "Some written answers are not marked yet."],
  no_grading_scheme: ["CONFLICT", "Set a default grading scheme in School setup first."],
  assessment_not_found: ["NOT_FOUND", "Assessment not found."],
  assessment_locked: ["CONFLICT", "Marks are locked. An administrator can correct them with a reason."],
  assessment_not_locked: ["CONFLICT", "Marks are not locked yet; change them in the register."],
  student_not_in_assessment: ["NOT_FOUND", "That student is not in a section of this assessment."],
  not_allowed: ["FORBIDDEN", "Only the subject's teacher of this section, or an administrator, can enter these marks."],
  invalid_status: ["VALIDATION", "Choose marks, absent or exempt."],
  register_incomplete: ["CONFLICT", "Every student needs marks, absent or exempt before the marks can be locked."],
  transition_not_allowed: ["CONFLICT", "That step is not possible now."],
};

/** Turns a refusal raised by a grading database function into an AppError. */
export function resultsError(e: unknown): never {
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && i < 5; cur = (cur as { cause?: unknown }).cause, i++) {
    const msg = (cur as { message?: unknown }).message;
    if (typeof msg === "string" && msg in MESSAGES) {
      const [code, text] = MESSAGES[msg]!;
      throw new AppError(code, text);
    }
  }
  throw e;
}

/** "12.5" → 1250 hundredths; null unless 0..max with at most two decimals. */
export function parseMarksX100(input: string, maxX100 = 100_000): number | null {
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const v = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return v <= maxX100 ? v : null;
}
