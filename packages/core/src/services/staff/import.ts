import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schoolMemberships, staffProfiles, users, type Db, type RequestContext } from "@examio/db";
import { audit } from "../../audit";
import { issueAccountCodeInTransaction } from "../../auth/recovery";
import { withCapability } from "../../capabilities";
import { parseCsv } from "../../csv";
import { foreignKeyViolation, uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { withIdempotency } from "../../idempotency";
import { normalizePhone } from "../../normalize";
import { ISO_DATE } from "../setup/common";

/**
 * Bulk staff import from CSV, in two steps:
 * 1. Preview: every row is checked (required fields, formats, duplicates inside the file and
 *    against existing staff) and shown with its errors. Nothing is saved.
 * 2. Commit: the same file is re-checked and imported in ONE transaction: all rows or none.
 *    The commit carries the preview's fingerprint (a changed file is refused) and an
 *    idempotency key: repeating the commit, or two clicks at once, never creates an employee
 *    twice; the repeat answers with the first result.
 *
 * Columns (header row required, any order, case-insensitive): name, employee_no, email, phone,
 * role (teacher or finance, default teacher), job_title, joined_on (YYYY-MM-DD).
 * New accounts get one-time activation codes, shown only in the first commit's response.
 */
export const MAX_IMPORT_ROWS = 300;
const MAX_IMPORT_BYTES = 256 * 1024;
const COLUMNS = ["name", "employee_no", "email", "phone", "role", "job_title", "joined_on"] as const;
type Column = (typeof COLUMNS)[number];

export interface ImportRow {
  line: number;
  name: string;
  employeeNo: string;
  email: string | null;
  phone: string | null;
  role: "teacher" | "finance";
  jobTitle: string | null;
  joinedOn: string | null;
  errors: string[];
}

export interface ImportPreview {
  fingerprint: string;
  rows: ImportRow[];
  valid: number;
  invalid: number;
  /** Problems with the file as a whole (no header, too many rows…). */
  fileErrors: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fingerprintOf(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex");
}

/** Parses and checks the file itself (no database). */
export function parseStaffCsv(text: string): Omit<ImportPreview, "fingerprint"> {
  const fileErrors: string[] = [];
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) return { rows: [], valid: 0, invalid: 0, fileErrors: ["The file is larger than 256 KB."] };
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], valid: 0, invalid: 0, fileErrors: ["The file is empty."] };
  const header = table[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const index = new Map<Column, number>();
  for (const c of COLUMNS) {
    const i = header.indexOf(c);
    if (i >= 0) index.set(c, i);
  }
  for (const required of ["name", "employee_no"] as const) if (!index.has(required)) fileErrors.push(`The header row has no "${required}" column.`);
  if (!index.has("email") && !index.has("phone")) fileErrors.push('The header row needs an "email" or a "phone" column.');
  const unknown = header.filter((h) => h && !(COLUMNS as readonly string[]).includes(h));
  if (unknown.length) fileErrors.push(`Unknown column(s): ${unknown.join(", ")}. Allowed: ${COLUMNS.join(", ")}.`);
  const body = table.slice(1);
  if (body.length === 0) fileErrors.push("The file has a header but no staff rows.");
  if (body.length > MAX_IMPORT_ROWS) fileErrors.push(`At most ${MAX_IMPORT_ROWS} staff per import; this file has ${body.length}.`);
  if (fileErrors.length) return { rows: [], valid: 0, invalid: 0, fileErrors };

  const cell = (r: string[], c: Column) => (index.has(c) ? (r[index.get(c)!] ?? "").trim() : "");
  const seenEmp = new Map<string, number>();
  const seenEmail = new Map<string, number>();
  const rows: ImportRow[] = body.map((r, i) => {
    const line = i + 2;
    const errors: string[] = [];
    const name = cell(r, "name");
    const employeeNo = cell(r, "employee_no");
    const emailRaw = cell(r, "email").toLowerCase();
    const phoneRaw = cell(r, "phone");
    const roleRaw = (cell(r, "role") || "teacher").toLowerCase();
    const jobTitle = cell(r, "job_title") || null;
    const joinedOn = cell(r, "joined_on") || null;
    if (name.length < 2 || name.length > 120) errors.push("Name must be 2–120 characters.");
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$/.test(employeeNo)) errors.push("Employee number is missing or has invalid characters.");
    const email = emailRaw ? (EMAIL.test(emailRaw) && emailRaw.length <= 254 ? emailRaw : (errors.push("Email is not valid."), null)) : null;
    const phone = phoneRaw ? (normalizePhone(phoneRaw) ?? (errors.push("Mobile number is not valid."), null)) : null;
    if (!emailRaw && !phoneRaw) errors.push("Give an email or a mobile number.");
    if (roleRaw !== "teacher" && roleRaw !== "finance") errors.push('Role must be "teacher" or "finance".');
    if (jobTitle && jobTitle.length > 80) errors.push("Job title must be at most 80 characters.");
    if (joinedOn && (!ISO_DATE.test(joinedOn) || Number.isNaN(Date.parse(`${joinedOn}T00:00:00Z`)))) errors.push("Joining date must be YYYY-MM-DD.");
    const empKey = employeeNo.toLowerCase();
    if (empKey) {
      if (seenEmp.has(empKey)) errors.push(`Same employee number as line ${seenEmp.get(empKey)}.`);
      else seenEmp.set(empKey, line);
    }
    if (email) {
      if (seenEmail.has(email)) errors.push(`Same email as line ${seenEmail.get(email)}.`);
      else seenEmail.set(email, line);
    }
    return { line, name, employeeNo, email, phone, role: roleRaw === "finance" ? "finance" : "teacher", jobTitle, joinedOn, errors };
  });
  return { rows, valid: rows.filter((r) => r.errors.length === 0).length, invalid: rows.filter((r) => r.errors.length > 0).length, fileErrors };
}

