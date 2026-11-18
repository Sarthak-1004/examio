import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { enrollments, schoolMemberships, studentProfiles, users, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { issueAccountCodeInTransaction } from "../../auth/recovery";
import { withCapability } from "../../capabilities";
import { toCsv } from "../../csv";
import { AppError } from "../../errors";
import { likePattern, toPage, type Page, type PageRequest } from "../../paging";
import { isoDate, mapSetupError, parse, trimmed, uuidField } from "../setup/common";
import { LEAVE_REASONS, admissionNo, currentYearId, openSection, schoolInfo, startWithinYear, studentUsername, type LeaveReason } from "./common";

/**
 * Students of a school (Phase 5).
 *
 * - Admission: the school creates the student's account (username = school code + admission
 *   number, no usable password) and gets a one-time activation code to hand over; optionally the
 *   student is enrolled in a section at once. Someone who already has an Examio account joins by
 *   invitation and is then given student details.
 * - The admission number is unique in the school, ignoring case, and cannot be changed.
 * - Leaving (withdrawn, transferred, graduated, other): access ends at once (student membership
 *   revoked) and open enrollments in open years end on the leaving date. Nothing is deleted.
 *   Guardian links stay, so parents still see the record of a child who has left.
 */

const optionalDate = (label: string) => z.union([z.literal("").transform(() => null), isoDate(label)]).nullable().optional();
const optionalRoll = z
  .union([z.literal("").transform(() => null), z.coerce.number({ message: "Roll number must be a whole number." }).int("Roll number must be a whole number.").min(1, "Roll number must be 1 or more.").max(9999, "Roll number is too large.")])
  .nullable()
  .optional();

const admitSchema = z.object({
  fullName: trimmed("Full name", 2, 120),
  admissionNo,
  admittedOn: optionalDate("admission date"),
  dateOfBirth: optionalDate("date of birth"),
  sectionId: z.union([z.literal("").transform(() => null), z.uuid({ message: "Section not found." })]).nullable().optional(),
  rollNo: optionalRoll,
});
export type AdmitStudentInput = z.input<typeof admitSchema>;

const profileSchema = z.object({
  displayName: trimmed("Name", 2, 120),
  admittedOn: isoDate("admission date"),
  dateOfBirth: optionalDate("date of birth"),
});
export type StudentProfileInput = z.input<typeof profileSchema>;

export const studentDuplicate: Record<string, [string, string]> = {
  student_profiles_school_admission_unique: ["admissionNo", "Another student already has this admission number."],
  student_profiles_school_user_unique: ["userId", "This person already has a student record here."],
  users_username_unique: ["admissionNo", "This admission number gives the same sign-in name as an existing account (for example A/1 and A-1). Use a different admission number."],
  enrollments_one_open_per_year: ["sectionId", "This student is already enrolled in that academic year."],
  enrollments_roll_unique_open: ["rollNo", "Another student in that section has this roll number."],
};

function checkDates(admittedOn: string, dateOfBirth: string | null | undefined): void {
  if (dateOfBirth && dateOfBirth >= admittedOn) {
    throw new AppError("VALIDATION", "The date of birth must be before the admission date.", { dateOfBirth: "Not before the admission date." });
  }
}

/** Creates the account, membership and student record, optionally an enrollment, and an activation code. */
export async function admitStudent(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: AdmitStudentInput,
): Promise<{ studentId: string; userId: string; username: string; activationCode: string; codeExpiresAt: Date; enrollmentId: string | null }> {
  const d = parse(admitSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.students.manage", async (tx, actor) => {
      const school = await schoolInfo(tx, schoolId);
      const admittedOn = d.admittedOn ?? school.today;
      checkDates(admittedOn, d.dateOfBirth);
      const created = await createStudentInTransaction(tx, ctx, actor.userId, schoolId, school, {
        fullName: d.fullName,
        admissionNo: d.admissionNo,
        admittedOn,
        dateOfBirth: d.dateOfBirth ?? null,
        sectionId: d.sectionId ?? null,
        rollNo: d.rollNo ?? null,
      });
      return created;
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: studentDuplicate });
  }
}

export interface NewStudentRecord {
  fullName: string;
  admissionNo: string;
  admittedOn: string;
  dateOfBirth: string | null;
  sectionId: string | null;
  rollNo: number | null;
}

