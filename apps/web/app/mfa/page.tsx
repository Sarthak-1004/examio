import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPendingMfa } from "@examio/core";
import { logoutAction } from "@/app/actions/auth";
import { SESSION_COOKIE, getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { MfaChallengeForm } from "./form";

export const metadata: Metadata = { title: "Two-step sign-in" };

/** Second step of sign-in for accounts with an authenticator app. */
export default async function MfaChallengePage() {
  if (await getSession()) redirect("/");
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !(await getPendingMfa(db, token))) redirect("/login");
  return (
    <div className="flex min-h-dvh flex-col justify-center bg-gradient-to-b from-brand-50 to-slate-50 px-4 py-12">
      <div className="mx-auto w-full max-w-sm">
        <p className="text-center text-3xl font-extrabold tracking-tight text-brand-900">examio</p>
        <h1 className="mt-4 text-center text-xl font-bold text-slate-900">Two-step sign-in</h1>
        <p className="mt-2 text-center text-sm text-slate-600">Your password was correct. Enter the current code to finish signing in.</p>
        <div className="mt-8 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
          <MfaChallengeForm />
        </div>
        <form action={logoutAction} className="mt-6 text-center">
          <button className="text-sm font-medium text-brand-600 hover:text-brand-700">Cancel and sign in as someone else</button>
        </form>
      </div>
    </div>
  );
}
