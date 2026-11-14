import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db, RequestContext, Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { parseCsv } from "../../csv";
import { foreignKeyViolation, uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { withIdempotency } from "../../idempotency";
import { ISO_DATE, parse, uuidField } from "../setup/common";
import { schoolInfo, studentUsername } from "./common";
import { createStudentInTransaction } from "./profiles";

/**
 * Student roster import from CSV (Phase 5), in two steps like the staff import:
 * 1. Preview: the header is mapped to known fields (common spellings are recognised and the
 *    mapping is shown), every row is checked against the file and the school (admission numbers,
 *    class and section in the chosen year, roll numbers) and shown with its errors and warnings.
 *    Nothing is saved.
 * 2. Commit: the same file and year are re-checked and imported in ONE transaction, all rows or
 *    none, guarded by the preview's fingerprint and an idempotency key.
 *
 * A warning (for example a possible duplicate: same name and date of birth as an existing
 * student) does not block the import; an error does.
 */
export const MAX_STUDENT_IMPORT_ROWS = 300;
const MAX_IMPORT_BYTES = 256 * 1024;

export const STUDENT_FIELDS = ["name", "admission_no", "admitted_on", "date_of_birth", "class", "section", "roll_no"] as const;
export type StudentField = (typeof STUDENT_FIELDS)[number];

/** Header spellings recognised for each field (compared lowercased, spaces/dots/underscores removed). */
const ALIASES: Record<StudentField, string[]> = {
  name: ["name", "studentname", "fullname", "student"],
  admission_no: ["admissionno", "admissionnumber", "admno", "admission", "grno", "srno", "enrollmentno"],
  admitted_on: ["admittedon", "admissiondate", "dateofadmission", "doa", "joinedon"],
  date_of_birth: ["dateofbirth", "dob", "birthdate", "birthday"],
  class: ["class", "grade", "standard", "std"],
  section: ["section", "division", "div"],
  roll_no: ["rollno", "rollnumber", "roll"],
};

const key = (h: string) => h.trim().toLowerCase().replace(/[\s._-]+/g, "");

export function mapHeader(header: string[]): { mapping: Partial<Record<StudentField, number>>; ignored: string[] } {
  const mapping: Partial<Record<StudentField, number>> = {};
  const ignored: string[] = [];
  header.forEach((h, i) => {
    const k = key(h);
    const field = STUDENT_FIELDS.find((f) => ALIASES[f].includes(k));
    if (field && mapping[field] === undefined) mapping[field] = i;
    else if (h.trim()) ignored.push(h.trim());
  });
  return { mapping, ignored };
}

export interface StudentImportRow {
  line: number;
  name: string;
  admissionNo: string;
  admittedOn: string | null;
  dateOfBirth: string | null;
  className: string;
  sectionName: string;
  rollNo: number | null;
  /** Resolved during the database check. */
  sectionId: string | null;
  username: string;
  errors: string[];
  warnings: string[];
}

export interface StudentImportPreview {
  fingerprint: string;
  yearId: string;
  /** Which column of the file feeds each field, by header text. */
  mapping: { field: StudentField; column: string | null }[];
  ignoredColumns: string[];
  rows: StudentImportRow[];
  valid: number;
  invalid: number;
  fileErrors: string[];
}

const validDate = (v: string) => ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

function fingerprintOf(text: string, yearId: string): string {
  return createHash("sha256").update(`${yearId}\n${text.replace(/\r\n/g, "\n").trim()}`).digest("hex");
}

/** Parses the file and checks each row on its own (no database). */
export function parseStudentCsv(text: string, schoolCode: string) {
  const empty = { rows: [] as StudentImportRow[], header: [] as string[], mapping: {} as Partial<Record<StudentField, number>>, ignored: [] as string[] };
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) return { ...empty, fileErrors: ["The file is larger than 256 KB."] };
  const table = parseCsv(text);
  if (table.length === 0) return { ...empty, fileErrors: ["The file is empty."] };
  const header = table[0]!;
  const { mapping, ignored } = mapHeader(header);
  const fileErrors: string[] = [];
  for (const f of ["name", "admission_no"] as const) if (mapping[f] === undefined) fileErrors.push(`No column for "${f}" was found in the header row.`);
  if ((mapping.class === undefined) !== (mapping.section === undefined)) fileErrors.push('Give both a "class" and a "section" column, or neither.');
  if (mapping.roll_no !== undefined && mapping.section === undefined) fileErrors.push('A "roll_no" column needs "class" and "section" columns.');
  const body = table.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  if (body.length === 0) fileErrors.push("The file has a header but no student rows.");
  if (body.length > MAX_STUDENT_IMPORT_ROWS) fileErrors.push(`At most ${MAX_STUDENT_IMPORT_ROWS} students per import (import class by class); this file has ${body.length}.`);
  if (fileErrors.length) return { ...empty, header, mapping, ignored, fileErrors };

  const cell = (r: string[], f: StudentField) => (mapping[f] === undefined ? "" : (r[mapping[f]!] ?? "").trim());
  const seenAdm = new Map<string, number>();
  const seenUser = new Map<string, number>();
  const seenRoll = new Map<string, number>();
  const rows: StudentImportRow[] = body.map((r, i) => {
    const line = i + 2;
    const errors: string[] = [];
    const name = cell(r, "name");
    const admissionNo = cell(r, "admission_no");
    const admittedOn = cell(r, "admitted_on") || null;
    const dateOfBirth = cell(r, "date_of_birth") || null;
    const className = cell(r, "class");
    const sectionName = cell(r, "section");
    const rollRaw = cell(r, "roll_no");
    if (name.length < 2 || name.length > 120) errors.push("Name must be 2–120 characters.");
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$/.test(admissionNo)) errors.push("Admission number is missing or has invalid characters.");
    if (admittedOn && !validDate(admittedOn)) errors.push("Admission date must be YYYY-MM-DD.");
    if (dateOfBirth && !validDate(dateOfBirth)) errors.push("Date of birth must be YYYY-MM-DD.");
    if (dateOfBirth && admittedOn && validDate(dateOfBirth) && validDate(admittedOn) && dateOfBirth >= admittedOn) errors.push("Date of birth must be before the admission date.");
    if ((className === "") !== (sectionName === "")) errors.push("Give both class and section, or leave both empty.");
    let rollNo: number | null = null;
    if (rollRaw) {
      if (!/^\d{1,4}$/.test(rollRaw) || Number(rollRaw) < 1) errors.push("Roll number must be a whole number from 1 to 9999.");
      else rollNo = Number(rollRaw);
      if (!sectionName) errors.push("A roll number needs a class and section.");
    }
    const admKey = admissionNo.toLowerCase();
    if (admKey) {
      if (seenAdm.has(admKey)) errors.push(`Same admission number as line ${seenAdm.get(admKey)}.`);
      else seenAdm.set(admKey, line);
    }
    const username = studentUsername(schoolCode, admissionNo);
    // Different admission numbers can give the same sign-in name (A/1 and A-1).
    if (admKey && seenAdm.get(admKey) === line) {
      const prev = seenUser.get(username);
      if (prev !== undefined) errors.push(`This admission number gives the same sign-in name as line ${prev} (${username}).`);
      else seenUser.set(username, line);
    }
    if (rollNo !== null && className) {
      const rk = `${className.toLowerCase()}|${sectionName.toLowerCase()}|${rollNo}`;
      if (seenRoll.has(rk)) errors.push(`Same class, section and roll number as line ${seenRoll.get(rk)}.`);
      else seenRoll.set(rk, line);
    }
    return { line, name, admissionNo, admittedOn, dateOfBirth, className, sectionName, rollNo, sectionId: null, username, errors, warnings: [] };
  });
  return { rows, header, mapping, ignored, fileErrors };
}