/** Shared by admission and import: one student, inside the caller's transaction. */
export async function createStudentInTransaction(
  tx: Tx,
  ctx: RequestContext,
  actorUserId: string,
  schoolId: string,
  school: { code: string; today: string },
  r: NewStudentRecord,
): Promise<{ studentId: string; userId: string; username: string; activationCode: string; codeExpiresAt: Date; enrollmentId: string | null }> {
  // The id is generated here: the new account is not visible to the admin until the membership
  // exists, so the database cannot return it. No usable password until the code is redeemed.
  // Checked first: a duplicate admission number would otherwise surface as a clashing sign-in name.
  const [taken] = await tx
    .select({ id: studentProfiles.id })
    .from(studentProfiles)
    .where(and(eq(studentProfiles.schoolId, schoolId), sql`lower(${studentProfiles.admissionNo}) = lower(${r.admissionNo})`));
  if (taken) throw new AppError("CONFLICT", "Another student already has this admission number.", { admissionNo: "Already in use." });
  const userId = randomUUID();
  const username = studentUsername(school.code, r.admissionNo);
  await tx.insert(users).values({ id: userId, fullName: r.fullName, username, passwordHash: "!" });
  await tx.insert(schoolMemberships).values({ schoolId, userId, role: "student" });
  const [profile] = await tx
    .insert(studentProfiles)
    .values({ schoolId, userId, admissionNo: r.admissionNo, displayName: r.fullName, admittedOn: r.admittedOn, dateOfBirth: r.dateOfBirth })
    .returning({ id: studentProfiles.id });
  const studentId = profile!.id;
  let enrollmentId: string | null = null;
  if (r.sectionId) {
    const sec = await openSection(tx, schoolId, r.sectionId);
    const startsOn = startWithinYear(sec, school.today, null, r.admittedOn > sec.endsOn ? null : r.admittedOn);
    const [e] = await tx
      .insert(enrollments)
      .values({ schoolId, studentId, academicYearId: sec.yearId, sectionId: sec.sectionId, rollNo: r.rollNo, startsOn })
      .returning({ id: enrollments.id });
    enrollmentId = e!.id;
  }
  const code = await issueAccountCodeInTransaction(tx, { ...ctx, schoolId }, { userId, purpose: "activation", reason: "New student account created by a school administrator" });
  await audit(tx, { action: "student.admitted", actorUserId, schoolId, entityType: "student", entityId: studentId, data: { admissionNo: r.admissionNo, sectionId: r.sectionId } });
  return { studentId, userId, username, activationCode: code.code, codeExpiresAt: code.expiresAt, enrollmentId };
}

/** Student details for someone who joined the school as a student by invitation. */
export async function addStudentProfileForMember(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  userId: string,
  input: { displayName: string; admissionNo: string; admittedOn?: string | null; dateOfBirth?: string | null },
): Promise<{ studentId: string }> {
  parse(uuidField("Person"), userId);
  const d = parse(z.object({ displayName: trimmed("Name", 2, 120), admissionNo, admittedOn: optionalDate("admission date"), dateOfBirth: optionalDate("date of birth") }), input);
  try {
    return await withCapability(db, ctx, schoolId, "school.students.manage", async (tx, actor) => {
      const school = await schoolInfo(tx, schoolId);
      const admittedOn = d.admittedOn ?? school.today;
      checkDates(admittedOn, d.dateOfBirth);
      const [m] = await tx
        .select({ id: schoolMemberships.id })
        .from(schoolMemberships)
        .where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, userId), eq(schoolMemberships.status, "active"), eq(schoolMemberships.role, "student")));
      if (!m) throw new AppError("NOT_FOUND", "This person is not a student member of the school.");
      const [p] = await tx
        .insert(studentProfiles)
        .values({ schoolId, userId, admissionNo: d.admissionNo, displayName: d.displayName, admittedOn, dateOfBirth: d.dateOfBirth ?? null })
        .returning({ id: studentProfiles.id });
      await audit(tx, { action: "student.profile_added", actorUserId: actor.userId, schoolId, entityType: "student", entityId: p!.id, data: { admissionNo: d.admissionNo } });
      return { studentId: p!.id };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: studentDuplicate });
  }
}

