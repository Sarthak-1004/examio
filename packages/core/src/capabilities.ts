import { and, eq, ne, sql } from "drizzle-orm";
import { schoolMemberships, schools, withContext, type Db, type RequestContext, type Tx } from "@examio/db";
import { requireSchoolScope, requireUuid } from "./authz";
import { AppError } from "./errors";

/**
 * Capability checks: what each role may do inside its own school.
 *
 * Deny by default. A capability that is not listed for a role is refused, and a new capability
 * is not available to anyone, including platform administrators, until it is added here.
 * Extend the map deliberately when a module needs it; do not test role names in services.
 *
 * This is the service layer of two: PostgreSQL policies independently enforce the tenant
 * boundary for every statement.
 */
export type SchoolRole = (typeof schoolMemberships.$inferSelect)["role"];

export const CAPABILITY_ROLES = {
  /** The school's own profile: name, board, medium, status. */
  "school.view": ["school_admin", "teacher", "student", "parent", "finance"],
  /** How many active members hold each role. */
  "school.member_counts.view": ["school_admin"],
  /** Names and contact details of the school's members. */
  "school.members.view": ["school_admin"],
  /** Issue or cancel activation and reset codes, and end sessions, for users the school manages. */
  "school.accounts.recover": ["school_admin"],
  /** Create, list and revoke membership invitations. */
  "school.invitations.manage": ["school_admin"],
  /** See when platform support accessed the school, and why. */
  "school.support_access.view": ["school_admin"],
  /** Upload files for general school use (downloads follow each file's own visibility rules). */
  "school.files.upload": ["school_admin", "teacher"],
  /** Read the school's audit log. */
  "school.audit.view": ["school_admin"],
  /** Read the school's setup: years, classes, sections, subjects, grading, calendar, sessions. */
  "school.setup.view": ["school_admin", "teacher", "student", "parent", "finance"],
  /** Create, change, archive and delete setup, and edit the school profile. */
  "school.setup.manage": ["school_admin"],
  /** Staff records: list, search, export. */
  "school.staff.view": ["school_admin"],
  /** Add staff, change their details, mark them left, assign classes and subjects, import. */
  "school.staff.manage": ["school_admin"],
  /** A teacher's own classes, subjects and class-teacher sections. */
  "school.teaching.view": ["teacher"],
  /** Student records: list, search, profile, enrollment history, reports, export. */
  "school.students.view": ["school_admin"],
  /** Admit, edit, enroll, move, promote, mark left, import students; their documents. */
  "school.students.manage": ["school_admin"],
  /** Link and unlink parents and guardians; create guardian accounts and child-specific codes. */
  "school.guardians.manage": ["school_admin"],
  /** Students of the sections a teacher teaches today (database policies limit the rows). */
  "school.roster.view": ["teacher"],
  /** A parent's own linked children (database policies limit the rows to active links). */
  "school.children.view": ["parent"],
  /** A student's own record and enrollment. */
  "school.own_record.view": ["student"],
  /** Take attendance registers (database policies limit teachers to their sections, dates and edit window). */
  "school.attendance.mark": ["school_admin", "teacher"],
  /** School-wide attendance: register status, reports, change history, exports. */
  "school.attendance.view": ["school_admin"],
  /** Attendance settings: edit window, weekly days off, lock date. */
  "school.attendance.manage": ["school_admin"],
  /** Read the timetable (database policies: members of the school). */
  "school.timetable.view": ["school_admin", "teacher", "student", "parent", "finance"],
  /** Add and remove timetable periods. */
  "school.timetable.manage": ["school_admin"],
  /** Set homework, review submissions, return feedback, send reminders (policies: own sections for teachers). */
  "school.homework.manage": ["school_admin", "teacher"],
  /** Read homework addressed to oneself or one's children (policies decide which). */
  "school.homework.view": ["school_admin", "teacher", "student", "parent"],
  /** Submit one's own homework, including uploading the files for it. */
  "school.homework.submit": ["student"],
  /** Publish notices (policies: administrators any audience, teachers their own sections). */
  "school.announcements.publish": ["school_admin", "teacher"],
  /** Read notices addressed to oneself. */
  "school.announcements.view": ["school_admin", "teacher", "student", "parent", "finance"],
  /** Fee setup, student accounts, invoices, receipts, reports (finance staff and administrators). */
  "school.fees.view": ["school_admin", "finance"],
  /** Draft fee structures, issue invoices, record offline payments, request concessions and adjustments. */
  "school.fees.manage": ["school_admin", "finance"],
  /** Approve fee structures, concessions and adjustments (never one's own request); cancel invoices. */
  "school.fees.approve": ["school_admin"],
  /** A parent's children's fee statements and online payments (policies: linked children only). */
  "school.fees.pay": ["parent"],
  /** Chapters, topics and the question bank (policies: administrators, and teachers of the subject). */
  "school.questions.manage": ["school_admin", "teacher"],
  /** Publish, send back and archive questions. */
  "school.questions.publish": ["school_admin"],
  /** Build practice sets from published questions, assign them to sections, see participation (policies: subject authors; teachers assign to their sections). */
  "school.practice.manage": ["school_admin", "teacher"],
  /** Take practice assigned to one's own section and see one's own progress. */
  "school.practice.take": ["student"],
} as const satisfies Record<string, readonly SchoolRole[]>;

