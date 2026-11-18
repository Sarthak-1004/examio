import { createHash, randomBytes } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  schoolMemberships,
  schools,
  sessions,
  users,
  withContext,
  type Db,
  type RequestContext,
} from "@examio/db";

/**
 * Session lifetime policy.
 * - Idle limit: a session ends after 7 days without use. Each validation with less than half
 *   of that remaining extends it by another 7 days.
 * - Absolute limit: no session outlives 30 days from sign-in, however active.
 * The browser cookie is issued for the absolute limit and is never renewed, so the cookie and
 * the server-side session end together; the idle limit is enforced only on the server.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_WHEN_REMAINING_MS = SESSION_TTL_MS / 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Role = (typeof schoolMemberships.$inferSelect)["role"];

export interface SessionUser {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  username: string | null;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
}

export interface SessionMembership {
  schoolId: string;
  schoolName: string;
  schoolCode: string;
  /** The school's IANA time zone, for showing dates and times the way the school sees them. */
  timezone: string;
  role: Role;
}

export interface AuthSession {
  sessionId: string;
  expiresAt: Date;
  user: SessionUser;
  memberships: SessionMembership[];
  /** True when the account has a confirmed authenticator app (two-step sign-in). */
  mfaEnabled: boolean;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Session rows are visible only to their own user, so every statement runs as that user. */
const ownContext = (userId: string): RequestContext => ({ userId, schoolId: null, isPlatformAdmin: false });

interface SessionLookupRow extends Record<string, unknown> {
  user_id: string;
  expires_ms: number;
  created_ms: number;
  pending_mfa: boolean;
}

interface MfaOwnRow extends Record<string, unknown> {
  confirmed: boolean;
}

/** How long a user has to enter their second factor after a correct password. */
export const PENDING_MFA_TTL_MS = 10 * 60 * 1000;

export interface SessionLookup {
  userId: string;
  expiresAt: Date;
  absoluteEnd: Date;
  /** Password accepted, second factor still owed. Such a session authenticates nothing. */
  pendingMfa: boolean;
}

/**
 * Finds a session by token hash before the user is known, through the reviewed
 * `auth_session_lookup` database helper (the sessions table itself is protected by RLS).
 */
export async function lookupSession(db: Db, sessionId: string): Promise<SessionLookup | null> {
  const rows = (await db.execute<SessionLookupRow>(
    sql`select user_id,
      (extract(epoch from expires_at) * 1000)::float8 as expires_ms,
      (extract(epoch from created_at) * 1000)::float8 as created_ms,
      pending_mfa
    from auth_session_lookup(${sessionId})`,
  )) as unknown as SessionLookupRow[];
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    expiresAt: new Date(row.expires_ms),
    absoluteEnd: new Date(row.created_ms + SESSION_ABSOLUTE_MAX_MS),
    pendingMfa: row.pending_mfa === true,
  };
}

export async function createSession(
  db: Db,
  userId: string,
  opts: { pendingMfa?: boolean } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const pendingMfa = opts.pendingMfa === true;
  const expiresAt = new Date(Date.now() + (pendingMfa ? PENDING_MFA_TTL_MS : SESSION_TTL_MS));
  await withContext(db, ownContext(userId), (tx) => tx.insert(sessions).values({ id: hashToken(token), userId, expiresAt, pendingMfa }));
  return { token, expiresAt };
}

/** Whether a user has a confirmed authenticator. Runs as that user. */
export async function userHasMfa(db: Db, userId: string): Promise<boolean> {
  return withContext(db, ownContext(userId), async (tx) => {
    const rows = (await tx.execute<MfaOwnRow>(sql`select confirmed from auth_mfa_own()`)) as unknown as MfaOwnRow[];
    return rows[0]?.confirmed === true;
  });
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  const id = hashToken(token);
  const found = await lookupSession(db, id);
  if (!found) return;
  await withContext(db, ownContext(found.userId), (tx) => tx.delete(sessions).where(eq(sessions.id, id)));
}

/** Validate a session token and load the user + active memberships. Returns null if invalid/expired/disabled. */
export async function validateSession(db: Db, token: string): Promise<AuthSession | null> {
  const id = hashToken(token);
  const found = await lookupSession(db, id);
  if (!found) return null;

  return withContext(db, ownContext(found.userId), async (tx) => {
    if (Math.min(found.expiresAt.getTime(), found.absoluteEnd.getTime()) <= Date.now()) {
      await tx.delete(sessions).where(eq(sessions.id, id));
      return null;
    }
    // The second factor has not been given yet: not signed in.
    if (found.pendingMfa) return null;

    const [u] = await tx
      .select({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        phone: users.phone,
        username: users.username,
        isPlatformAdmin: users.isPlatformAdmin,
        mustChangePassword: users.mustChangePassword,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, found.userId));
    if (!u || u.status !== "active") return null;

    const memberships = await tx
      .select({
        schoolId: schools.id,
        schoolName: schools.name,
        schoolCode: schools.code,
        timezone: schools.timezone,
        role: schoolMemberships.role,
      })
      .from(schoolMemberships)
      .innerJoin(schools, eq(schools.id, schoolMemberships.schoolId))
      .where(
        and(
          eq(schoolMemberships.userId, u.id),
          eq(schoolMemberships.status, "active"),
          ne(schools.status, "suspended"),
        ),
      );

    let expiresAt = found.expiresAt;
    if (expiresAt.getTime() - Date.now() < REFRESH_WHEN_REMAINING_MS) {
      // Sliding renewal, never beyond the absolute limit.
      const renewed = new Date(Math.min(Date.now() + SESSION_TTL_MS, found.absoluteEnd.getTime()));
      if (renewed.getTime() > expiresAt.getTime()) {
        expiresAt = renewed;
        await tx.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
      }
    }

    const mfa = (await tx.execute<MfaOwnRow>(sql`select confirmed from auth_mfa_own()`)) as unknown as MfaOwnRow[];

    return {
      sessionId: id,
      expiresAt,
      mfaEnabled: mfa[0]?.confirmed === true,
      user: {
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        phone: u.phone,
        username: u.username,
        isPlatformAdmin: u.isPlatformAdmin,
        mustChangePassword: u.mustChangePassword,
      },
      memberships,
    };
  });
}

/**
 * Build the RLS request context. `requestedSchoolId` (e.g. from a school-switcher cookie)
 * is only honoured if the user is a member of that school or a platform admin.
 */
export function contextFor(session: AuthSession, requestedSchoolId?: string | null): RequestContext {
  const memberSchools = [...new Set(session.memberships.map((m) => m.schoolId))];
  let schoolId: string | null = null;
  // The value comes from a cookie. For a platform administrator it is not checked against a
  // membership list, so it must at least be a UUID before it is used as the tenant context.
  if (requestedSchoolId && (memberSchools.includes(requestedSchoolId) || (session.user.isPlatformAdmin && UUID.test(requestedSchoolId)))) {
    schoolId = requestedSchoolId;
  } else if (memberSchools.length === 1) {
    schoolId = memberSchools[0]!;
  }
  return { userId: session.user.id, schoolId, isPlatformAdmin: session.user.isPlatformAdmin };
}

export function rolesIn(session: AuthSession, schoolId: string | null): Role[] {
  if (!schoolId) return [];
  return session.memberships.filter((m) => m.schoolId === schoolId).map((m) => m.role);
}