/** Checks the rows against the school: existing admission numbers, sections in the year, rolls, possible duplicates. */
async function checkAgainstSchool(tx: Tx, schoolId: string, yearId: string, rows: StudentImportRow[], today: string): Promise<void> {
  const [year] = (await tx.execute(sql`select status::text as status, starts_on::text as "startsOn", ends_on::text as "endsOn" from academic_years where school_id = ${schoolId}::uuid and id = ${yearId}::uuid`)) as unknown as { status: string; startsOn: string; endsOn: string }[];
  if (!year) throw new AppError("NOT_FOUND", "Academic year not found.");
  if (year.status === "closed") throw new AppError("CONFLICT", "That academic year is closed. Choose an open year.");
  const sections = (await tx.execute(sql`
    select s.id, lower(c.name) as class, lower(s.name) as section from sections s join classes c on c.id = s.class_id
    where s.school_id = ${schoolId}::uuid and s.academic_year_id = ${yearId}::uuid and s.archived_at is null and c.archived_at is null`)) as unknown as { id: string; class: string; section: string }[];
  const sectionMap = new Map(sections.map((s) => [`${s.class}|${s.section}`, s.id]));
  const adms = rows.map((r) => r.admissionNo.toLowerCase()).filter(Boolean);
  const taken = new Set(
    adms.length === 0
      ? []
      : ((await tx.execute(sql`select lower(admission_no) as a from student_profiles where school_id = ${schoolId}::uuid and lower(admission_no) in (${sql.join(adms.map((x) => sql`${x}`), sql`, `)})`)) as unknown as { a: string }[]).map((x) => x.a),
  );
  const names = (await tx.execute(sql`select lower(display_name) as n, date_of_birth::text as dob, admission_no as adm from student_profiles where school_id = ${schoolId}::uuid and date_of_birth is not null`)) as unknown as { n: string; dob: string; adm: string }[];
  const nameDob = new Map(names.map((x) => [`${x.n}|${x.dob}`, x.adm]));
  const usedRolls = new Set(
    ((await tx.execute(sql`select section_id || '|' || roll_no as k from enrollments where school_id = ${schoolId}::uuid and academic_year_id = ${yearId}::uuid and ends_on is null and roll_no is not null`)) as unknown as { k: string }[]).map((x) => x.k),
  );
  for (const r of rows) {
    if (taken.has(r.admissionNo.toLowerCase())) r.errors.push("A student with this admission number already exists.");
    if (r.className) {
      const id = sectionMap.get(`${r.className.toLowerCase()}|${r.sectionName.toLowerCase()}`);
      if (!id) r.errors.push(`No section "${r.className} ${r.sectionName}" in this academic year.`);
      else {
        r.sectionId = id;
        if (r.rollNo !== null && usedRolls.has(`${id}|${r.rollNo}`)) r.errors.push("Another student in this section already has this roll number.");
      }
    }
    const admitted = r.admittedOn ?? today;
    if (r.sectionId && admitted > year.endsOn) r.errors.push("The admission date is after this academic year ends.");
    if (r.dateOfBirth) {
      const dupOf = nameDob.get(`${r.name.toLowerCase()}|${r.dateOfBirth}`);
      if (dupOf) r.warnings.push(`Possible duplicate: student ${dupOf} has the same name and date of birth.`);
    }
  }
}