export type Capability = keyof typeof CAPABILITY_ROLES;

/**
 * Capabilities a platform administrator holds in any school. Kept explicit: the platform role
 * is not an automatic entitlement to school records. Holding a capability only lets the call
 * through; the database still limits the rows to school administrators unless a support access
 * grant is open for that school (see services/support-access.ts).
 */
export const PLATFORM_CAPABILITIES: readonly Capability[] = ["school.view", "school.members.view"];

/** True when at least one of `roles` grants `capability`. Pure; safe for choosing what to render. */
export function rolesGrant(roles: readonly SchoolRole[], capability: Capability): boolean {
  const allowed: readonly SchoolRole[] = CAPABILITY_ROLES[capability];
  return roles.some((r) => allowed.includes(r));
}

/** Who is acting, as confirmed by the database inside the current transaction. */
export interface Actor {
  userId: string;
  schoolId: string;
  /** Active roles in `schoolId`; empty for a platform administrator acting from outside the school. */
  roles: SchoolRole[];
  isPlatformAdmin: boolean;
}

interface PlatformRow extends Record<string, unknown> {
  is_platform_admin: boolean;
}

/**
 * Runs `fn` in a tenant transaction after confirming the caller holds `capability` in `schoolId`.
 *
 * Roles are read from the database in the same transaction, not taken from the session, so a
 * revoked membership, a disabled account or a suspended school takes effect immediately.
 * - Another school's identifier, or no active membership: NOT_FOUND (existence is not disclosed).
 * - A member whose roles lack the capability: FORBIDDEN.
 */
export async function withCapability<T>(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  capability: Capability,
  fn: (tx: Tx, actor: Actor) => Promise<T>,
): Promise<T> {
  requireUuid(schoolId, "School");
  requireSchoolScope(ctx, schoolId);
  const userId = ctx.userId;
  if (!userId) throw new AppError("FORBIDDEN", "Not signed in.");

  return withContext(db, { ...ctx, schoolId }, async (tx) => {
    const memberships = await tx
      .select({ role: schoolMemberships.role })
      .from(schoolMemberships)
      .innerJoin(schools, eq(schools.id, schoolMemberships.schoolId))
      .where(
        and(
          eq(schoolMemberships.schoolId, schoolId),
          eq(schoolMemberships.userId, userId),
          eq(schoolMemberships.status, "active"),
          ne(schools.status, "suspended"),
        ),
      );
    const roles = memberships.map((m) => m.role);

    let isPlatformAdmin = false;
    if (ctx.isPlatformAdmin) {
      const rows = (await tx.execute<PlatformRow>(sql`select app_is_platform_admin() as is_platform_admin`)) as unknown as PlatformRow[];
      isPlatformAdmin = rows[0]?.is_platform_admin === true;
    }

    const granted = rolesGrant(roles, capability) || (isPlatformAdmin && PLATFORM_CAPABILITIES.includes(capability));
    if (!granted) {
      if (roles.length === 0 && !isPlatformAdmin) throw new AppError("NOT_FOUND", "School not found.");
      throw new AppError("FORBIDDEN", "You do not have permission to do this.");
    }
    return fn(tx, { userId, schoolId, roles, isPlatformAdmin });
  });
}