export async function updateStudentProfile(db: Db, ctx: RequestContext, schoolId: string, studentId: string, input: StudentProfileInput): Promise<void> {
  parse(uuidField("Student"), studentId);
  const d = parse(profileSchema, input);
  checkDates(d.admittedOn, d.dateOfBirth);
  try {
    await withCapability(db, ctx, schoolId, "school.students.manage", async (tx, actor) => {
      const [first] = (await tx.execute(sql`select min(starts_on)::text as first from enrollments where school_id = ${schoolId}::uuid and student_id = ${studentId}::uuid`)) as unknown as { first: string | null }[];
      if (first?.first && d.admittedOn > first.first) {
        throw new AppError("VALIDATION", `The admission date cannot be after the first enrollment (${first.first}).`, { admittedOn: "After the first enrollment." });
      }
      const updated = await tx
        .update(studentProfiles)
        .set({ displayName: d.displayName, admittedOn: d.admittedOn, dateOfBirth: d.dateOfBirth ?? null, updatedAt: sql`now()` })
        .where(and(eq(studentProfiles.schoolId, schoolId), eq(studentProfiles.id, studentId)))
        .returning({ id: studentProfiles.id });
      if (updated.length === 0) throw new AppError("NOT_FOUND", "Student not found.");
      await audit(tx, { action: "student.updated", actorUserId: actor.userId, schoolId, entityType: "student", entityId: studentId });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: studentDuplicate });
  }
}

/**
 * A student leaves: access ends at once, open enrollments in open years end on the leaving date
 * (or their start date if they had not started). Enrollments in closed years end with the year.
 */
export async function markStudentLeft(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  studentId: string,
  input: { leftOn?: string | null; reason: string },
): Promise<{ endedEnrollments: number }> {
  parse(uuidField("Student"), studentId);
  const reason = parse(z.enum(LEAVE_REASONS, { message: "Choose why the student is leaving." }), input.reason);
  return withCapability(db, ctx, schoolId, "school.students.manage", (tx, actor) => leaveInTransaction(tx, actor.userId, schoolId, studentId, reason, input.leftOn ?? null));
}

export async function leaveInTransaction(tx: Tx, actorUserId: string, schoolId: string, studentId: string, reason: LeaveReason, leftOnInput: string | null): Promise<{ endedEnrollments: number }> {
  const [p] = await tx.select().from(studentProfiles).where(and(eq(studentProfiles.schoolId, schoolId), eq(studentProfiles.id, studentId)));
  if (!p) throw new AppError("NOT_FOUND", "Student not found.");
  if (p.status === "left") throw new AppError("CONFLICT", "This student has already left.");
  const leftOn = leftOnInput ? parse(isoDate("leaving date"), leftOnInput) : (await schoolInfo(tx, schoolId)).today;
  if (leftOn < p.admittedOn) throw new AppError("VALIDATION", "The leaving date cannot be before the admission date.", { leftOn: "Before the admission date." });
  await tx.update(studentProfiles).set({ status: "left", leftOn, leaveReason: reason, updatedAt: sql`now()` }).where(eq(studentProfiles.id, studentId));
  await tx
    .update(schoolMemberships)
    .set({ status: "revoked" })
    .where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, p.userId), eq(schoolMemberships.role, "student")));
  const ended = (await tx.execute(sql`
    update enrollments e set ends_on = greatest(e.starts_on, ${leftOn}::date), end_reason = 'left'
    from academic_years y
    where e.school_id = ${schoolId}::uuid and e.student_id = ${studentId}::uuid and e.ends_on is null
      and y.id = e.academic_year_id and y.status <> 'closed'
    returning e.id`)) as unknown as { id: string }[];
  await audit(tx, { action: "student.left", actorUserId, schoolId, entityType: "student", entityId: studentId, data: { leftOn, reason, endedEnrollments: ended.length } });
  return { endedEnrollments: ended.length };
}

/** Readmits a student who left: record active and student membership restored. Enroll them again separately. */
export async function readmitStudent(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<void> {
  parse(uuidField("Student"), studentId);
  try {
    await withCapability(db, ctx, schoolId, "school.students.manage", async (tx, actor) => {
      const [p] = await tx.select().from(studentProfiles).where(and(eq(studentProfiles.schoolId, schoolId), eq(studentProfiles.id, studentId)));
      if (!p) throw new AppError("NOT_FOUND", "Student not found.");
      if (p.status === "active") throw new AppError("CONFLICT", "This student is already active.");
      await tx.update(studentProfiles).set({ status: "active", leftOn: null, leaveReason: null, updatedAt: sql`now()` }).where(eq(studentProfiles.id, studentId));
      await tx
        .update(schoolMemberships)
        .set({ status: "active" })
        .where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, p.userId), eq(schoolMemberships.role, "student")));
      await audit(tx, { action: "student.readmitted", actorUserId: actor.userId, schoolId, entityType: "student", entityId: studentId });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e);
  }
}