function previewShape(parsed: ReturnType<typeof parseStudentCsv>, yearId: string, fingerprint: string): StudentImportPreview {
  const invalid = parsed.rows.filter((r) => r.errors.length > 0).length;
  return {
    fingerprint,
    yearId,
    mapping: STUDENT_FIELDS.map((f) => ({ field: f, column: parsed.mapping[f] === undefined ? null : (parsed.header[parsed.mapping[f]!] ?? "").trim() })),
    ignoredColumns: parsed.ignored,
    rows: parsed.rows,
    valid: parsed.rows.length - invalid,
    invalid,
    fileErrors: parsed.fileErrors,
  };
}

/** Step 1: map, check and show. Saves nothing. */
export async function previewStudentImport(db: Db, ctx: RequestContext, schoolId: string, input: { text: string; yearId: string }): Promise<StudentImportPreview> {
  parse(uuidField("Academic year"), input.yearId);
  return withCapability(db, ctx, schoolId, "school.students.manage", async (tx) => {
    const school = await schoolInfo(tx, schoolId);
    const parsed = parseStudentCsv(input.text, school.code);
    if (!parsed.fileErrors.length && parsed.rows.length) await checkAgainstSchool(tx, schoolId, input.yearId, parsed.rows, school.today);
    return previewShape(parsed, input.yearId, fingerprintOf(input.text, input.yearId));
  });
}