/** Step 1: check the file against the school's existing staff. Saves nothing. */
export async function previewStaffImport(db: Db, ctx: RequestContext, schoolId: string, text: string): Promise<ImportPreview> {
  const parsed = parseStaffCsv(text);
  const fingerprint = fingerprintOf(text);
  if (parsed.fileErrors.length || parsed.rows.length === 0) return { ...parsed, fingerprint };
  return withCapability(db, ctx, schoolId, "school.staff.manage", async (tx) => {
    const empNos = parsed.rows.map((r) => r.employeeNo.toLowerCase()).filter(Boolean);
    const existing = empNos.length
      ? await tx.select({ no: sql<string>`lower(${staffProfiles.employeeNo})` }).from(staffProfiles).where(and(eq(staffProfiles.schoolId, schoolId), inArray(sql`lower(${staffProfiles.employeeNo})`, empNos)))
      : [];
    const taken = new Set(existing.map((e) => e.no));
    const emails = parsed.rows.map((r) => r.email).filter((e): e is string => !!e);
    // Only this school's accounts are visible here; an email used at another school is caught at commit.
    const known = emails.length ? await tx.select({ email: users.email }).from(users).where(inArray(users.email, emails)) : [];
    const knownSet = new Set(known.map((k) => k.email));
    for (const r of parsed.rows) {
      if (taken.has(r.employeeNo.toLowerCase())) r.errors.push("A staff member with this employee number already exists.");
      if (r.email && knownSet.has(r.email)) r.errors.push("This email already has an account in this school.");
    }
    const invalid = parsed.rows.filter((r) => r.errors.length > 0).length;
    return { ...parsed, valid: parsed.rows.length - invalid, invalid, fingerprint };
  });
}

export interface ImportResult {
  created: number;
  /** Activation codes for the new accounts: present only in the first response, never stored. */
  codes: { employeeNo: string; name: string; code: string }[] | null;
  replayed: boolean;
}

/** Step 2: import every row, or none. */
export async function commitStaffImport(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { text: string; fingerprint: string; idempotencyKey: string },
): Promise<ImportResult> {
  if (fingerprintOf(input.text) !== input.fingerprint) throw new AppError("CONFLICT", "The file changed after the preview. Preview it again before importing.");
  const parsed = parseStaffCsv(input.text);
  if (parsed.fileErrors.length) throw new AppError("VALIDATION", parsed.fileErrors[0]!);
  if (parsed.invalid > 0) throw new AppError("VALIDATION", `${parsed.invalid} row(s) have errors. Fix the file and preview it again.`);
  let codes: ImportResult["codes"] = null;
  try {
    const out = await withCapability(db, ctx, schoolId, "school.staff.manage", (tx, actor) =>
      withIdempotency(tx, ctx, { operation: "staff.import", key: input.idempotencyKey, request: { fingerprint: input.fingerprint }, schoolId }, async () => {
        const issued: NonNullable<ImportResult["codes"]> = [];
        for (const r of parsed.rows) {
          const user = { id: randomUUID() }; // not visible to the admin until the membership exists
          await tx.insert(users).values({ id: user.id, fullName: r.name, email: r.email, phone: r.phone, passwordHash: "!" });
          await tx.insert(schoolMemberships).values({ schoolId, userId: user!.id, role: r.role });
          await tx.insert(staffProfiles).values({ schoolId, userId: user!.id, employeeNo: r.employeeNo, displayName: r.name, jobTitle: r.jobTitle, joinedOn: r.joinedOn });
          const code = await issueAccountCodeInTransaction(tx, { ...ctx, schoolId }, { userId: user!.id, purpose: "activation", reason: "Staff import" });
          issued.push({ employeeNo: r.employeeNo, name: r.name, code: code.code });
        }
        await audit(tx, { action: "staff.imported", actorUserId: actor.userId, schoolId, entityType: "staff", data: { created: issued.length, fingerprint: input.fingerprint } });
        codes = issued;
        // Stored for replays: counts only, never the codes.
        return { created: issued.length };
      }),
    );
    return { created: out.result.created, codes: out.replayed ? null : codes, replayed: out.replayed };
  } catch (e) {
    if (e instanceof AppError) throw e;
    const unique = uniqueViolation(e);
    if (unique !== null) {
      if (unique.includes("email")) throw new AppError("CONFLICT", "One of the emails already has an Examio account (possibly at another school). Remove that row and invite the person instead. Nothing was imported.");
      if (unique.includes("employee_no")) throw new AppError("CONFLICT", "An employee number was taken meanwhile. Preview again. Nothing was imported.");
      throw new AppError("CONFLICT", "A row clashes with existing data. Nothing was imported.");
    }
    if (foreignKeyViolation(e)) throw new AppError("CONFLICT", "The import could not be completed. Nothing was imported.");
    throw e;
  }
}