/* ------------------------------------------------------------------ search, detail, export */

export interface StudentListRow {
  id: string;
  userId: string;
  displayName: string;
  admissionNo: string;
  username: string | null;
  status: "active" | "left";
  dateOfBirth: string | null;
  sectionId: string | null;
  sectionLabel: string | null;
  rollNo: number | null;
}

export interface StudentFilters {
  search: string;
  status?: "active" | "left";
  /** Academic year for the class/section columns and filters; default the current year. */
  yearId?: string;
  classId?: string;
  sectionId?: string;
  /** "none": students with no open enrollment in the year. */
  enrolled?: "none";
}

const isUuid = (v: string | undefined): v is string => !!v && z.uuid().safeParse(v).success;

async function listQuery(tx: Tx, schoolId: string, f: StudentFilters, page?: PageRequest): Promise<{ rows: StudentListRow[]; total: number; yearId: string | null }> {
  const yearId = isUuid(f.yearId) ? f.yearId : await currentYearId(tx, schoolId);
  const parts: SQL[] = [sql`p.school_id = ${schoolId}::uuid`];
  if (f.search) {
    const p = likePattern(f.search);
    parts.push(sql`(p.display_name ilike ${p} or p.admission_no ilike ${p} or u.username ilike ${p})`);
  }
  if (f.status) parts.push(sql`p.status = ${f.status}::student_status`);
  if (isUuid(f.sectionId)) parts.push(sql`e.section_id = ${f.sectionId}::uuid`);
  else if (isUuid(f.classId)) parts.push(sql`s.class_id = ${f.classId}::uuid`);
  if (f.enrolled === "none") parts.push(sql`e.id is null`);
  const where = sql.join(parts, sql` and `);
  const from = sql`
    from student_profiles p
    join users u on u.id = p.user_id
    left join enrollments e on e.student_id = p.id and e.school_id = p.school_id and e.ends_on is null and e.academic_year_id = ${yearId}::uuid
    left join sections s on s.id = e.section_id
    left join classes c on c.id = s.class_id`;
  const [count] = (await tx.execute(sql`select count(*)::int as n ${from} where ${where}`)) as unknown as { n: number }[];
  const limit = page ? sql`limit ${page.pageSize} offset ${(page.page - 1) * page.pageSize}` : sql``;
  const rows = (await tx.execute(sql`
    select p.id, p.user_id as "userId", p.display_name as "displayName", p.admission_no as "admissionNo", u.username,
           p.status::text as status, p.date_of_birth::text as "dateOfBirth", e.section_id as "sectionId",
           case when s.id is null then null else c.name || ' ' || s.name end as "sectionLabel", e.roll_no as "rollNo"
    ${from} where ${where}
    order by c.sort_order nulls last, c.name, s.name, e.roll_no nulls last, lower(p.display_name), p.id
    ${limit}`)) as unknown as StudentListRow[];
  return { rows, total: count?.n ?? 0, yearId };
}

export async function searchStudents(db: Db, ctx: RequestContext, schoolId: string, req: PageRequest & StudentFilters): Promise<Page<StudentListRow> & { yearId: string | null }> {
  return withCapability(db, ctx, schoolId, "school.students.view", async (tx) => {
    const r = await listQuery(tx, schoolId, req, req);
    return { ...toPage(r.rows, r.total, req), yearId: r.yearId };
  });
}

/** Student list as CSV with the page's filters; audited; formula cells neutralised. */
export async function exportStudentsCsv(db: Db, ctx: RequestContext, schoolId: string, f: StudentFilters): Promise<string> {
  return withCapability(db, ctx, schoolId, "school.students.view", async (tx, actor) => {
    const r = await listQuery(tx, schoolId, f);
    await audit(tx, { action: "student.exported", actorUserId: actor.userId, schoolId, entityType: "student", data: { rows: r.rows.length, filters: { status: f.status ?? null, yearId: r.yearId, classId: f.classId ?? null, sectionId: f.sectionId ?? null } } });
    return toCsv([
      ["admission_no", "name", "username", "status", "date_of_birth", "class_section", "roll_no"],
      ...r.rows.map((x) => [x.admissionNo, x.displayName, x.username, x.status, x.dateOfBirth, x.sectionLabel, x.rollNo === null ? null : String(x.rollNo)]),
    ]);
  });
}