export interface StudentImportResult {
  created: number;
  enrolled: number;
  /** Sign-in names and activation codes: present only in the first response, never stored. */
  codes: { admissionNo: string; name: string; username: string; code: string }[] | null;
  replayed: boolean;
}

/** Step 2: import every row, or none. */
export async function commitStudentImport(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { text: string; yearId: string; fingerprint: string; idempotencyKey: string },
): Promise<StudentImportResult> {
  parse(uuidField("Academic year"), input.yearId);
  if (fingerprintOf(input.text, input.yearId) !== input.fingerprint) throw new AppError("CONFLICT", "The file or the year changed after the preview. Check the file again before importing.");
  let codes: StudentImportResult["codes"] = null;
  try {
    const out = await withCapability(db, ctx, schoolId, "school.students.manage", (tx, actor) =>
      withIdempotency(tx, ctx, { operation: "student.import", key: input.idempotencyKey, request: { fingerprint: input.fingerprint }, schoolId }, async () => {
        const school = await schoolInfo(tx, schoolId);
        const parsed = parseStudentCsv(input.text, school.code);
        if (parsed.fileErrors.length) throw new AppError("VALIDATION", parsed.fileErrors[0]!);
        await checkAgainstSchool(tx, schoolId, input.yearId, parsed.rows, school.today);
        const bad = parsed.rows.filter((r) => r.errors.length > 0).length;
        if (bad > 0) throw new AppError("VALIDATION", `${bad} row(s) have errors. Fix the file and check it again. Nothing was imported.`);
        const issued: NonNullable<StudentImportResult["codes"]> = [];
        let enrolled = 0;
        for (const r of parsed.rows) {
          const c = await createStudentInTransaction(tx, ctx, actor.userId, schoolId, school, {
            fullName: r.name,
            admissionNo: r.admissionNo,
            admittedOn: r.admittedOn ?? school.today,
            dateOfBirth: r.dateOfBirth,
            sectionId: r.sectionId,
            rollNo: r.rollNo,
          });
          if (c.enrollmentId) enrolled++;
          issued.push({ admissionNo: r.admissionNo, name: r.name, username: c.username, code: c.activationCode });
        }
        await audit(tx, { action: "student.imported", actorUserId: actor.userId, schoolId, entityType: "student", data: { created: issued.length, enrolled, yearId: input.yearId, fingerprint: input.fingerprint } });
        codes = issued;
        // Stored for replays: counts only, never the codes.
        return { created: issued.length, enrolled };
      }),
    );
    return { created: out.result.created, enrolled: out.result.enrolled, codes: out.replayed ? null : codes, replayed: out.replayed };
  } catch (e) {
    if (e instanceof AppError) throw e;
    const unique = uniqueViolation(e);
    if (unique !== null) {
      if (unique.includes("username")) throw new AppError("CONFLICT", "An admission number gives the same sign-in name as an existing account. Nothing was imported.");
      if (unique.includes("admission")) throw new AppError("CONFLICT", "An admission number was taken meanwhile. Check the file again. Nothing was imported.");
      if (unique.includes("roll")) throw new AppError("CONFLICT", "A roll number was taken meanwhile. Check the file again. Nothing was imported.");
      throw new AppError("CONFLICT", "A row clashes with existing data. Nothing was imported.");
    }
    if (foreignKeyViolation(e)) throw new AppError("CONFLICT", "The import could not be completed. Nothing was imported.");
    throw e;
  }
}
