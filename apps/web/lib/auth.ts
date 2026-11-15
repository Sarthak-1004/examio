import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_ABSOLUTE_MAX_MS, contextFor, rolesIn, validateSession, type AuthSession, type Role } from "@examio/core";
import type { RequestContext } from "@examio/db";
import { db } from "./db";

export const SESSION_COOKIE = "examio_session";
export const SCHOOL_COOKIE = "examio_school";

export interface CurrentSession extends AuthSession {
  token: string;
  ctx: RequestContext;
  roles: Role[];
}

/** Resolve the signed-in user for this request (memoised per request). */
export const getSession = cache(async (): Promise<CurrentSession | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const s = await validateSession(db, token);
  if (!s) return null;
  const ctx = contextFor(s, jar.get(SCHOOL_COOKIE)?.value);
  return { ...s, token, ctx, roles: rolesIn(s, ctx.schoolId) };
});

export async function requireSession(
  opts: { allowMustChangePassword?: boolean; allowMfaSetup?: boolean } = {},
): Promise<CurrentSession> {
  const s = await getSession();
  if (!s) redirect("/login");
  if (s.user.mustChangePassword && !opts.allowMustChangePassword) redirect("/change-password");
  // Platform administrators must enrol an authenticator before anything else; the database
  // grants them no platform access until they have.
  if (s.user.isPlatformAdmin && !s.mfaEnabled && !opts.allowMfaSetup && !opts.allowMustChangePassword) redirect("/mfa/setup");
  return s;
}

export async function requirePlatformAdmin(): Promise<CurrentSession> {
  const s = await requireSession();
  if (!s.user.isPlatformAdmin) redirect("/");
  return s;
}

/** Requires an active school context in which the user holds one of `roles`. */
export async function requireSchoolRole(...roles: Role[]): Promise<CurrentSession & { ctx: { schoolId: string } }> {
  const s = await requireSession();
  if (!s.ctx.schoolId || !s.roles.some((r) => roles.includes(r))) redirect("/");
  return s as CurrentSession & { ctx: { schoolId: string } };
}

/** Where a user should land after signing in. */
export function homePathFor(s: CurrentSession): string {
  if (s.roles.includes("school_admin") || s.roles.includes("teacher")) return "/school";
  if (s.roles.includes("student")) return "/student";
  if (s.roles.includes("parent")) return "/parent";
  if (s.roles.includes("finance")) return "/school/fees";
  if (s.user.isPlatformAdmin) return "/admin";
  if (s.memberships.length > 1 && !s.ctx.schoolId) return "/select-school";
  return "/no-access";
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  // Issued once at sign-in for the absolute session limit and never renewed, so the cookie and
  // the server-side session end together. The 7-day idle limit is enforced on the server.
  maxAge: SESSION_ABSOLUTE_MAX_MS / 1000,
};
