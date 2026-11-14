"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  AppError,
  acceptMembershipInvitation,
  beginMfaEnrollment,
  changeOwnPassword,
  clientIpFromForwardedFor,
  completeMfaChallenge,
  confirmMfaEnrollment,
  deleteSession,
  disableOwnMfa,
  login,
  markNotificationRead,
  redeemAccountCode,
} from "@examio/core";
import { db } from "@/lib/db";
import { SCHOOL_COOKIE, SESSION_COOKIE, getSession, homePathFor, requireSession, sessionCookieOptions } from "@/lib/auth";
import { mfaKey, trustedProxyHops } from "@/lib/config";
import { str, toFormState, type FormState } from "@/lib/forms";

export async function loginAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const identifier = str(fd, "identifier");
  const password = str(fd, "password");
  // Only an address written by a proxy we operate is used; a client-supplied header is ignored.
  const clientIp = clientIpFromForwardedFor((await headers()).get("x-forwarded-for"), trustedProxyHops());

  let mfaRequired: boolean;
  try {
    // login() enforces the shared rate limits and input bounds itself.
    const result = await login(db, identifier, password, { clientIp });
    mfaRequired = result.mfaRequired;
    const jar = await cookies();
    jar.set(SESSION_COOKIE, result.token, sessionCookieOptions);
    jar.delete(SCHOOL_COOKIE);
  } catch (e) {
    return toFormState(e, fd);
  }
  // With two-step sign-in the cookie holds only a pending session until the code is given.
  redirect(mfaRequired ? "/mfa" : "/");
}

export async function logoutAction(): Promise<void> {
  const s = await getSession();
  if (s) await deleteSession(db, s.token);
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(SCHOOL_COOKIE);
  redirect("/login");
}

export async function changePasswordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSession({ allowMustChangePassword: true });
  const next = str(fd, "newPassword");
  if (next !== str(fd, "confirmPassword")) {
    return { message: "The new passwords do not match.", fields: { confirmPassword: "Does not match" } };
  }
  try {
    await changeOwnPassword(db, s.ctx, s.token, str(fd, "currentPassword"), next);
  } catch (e) {
    return toFormState(e);
  }
  redirect(`${homePathFor(s)}?pw=changed`);
}

export async function selectSchoolAction(fd: FormData): Promise<void> {
  const s = await requireSession();
  const schoolId = str(fd, "schoolId");
  if (s.memberships.some((m) => m.schoolId === schoolId) || s.user.isPlatformAdmin) {
    (await cookies()).set(SCHOOL_COOKIE, schoolId, sessionCookieOptions);
  }
  redirect("/");
}

/** Public: set a password with a one-time activation or reset code handed out by the school. */
export async function redeemCodeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const newPassword = str(fd, "newPassword");
  if (newPassword !== str(fd, "confirmPassword")) {
    return { message: "The passwords do not match.", fields: { confirmPassword: "Does not match" }, values: { code: str(fd, "code") } };
  }
  const clientIp = clientIpFromForwardedFor((await headers()).get("x-forwarded-for"), trustedProxyHops());
  try {
    await redeemAccountCode(db, { code: str(fd, "code"), newPassword, clientIp });
  } catch (e) {
    return toFormState(e, fd);
  }
  redirect("/login?reset=1");
}

/** A signed-in user accepts a school's membership invitation code. */
export async function acceptInvitationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSession();
  let schoolId: string;
  try {
    ({ schoolId } = await acceptMembershipInvitation(db, s.ctx, str(fd, "code")));
  } catch (e) {
    return toFormState(e, fd);
  }
  (await cookies()).set(SCHOOL_COOKIE, schoolId, sessionCookieOptions);
  redirect("/");
}

/** Second step of sign-in: a code from the authenticator app, or a backup code. */
export async function verifyMfaAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  try {
    await completeMfaChallenge(db, token, str(fd, "code"), mfaKey());
  } catch (e) {
    return toFormState(e);
  }
  redirect("/");
}

/** Starts two-step sign-in setup and returns the secret once, for the authenticator app. */
export async function beginMfaAction(_prev: FormState, _fd: FormData): Promise<FormState> {
  const s = await requireSession({ allowMfaSetup: true });
  try {
    const label = s.user.email ?? s.user.username ?? s.user.phone ?? s.user.fullName;
    const { secret, otpauthUri } = await beginMfaEnrollment(db, s.ctx, mfaKey(), label);
    return { mfaSecret: secret, mfaUri: otpauthUri };
  } catch (e) {
    return toFormState(e);
  }
}

/** Confirms setup with the first code and returns the backup codes once. */
export async function confirmMfaAction(prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSession({ allowMfaSetup: true });
  try {
    const { recoveryCodes } = await confirmMfaEnrollment(db, s.ctx, mfaKey(), str(fd, "code"));
    return { ok: true, recoveryCodes };
  } catch (e) {
    // Keep showing the same secret so the next code can be tried.
    return { ...toFormState(e), mfaSecret: prev.mfaSecret, mfaUri: prev.mfaUri };
  }
}

export async function disableMfaAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSession({ allowMfaSetup: true });
  try {
    await disableOwnMfa(db, s.ctx, mfaKey(), str(fd, "code"));
  } catch (e) {
    return toFormState(e);
  }
  redirect("/mfa/setup?off=1");
}

/** Marks one of the signed-in user's own notifications as read. */
export async function markNotificationReadAction(fd: FormData): Promise<void> {
  const s = await requireSession();
  try {
    await markNotificationRead(db, s.ctx, str(fd, "notificationId"));
  } catch (e) {
    // Already read, or not theirs: nothing to do either way.
    if (!(e instanceof AppError && e.code === "NOT_FOUND")) throw e;
  }
  revalidatePath("/school");
}
