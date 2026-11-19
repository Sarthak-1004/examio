import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { assertDisposableDatabase, boards, createDb, mediums, schoolMemberships, schools, userMfa, users, type RequestContext } from "@examio/db";
import { hashPassword } from "../src/auth/password";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: path.join(root, ".env"), quiet: true });

// Every fixture helper below writes or truncates: refuse anything but a disposable database.
assertDisposableDatabase(process.env.TEST_DATABASE_OWNER_URL ?? "", "run integration tests against");
assertDisposableDatabase(process.env.TEST_DATABASE_URL ?? "", "run integration tests against");

/** Owner connection — bypasses RLS. Only for arranging fixtures and asserting ground truth. */
export const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!, { max: 2 });
/** App connection — the restricted role the web app uses. Everything under test runs through this. */
export const app = createDb(process.env.TEST_DATABASE_URL!, { max: 4 });

export async function truncateAll() {
  await owner.db.execute(
    sql`truncate rate_limit_buckets, payroll_payments, payroll_adjustments, payroll_slips, payroll_runs, staff_salary_lines, staff_salaries, payroll_components, hr_staff_attendance_changes, hr_staff_attendance, hr_leave_requests, hr_leave_types, hr_documents, hr_payment_details, hr_employment_events, hr_employment, hr_designations, hr_departments, transport_assignments, transport_stops, transport_routes, transport_vehicles, inventory_asset_events, inventory_movements, inventory_stock, inventory_allocations, inventory_assets, inventory_items, inventory_locations, library_loans, library_copies, library_titles, library_settings, admission_events, admission_documents, admission_applications, result_changes, offline_marks, offline_assessment_targets, offline_assessments, exam_results, exam_marks, exam_graders, exam_result_sets, exam_answers, exam_attempts, exam_accommodations, exam_targets, exam_items, exams, practice_answers, practice_attempts, practice_assignments, practice_set_items, practice_sets, question_versions, questions, topics, payment_events, fee_counters, fee_adjustments, ledger_entries, payments, invoice_lines, invoices, fee_concessions, fee_structure_items, fee_structures, fee_heads, submission_feedback, submission_files, homework_submissions, homework_files, homework, announcements, attendance_changes, attendance_records, timetable_slots, student_documents, guardian_links, enrollments, student_profiles, class_teachers, teacher_assignments, staff_profiles, calendar_events, class_subjects, sections, grading_bands, grading_schemes, subjects, classes, academic_years, attendance_sessions, files, idempotency_records, notifications, jobs, worker_heartbeats, user_mfa_recovery_codes, user_mfa, support_access_grants, account_tokens, membership_invitations, audit_events, sessions, school_memberships, users, schools, boards, mediums restart identity cascade`,
  );
}

let cachedHash: string | undefined;
export async function pwHash() {
  return (cachedHash ??= await hashPassword("Passw0rd!"));
}

export async function makeUser(over: Partial<typeof users.$inferInsert> = {}, opts: { mfa?: boolean } = {}) {
  const id = randomUUID();
  await owner.db.insert(users).values({
    id,
    fullName: "Test User",
    email: `${id}@test.local`,
    passwordHash: await pwHash(),
    ...over,
  });
  // Platform access requires a confirmed authenticator; fixtures get one unless a test opts out.
  if (over.isPlatformAdmin && opts.mfa !== false) {
    await owner.db.insert(userMfa).values({ userId: id, secretEnc: "fixture-not-a-real-secret", confirmedAt: new Date() });
  }
  return id;
}

export async function makeLookups() {
  const [b] = await owner.db.insert(boards).values({ name: `Board ${randomUUID()}` }).returning();
  const [m] = await owner.db.insert(mediums).values({ name: `Medium ${randomUUID()}` }).returning();
  return { boardId: b!.id, mediumId: m!.id };
}

/** A school with an admin, a teacher and a student. */
export async function makeSchool(code: string) {
  const { boardId, mediumId } = await makeLookups();
  const id = randomUUID();
  await owner.db.insert(schools).values({ id, name: `School ${code}`, code, boardId, mediumId, status: "active" });
  const adminId = await makeUser({ fullName: `${code} admin` });
  const teacherId = await makeUser({ fullName: `${code} teacher` });
  const studentId = await makeUser({ fullName: `${code} student`, email: null, username: `${code}1001` });
  await owner.db.insert(schoolMemberships).values([
    { schoolId: id, userId: adminId, role: "school_admin" },
    { schoolId: id, userId: teacherId, role: "teacher" },
    { schoolId: id, userId: studentId, role: "student" },
  ]);
  const ctx = (userId: string): RequestContext => ({ userId, schoolId: id, isPlatformAdmin: false });
  return { id, adminId, teacherId, studentId, ctx };
}
