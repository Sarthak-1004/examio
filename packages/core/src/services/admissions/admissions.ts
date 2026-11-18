import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { admissionApplications, admissionDocuments, admissionEvents, files, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { checkViolation, uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { likePattern } from "../../paging";
import { emailSchema, phoneSchema } from "../../validation";
import { isoDate, mapSetupError, parse, trimmed, uuidField } from "../setup/common";
import { admissionNo, openSection, schoolInfo } from "../students/common";
import { createStudentInTransaction, studentDuplicate } from "../students/profiles";

/**
 * Admissions (Phase 13.1). Recorded by the school office (school administrators); there is no
 * public application form.
 *
 * - An enquiry or application names the applicant, the academic year and class, and a guardian
 *   with a phone or email. Each gets a reference number (A26-0001) and a document checklist.
 * - Duplicates: an open application for the same year with the same applicant name and the same
 *   date of birth or guardian phone is refused unless the office confirms it is a different
 *   child. A student already on record with the same name and date of birth is flagged.
 * - Status: enquiry → applied → under review → approved or rejected; withdrawn from any open
 *   step; rejected or withdrawn can be reopened for review. Approval needs a date of birth and
 *   every required document verified or waived. Every change is on the timeline.
 * - Conversion of an approved application creates the student (account, record, optional
 *   enrollment in a section of the application's year and class) exactly once: converting again
 *   returns the same student and issues no new code. A student with the same name and date of
 *   birth must be confirmed as a different child first.
 */

export type AdmissionStatus = "enquiry" | "applied" | "under_review" | "approved" | "rejected" | "withdrawn" | "enrolled";
export const DOCUMENT_KINDS = ["birth_certificate", "photo", "address_proof", "previous_report", "transfer_certificate", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  birth_certificate: "Birth certificate",
  photo: "Photograph",
  address_proof: "Address proof",
  previous_report: "Previous school report",
  transfer_certificate: "Transfer certificate",
  other: "Other",
};
const REQUIRED_BY_DEFAULT: readonly DocumentKind[] = ["birth_certificate", "photo", "address_proof"];
const OPEN: readonly AdmissionStatus[] = ["enquiry", "applied", "under_review", "approved"];

const optional = <T extends z.ZodType>(schema: T) => z.union([z.literal("").transform(() => null), schema]).nullable().optional();

const detailsSchema = z
  .object({
    yearId: z.uuid({ message: "Choose an academic year." }),
    classId: z.uuid({ message: "Choose a class." }),
    applicantName: trimmed("Applicant's name", 2, 120),
    dateOfBirth: optional(isoDate("date of birth")),
    guardianName: trimmed("Guardian's name", 2, 120),
    guardianPhone: optional(phoneSchema),
    guardianEmail: optional(emailSchema),
    previousSchool: optional(trimmed("Previous school", 1, 200)),
    notes: optional(trimmed("Notes", 1, 2000)),
  })
  .refine((v) => v.guardianPhone || v.guardianEmail, { message: "Give the guardian's mobile number or email.", path: ["guardianPhone"] });
export type ApplicationDetailsInput = z.input<typeof detailsSchema>;

async function checkYearClass(tx: Tx, schoolId: string, yearId: string, classId: string): Promise<void> {
  const [r] = (await tx.execute(sql`
    select (select status::text from academic_years where school_id = ${schoolId}::uuid and id = ${yearId}::uuid) as year,
           (select archived_at is null from classes where school_id = ${schoolId}::uuid and id = ${classId}::uuid) as class_ok`)) as unknown as { year: string | null; class_ok: boolean | null }[];
  if (!r?.year) throw new AppError("NOT_FOUND", "Academic year not found.");
  if (r.year === "closed") throw new AppError("CONFLICT", "That academic year is closed.");
  if (!r.class_ok) throw new AppError("NOT_FOUND", "Class not found or archived.");
}

export interface PossibleDuplicate {
  kind: "application" | "student";
  id: string;
  label: string;
}

async function duplicates(tx: Tx, schoolId: string, d: { yearId: string; applicantName: string; dateOfBirth?: string | null; guardianPhone?: string | null }, exceptId: string | null): Promise<PossibleDuplicate[]> {
  const apps = (await tx.execute(sql`
    select id, reference_no || ' · ' || applicant_name || ' (' || status::text || ')' as label from admission_applications
    where school_id = ${schoolId}::uuid and academic_year_id = ${d.yearId}::uuid and status in ('enquiry', 'applied', 'under_review', 'approved')
      and lower(applicant_name) = lower(${d.applicantName})
      and ((${d.dateOfBirth ?? null}::date is not null and date_of_birth = ${d.dateOfBirth ?? null}::date) or (${d.guardianPhone ?? null}::text is not null and guardian_phone = ${d.guardianPhone ?? null}))
      ${exceptId ? sql`and id <> ${exceptId}::uuid` : sql``}`)) as unknown as { id: string; label: string }[];
  const students = d.dateOfBirth
    ? ((await tx.execute(sql`
        select id, admission_no || ' · ' || display_name as label from student_profiles
        where school_id = ${schoolId}::uuid and lower(display_name) = lower(${d.applicantName}) and date_of_birth = ${d.dateOfBirth}::date`)) as unknown as { id: string; label: string }[])
    : [];
  return [...apps.map((a) => ({ kind: "application" as const, ...a })), ...students.map((s) => ({ kind: "student" as const, ...s }))];
}

async function nextReference(tx: Tx, schoolId: string, yearId: string): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`admission-ref:${schoolId}`}, 0))`);
  const [y] = (await tx.execute(sql`select extract(year from starts_on)::int as y from academic_years where id = ${yearId}::uuid`)) as unknown as { y: number }[];
  const prefix = `A${String((y?.y ?? new Date().getFullYear()) % 100).padStart(2, "0")}-`;
  const [n] = (await tx.execute(sql`
    select coalesce(max(substring(reference_no from ${prefix.length + 1}::int)::int), 0) + 1 as n from admission_applications
    where school_id = ${schoolId}::uuid and reference_no like ${`${prefix}%`}`)) as unknown as { n: number }[];
  return `${prefix}${String(n?.n ?? 1).padStart(4, "0")}`;
}

async function event(tx: Tx, schoolId: string, applicationId: string, from: AdmissionStatus | null, to: AdmissionStatus, actorUserId: string, note: string | null) {
  await tx.insert(admissionEvents).values({ schoolId, applicationId, fromStatus: from, toStatus: to, note, actorUserId });
}

function guardError(e: unknown): never {
  const msg = String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message ?? "");
  if (msg.includes("admission_final")) throw new AppError("CONFLICT", "This applicant has been enrolled; the application is closed.");
  if (msg.includes("admission_transition") || msg.includes("admission_student_link")) throw new AppError("CONFLICT", "That step is not possible from the application's current status.");
  if (checkViolation(e) !== null) throw new AppError("VALIDATION", "Some details are not valid.");
  throw e;
}

/** Records an enquiry (or a full application). Returns the reference number. */
export async function createApplication(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: ApplicationDetailsInput & { stage?: "enquiry" | "applied"; confirmNotDuplicate?: boolean },
): Promise<{ id: string; referenceNo: string }> {
  const d = parse(detailsSchema, input);
  const stage = input.stage === "applied" ? "applied" : "enquiry";
  return withCapability(db, ctx, schoolId, "school.admissions.manage", async (tx, actor) => {
    await checkYearClass(tx, schoolId, d.yearId, d.classId);
    const dup = (await duplicates(tx, schoolId, d, null)).filter((x) => x.kind === "application");
    if (dup.length && !input.confirmNotDuplicate) {
      throw new AppError("CONFLICT", `This looks like an existing application: ${dup.map((x) => x.label).join("; ")}. Confirm it is a different child to continue.`, { confirmNotDuplicate: "Possible duplicate." });
    }
    const referenceNo = await nextReference(tx, schoolId, d.yearId);
    const [a] = await tx
      .insert(admissionApplications)
      .values({
        schoolId,
        referenceNo,
        academicYearId: d.yearId,
        classId: d.classId,
        applicantName: d.applicantName,
        dateOfBirth: d.dateOfBirth ?? null,
        guardianName: d.guardianName,
        guardianPhone: d.guardianPhone ?? null,
        guardianEmail: d.guardianEmail ?? null,
        previousSchool: d.previousSchool ?? null,
        notes: d.notes ?? null,
        status: stage,
        createdBy: actor.userId,
      })
      .returning({ id: admissionApplications.id });
    await tx.insert(admissionDocuments).values(DOCUMENT_KINDS.filter((k) => k !== "other").map((kind) => ({ schoolId, applicationId: a!.id, kind, required: REQUIRED_BY_DEFAULT.includes(kind) })));
    await event(tx, schoolId, a!.id, null, stage, actor.userId, dup.length ? "Recorded although a similar application exists." : null);
    await audit(tx, { action: "admission.created", actorUserId: actor.userId, schoolId, entityType: "admission_application", entityId: a!.id, data: { referenceNo, stage } });
    return { id: a!.id, referenceNo };
  });
}

async function lockApplication(tx: Tx, schoolId: string, id: string) {
  const [a] = await tx.select().from(admissionApplications).where(and(eq(admissionApplications.schoolId, schoolId), eq(admissionApplications.id, id))).for("update");
  if (!a) throw new AppError("NOT_FOUND", "Application not found.");
  return a;
}

/** Changes the details while the application is open and not yet approved. */
export async function updateApplication(db: Db, ctx: RequestContext, schoolId: string, applicationId: string, input: ApplicationDetailsInput): Promise<void> {
  parse(uuidField("Application"), applicationId);
  const d = parse(detailsSchema, input);
  await withCapability(db, ctx, schoolId, "school.admissions.manage", async (tx, actor) => {
    const a = await lockApplication(tx, schoolId, applicationId);
    if (!["enquiry", "applied", "under_review"].includes(a.status)) throw new AppError("CONFLICT", "Details can be changed only before a decision.");
    await checkYearClass(tx, schoolId, d.yearId, d.classId);
    await tx
      .update(admissionApplications)
      .set({ academicYearId: d.yearId, classId: d.classId, applicantName: d.applicantName, dateOfBirth: d.dateOfBirth ?? null, guardianName: d.guardianName, guardianPhone: d.guardianPhone ?? null, guardianEmail: d.guardianEmail ?? null, previousSchool: d.previousSchool ?? null, notes: d.notes ?? null, updatedAt: sql`now()` })
      .where(eq(admissionApplications.id, applicationId))
      .catch(guardError);
    await audit(tx, { action: "admission.updated", actorUserId: actor.userId, schoolId, entityType: "admission_application", entityId: applicationId });
  });
}

const docSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS, { message: "Unknown document." }),
  status: z.enum(["missing", "received", "verified", "waived"], { message: "Choose a status." }),
  required: z.boolean().optional(),
  fileId: z.union([z.literal("").transform(() => null), z.uuid({ message: "File not found." })]).nullable().optional(),
  note: optional(trimmed("Note", 1, 300)),
});

/** Updates one checklist item (adds "other" on first use). A waived required document needs a note. */
export async function setApplicationDocument(db: Db, ctx: RequestContext, schoolId: string, applicationId: string, input: z.input<typeof docSchema>): Promise<void> {
  parse(uuidField("Application"), applicationId);
  const d = parse(docSchema, input);
  await withCapability(db, ctx, schoolId, "school.admissions.manage", async (tx, actor) => {
    const a = await lockApplication(tx, schoolId, applicationId);
    if (!OPEN.includes(a.status)) throw new AppError("CONFLICT", "The application is closed.");
    if (d.fileId) {
      const [f] = await tx.select({ purpose: files.purpose, deletedAt: files.deletedAt }).from(files).where(and(eq(files.schoolId, schoolId), eq(files.id, d.fileId)));
      if (!f || f.deletedAt || f.purpose !== "admission_document") throw new AppError("VALIDATION", "The file was not found. Upload it again.");
    }
    const [cur] = await tx.select().from(admissionDocuments).where(and(eq(admissionDocuments.applicationId, applicationId), eq(admissionDocuments.kind, d.kind)));
    const required = d.required ?? cur?.required ?? false;
    if (d.status === "waived" && required && !d.note) throw new AppError("VALIDATION", "Say why a required document is waived.", { note: "Reason needed." });
    const fileId = d.fileId === undefined ? (cur?.fileId ?? null) : d.fileId;
    if (cur) {
      await tx.update(admissionDocuments).set({ status: d.status, required, fileId, note: d.note ?? null, updatedBy: actor.userId, updatedAt: sql`now()` }).where(eq(admissionDocuments.id, cur.id));
    } else {
      await tx.insert(admissionDocuments).values({ schoolId, applicationId, kind: d.kind, required, status: d.status, fileId, note: d.note ?? null, updatedBy: actor.userId });
    }
    await audit(tx, { action: "admission.document_updated", actorUserId: actor.userId, schoolId, entityType: "admission_application", entityId: applicationId, data: { kind: d.kind, status: d.status } });
  });
}

/**
 * Moves the application to another status. Approval needs a date of birth and every required
 * document verified or waived; rejection and withdrawal need a note.
 */
export async function changeApplicationStatus(db: Db, ctx: RequestContext, schoolId: string, applicationId: string, to: string, note?: string | null): Promise<void> {
  parse(uuidField("Application"), applicationId);
  const target = parse(z.enum(["applied", "under_review", "approved", "rejected", "withdrawn"], { message: "Unknown step." }), to);
  const why = note?.trim() ? parse(trimmed("Note", 1, 500), note) : null;
  if ((target === "rejected" || target === "withdrawn") && !why) throw new AppError("VALIDATION", "Give a reason.", { note: "Reason needed." });
  await withCapability(db, ctx, schoolId, "school.admissions.manage", async (tx, actor) => {
    const a = await lockApplication(tx, schoolId, applicationId);
    if (a.status === target) return;
    if (target === "approved") {
      if (!a.dateOfBirth) throw new AppError("CONFLICT", "Record the date of birth before approving.");
      const [missing] = (await tx.execute(sql`
        select string_agg(kind, ', ' order by kind) as kinds from admission_documents
        where application_id = ${applicationId}::uuid and required and status not in ('verified', 'waived')`)) as unknown as { kinds: string | null }[];
      if (missing?.kinds) {
        const labels = missing.kinds.split(", ").map((k) => DOCUMENT_LABELS[k as DocumentKind] ?? k).join(", ");
        throw new AppError("CONFLICT", `Verify or waive the required documents first: ${labels}.`);
      }
    }
    const decision = target === "approved" || target === "rejected";
    await tx
      .update(admissionApplications)
      .set({ status: target, updatedAt: sql`now()`, ...(decision ? { decidedBy: actor.userId, decidedAt: sql`now()`, decisionNote: why } : {}) })
      .where(eq(admissionApplications.id, applicationId))
      .catch(guardError);
    await event(tx, schoolId, applicationId, a.status, target, actor.userId, why);
    await audit(tx, { action: `admission.${target}`, actorUserId: actor.userId, schoolId, entityType: "admission_application", entityId: applicationId, data: { from: a.status, note: why } });
  });
}

const convertSchema = z.object({
  admissionNo,
  sectionId: z.union([z.literal("").transform(() => null), z.uuid({ message: "Section not found." })]).nullable().optional(),
  rollNo: z.union([z.literal("").transform(() => null), z.coerce.number().int().min(1).max(9999)]).nullable().optional(),
  confirmNotDuplicate: z.boolean().optional(),
});

export interface ConversionResult {
  studentId: string;
  /** False when the application had already been converted: nothing new was created. */
  created: boolean;
  username: string | null;
  activationCode: string | null;
  codeExpiresAt: Date | null;
}

/** Creates the student from an approved application, exactly once. */
export async function convertApplication(db: Db, ctx: RequestContext, schoolId: string, applicationId: string, input: z.input<typeof convertSchema>): Promise<ConversionResult> {
  parse(uuidField("Application"), applicationId);
  const d = parse(convertSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.admissions.manage", async (tx, actor) => {
      const a = await lockApplication(tx, schoolId, applicationId);
      if (a.studentId) return { studentId: a.studentId, created: false, username: null, activationCode: null, codeExpiresAt: null };
      if (a.status !== "approved") throw new AppError("CONFLICT", "Only an approved application can be converted.");
      const dup = (await duplicates(tx, schoolId, { yearId: a.academicYearId, applicantName: a.applicantName, dateOfBirth: a.dateOfBirth }, applicationId)).filter((x) => x.kind === "student");
      if (dup.length && !d.confirmNotDuplicate) {
        throw new AppError("CONFLICT", `A student with the same name and date of birth is already on record: ${dup.map((x) => x.label).join("; ")}. Confirm this is a different child to continue.`, { confirmNotDuplicate: "Possible duplicate." });
      }
      if (d.sectionId) {
        const sec = await openSection(tx, schoolId, d.sectionId);
        const [c] = (await tx.execute(sql`select class_id as "classId" from sections where id = ${d.sectionId}::uuid`)) as unknown as { classId: string }[];
        if (sec.yearId !== a.academicYearId || c?.classId !== a.classId) throw new AppError("VALIDATION", "Choose a section of the class and year applied for.", { sectionId: "Different class or year." });
      }
      const school = await schoolInfo(tx, schoolId);
      const created = await createStudentInTransaction(tx, ctx, actor.userId, schoolId, school, {
        fullName: a.applicantName,
        admissionNo: d.admissionNo,
        admittedOn: school.today,
        dateOfBirth: a.dateOfBirth,
        sectionId: d.sectionId ?? null,
        rollNo: d.rollNo ?? null,
      });
      await tx.update(admissionApplications).set({ status: "enrolled", studentId: created.studentId, updatedAt: sql`now()` }).where(eq(admissionApplications.id, applicationId)).catch(guardError);
      await event(tx, schoolId, applicationId, "approved", "enrolled", actor.userId, `Admission number ${d.admissionNo}`);
      await audit(tx, { action: "admission.converted", actorUserId: actor.userId, schoolId, entityType: "admission_application", entityId: applicationId, data: { studentId: created.studentId, admissionNo: d.admissionNo } });
      return { studentId: created.studentId, created: true, username: created.username, activationCode: created.activationCode, codeExpiresAt: created.codeExpiresAt };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (uniqueViolation(e) !== null) mapSetupError(e, { duplicate: studentDuplicate });
    throw e;
  }
}

/* ------------------------------------------------------------------ reading */

export interface ApplicationRow {
  id: string;
  referenceNo: string;
  applicantName: string;
  className: string;
  yearName: string;
  guardianName: string;
  status: AdmissionStatus;
  documentsDone: number;
  documentsRequired: number;
  updatedAt: Date;
}

export async function listApplications(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  f: { status?: string; yearId?: string; classId?: string; search?: string } = {},
): Promise<{ rows: ApplicationRow[]; counts: Record<AdmissionStatus, number> }> {
  return withCapability(db, ctx, schoolId, "school.admissions.manage", async (tx) => {
    const parts = [sql`a.school_id = ${schoolId}::uuid`];
    const isUuid = (v?: string) => !!v && z.uuid().safeParse(v).success;
    if (isUuid(f.yearId)) parts.push(sql`a.academic_year_id = ${f.yearId}::uuid`);
    if (isUuid(f.classId)) parts.push(sql`a.class_id = ${f.classId}::uuid`);
    const scope = sql.join(parts, sql` and `);
    const where = [scope];
    if (f.status && ["enquiry", "applied", "under_review", "approved", "rejected", "withdrawn", "enrolled"].includes(f.status)) where.push(sql`a.status = ${f.status}::admission_status`);
    if (f.search?.trim()) where.push(sql`(a.applicant_name ilike ${likePattern(f.search.trim())} or a.reference_no ilike ${likePattern(f.search.trim())} or a.guardian_name ilike ${likePattern(f.search.trim())})`);
    const rows = ((await tx.execute(sql`
      select a.id, a.reference_no as "referenceNo", a.applicant_name as "applicantName", c.name as "className", y.name as "yearName", a.guardian_name as "guardianName",
             a.status::text as status, a.updated_at as "updatedAt",
             (select count(*)::int from admission_documents d where d.application_id = a.id and d.required and d.status in ('verified', 'waived')) as "documentsDone",
             (select count(*)::int from admission_documents d where d.application_id = a.id and d.required) as "documentsRequired"
      from admission_applications a join classes c on c.id = a.class_id join academic_years y on y.id = a.academic_year_id
      where ${sql.join(where, sql` and `)}
      order by a.updated_at desc limit 300`)) as unknown as ApplicationRow[]).map((r) => ({ ...r, updatedAt: new Date(r.updatedAt) }));
    const counts = Object.fromEntries(["enquiry", "applied", "under_review", "approved", "rejected", "withdrawn", "enrolled"].map((s) => [s, 0])) as Record<AdmissionStatus, number>;
    for (const c of (await tx.execute(sql`select a.status::text as status, count(*)::int as n from admission_applications a where ${scope} group by a.status`)) as unknown as { status: AdmissionStatus; n: number }[]) counts[c.status] = c.n;
    return { rows, counts };
  });
}

export interface ApplicationDetail {
  id: string;
  referenceNo: string;
  yearId: string;
  yearName: string;
  classId: string;
  className: string;
  applicantName: string;
  dateOfBirth: string | null;
  guardianName: string;
  guardianPhone: string | null;
  guardianEmail: string | null;
  previousSchool: string | null;
  notes: string | null;
  status: AdmissionStatus;
  decisionNote: string | null;
  studentId: string | null;
  documents: { kind: DocumentKind; label: string; required: boolean; status: "missing" | "received" | "verified" | "waived"; fileId: string | null; fileName: string | null; fileStatus: string | null; note: string | null }[];
  events: { at: Date; from: AdmissionStatus | null; to: AdmissionStatus; note: string | null; by: string }[];
  possibleDuplicates: PossibleDuplicate[];
}

export async function getApplication(db: Db, ctx: RequestContext, schoolId: string, applicationId: string): Promise<ApplicationDetail> {
  parse(uuidField("Application"), applicationId);
  return withCapability(db, ctx, schoolId, "school.admissions.manage", async (tx) => {
    const [a] = (await tx.execute(sql`
      select a.id, a.reference_no as "referenceNo", a.academic_year_id as "yearId", y.name as "yearName", a.class_id as "classId", c.name as "className",
             a.applicant_name as "applicantName", a.date_of_birth::text as "dateOfBirth", a.guardian_name as "guardianName", a.guardian_phone as "guardianPhone",
             a.guardian_email as "guardianEmail", a.previous_school as "previousSchool", a.notes, a.status::text as status, a.decision_note as "decisionNote", a.student_id as "studentId"
      from admission_applications a join classes c on c.id = a.class_id join academic_years y on y.id = a.academic_year_id
      where a.school_id = ${schoolId}::uuid and a.id = ${applicationId}::uuid`)) as unknown as Omit<ApplicationDetail, "documents" | "events" | "possibleDuplicates">[];
    if (!a) throw new AppError("NOT_FOUND", "Application not found.");
    const docs = (await tx.execute(sql`
      select d.kind, d.required, d.status::text as status, d.file_id as "fileId", f.original_name as "fileName", f.status::text as "fileStatus", d.note
      from admission_documents d left join files f on f.id = d.file_id where d.application_id = ${applicationId}::uuid`)) as unknown as Omit<ApplicationDetail["documents"][number], "label">[];
    const documents = docs
      .map((d) => ({ ...d, label: DOCUMENT_LABELS[d.kind] }))
      .sort((x, y) => DOCUMENT_KINDS.indexOf(x.kind) - DOCUMENT_KINDS.indexOf(y.kind));
    const events = ((await tx.execute(sql`
      select e.at, e.from_status::text as "from", e.to_status::text as "to", e.note, u.full_name as by
      from admission_events e join users u on u.id = e.actor_user_id where e.application_id = ${applicationId}::uuid order by e.at desc, e.id desc`)) as unknown as ApplicationDetail["events"]).map((e) => ({ ...e, at: new Date(e.at) }));
    const possibleDuplicates = a.status === "enrolled" ? [] : await duplicates(tx, schoolId, a, applicationId);
    return { ...a, documents, events, possibleDuplicates };
  });
}
