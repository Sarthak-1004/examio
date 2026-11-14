import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { JoinSchoolForm } from "./form";

export const metadata: Metadata = { title: "Join a school" };

/**
 * A signed-in user enters a membership invitation code from another school. Accepting is their
 * consent to be linked to that school; their account and password stay their own.
 */
export default async function JoinSchoolPage() {
  const s = await requireSession();
  return (
    <div className="flex min-h-dvh flex-col justify-center bg-slate-50 px-4 py-12">
      <div className="mx-auto w-full max-w-sm">
        <h1 className="text-center text-2xl font-bold text-slate-900">Join a school</h1>
        <p className="mt-2 text-center text-sm text-slate-600">
          Signed in as {s.user.fullName}. Enter the invitation code a school gave you to add that school to your account.
        </p>
        <div className="mt-8 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
          {s.user.isPlatformAdmin ? (
            <p className="text-sm text-slate-600">Platform administrator accounts cannot join a school by invitation.</p>
          ) : (
            <JoinSchoolForm />
          )}
        </div>
        <p className="mt-6 text-center text-sm">
          <Link href="/" className="font-medium text-brand-600 hover:text-brand-700">
            ← Back
          </Link>
        </p>
      </div>
    </div>
  );
}