export interface EnrollmentHistoryRow {
  id: string;
  yearId: string;
  yearName: string;
  yearStatus: "planned" | "current" | "closed";
  sectionId: string;
  sectionLabel: string;
  rollNo: number | null;
  startsOn: string;
  endsOn: string | null;
  endReason: string | null;
}

export interface GuardianRow {
  linkId: string;
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  relationship: string;
  verifiedAt: Date;
  revokedAt: Date | null;
}

export interface StudentDetail {
  id: string;
  userId: string;
  displayName: string;
  admissionNo: string;
  username: string | null;
  dateOfBirth: string | null;
  admittedOn: string;
  status: "active" | "left";
  leftOn: string | null;
  leaveReason: LeaveReason | null;
  /** Whether the school may issue codes or end sessions for this account. */
  manageable: boolean;
  enrollments: EnrollmentHistoryRow[];
  guardians: GuardianRow[];
}

export async function enrollmentHistory(tx: Tx, schoolId: string, studentId: string): Promise<EnrollmentHistoryRow[]> {
  return (await tx.execute(sql`
    select e.id, y.id as "yearId", y.name as "yearName", y.status::text as "yearStatus", s.id as "sectionId", c.name || ' ' || s.name as "sectionLabel",
           e.roll_no as "rollNo", e.starts_on::text as "startsOn", e.ends_on::text as "endsOn", e.end_reason::text as "endReason"
    from enrollments e join academic_years y on y.id = e.academic_year_id join sections s on s.id = e.section_id join classes c on c.id = s.class_id
    where e.school_id = ${schoolId}::uuid and e.student_id = ${studentId}::uuid
    order by y.starts_on desc, e.starts_on desc`)) as unknown as EnrollmentHistoryRow[];
}

export async function getStudentDetail(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<StudentDetail> {
  parse(uuidField("Student"), studentId);
  return withCapability(db, ctx, schoolId, "school.students.view", async (tx) => {
    const [p] = await tx
      .select({
        id: studentProfiles.id,
        userId: studentProfiles.userId,
        displayName: studentProfiles.displayName,
        admissionNo: studentProfiles.admissionNo,
        username: users.username,
        dateOfBirth: studentProfiles.dateOfBirth,
        admittedOn: studentProfiles.admittedOn,
        status: studentProfiles.status,
        leftOn: studentProfiles.leftOn,
        leaveReason: studentProfiles.leaveReason,
        manageable: sql<boolean>`app_can_manage_user(${studentProfiles.userId})`,
      })
      .from(studentProfiles)
      .innerJoin(users, eq(users.id, studentProfiles.userId))
      .where(and(eq(studentProfiles.schoolId, schoolId), eq(studentProfiles.id, studentId)));
    if (!p) throw new AppError("NOT_FOUND", "Student not found.");
    const guardians = (await tx.execute(sql`
      select g.id as "linkId", g.guardian_user_id as "userId", u.full_name as name, u.email, u.phone, g.relationship::text as relationship,
             g.verified_at as "verifiedAt", g.revoked_at as "revokedAt"
      from guardian_links g join users u on u.id = g.guardian_user_id
      where g.school_id = ${schoolId}::uuid and g.student_id = ${studentId}::uuid
      order by g.revoked_at nulls first, g.verified_at`)) as unknown as GuardianRow[];
    return { ...p, enrollments: await enrollmentHistory(tx, schoolId, studentId), guardians };
  });
}

/** Members with the student role who have no student record yet (for example joined by invitation). */
export async function listStudentMembersWithoutProfile(db: Db, ctx: RequestContext, schoolId: string): Promise<{ userId: string; fullName: string; username: string | null; email: string | null }[]> {
  return withCapability(db, ctx, schoolId, "school.students.view", (tx) =>
    tx
      .select({ userId: users.id, fullName: users.fullName, username: users.username, email: users.email })
      .from(schoolMemberships)
      .innerJoin(users, eq(users.id, schoolMemberships.userId))
      .leftJoin(studentProfiles, and(eq(studentProfiles.schoolId, schoolMemberships.schoolId), eq(studentProfiles.userId, schoolMemberships.userId)))
      .where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.role, "student"), eq(schoolMemberships.status, "active"), isNull(studentProfiles.id)))
      .orderBy(asc(users.fullName)),
  );
}

