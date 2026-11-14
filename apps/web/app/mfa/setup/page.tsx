import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { MfaDisableForm, MfaSetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Two-step sign-in", referrer: "no-referrer" };

/**
 * Turn two-step sign-in (authenticator app) on or off. Required for platform administrators,
 * optional for school administrators, not available to other roles.
 */
export default async function MfaSetupPage({ searchParams }: { searchParams: Promise<{ off?: string }> }) {
  const s = await requireSession({ allowMfaSetup: true });
  const { off } = await searchParams;
  const isPlatformAdmin = s.user.isPlatformAdmin;
  const eligible = isPlatformAdmin || s.memberships.some((m) => m.role === "school_admin");
  const mustEnrol = isPlatformAdmin && !s.mfaEnabled;

  return (
    <div className="flex min-h-dvh flex-col justify-center bg-slate-50 px-4 py-12">
      <div className="mx-auto w-full max-w-md">
        <h1 className="text-center text-2xl font-bold text-slate-900">Two-step sign-in</h1>
        <p className="mt-2 text-center text-sm text-slate-600">
          A second step after your password: a 6-digit code from an app on your phone.
        </p>
        {off === "1" && (
          <div className="mt-6">
            <Alert tone="amber">Two-step sign-in is now off for your account.</Alert>
          </div>
        )}
        <div className="mt-8 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
          {!eligible ? (
            <p className="text-sm text-slate-600">Two-step sign-in is available to platform and school administrators only.</p>
          ) : !s.mfaEnabled ? (
            <MfaSetupForm required={isPlatformAdmin} />
          ) : isPlatformAdmin ? (
            <p className="text-sm text-slate-600">
              Two-step sign-in is on. It is required for platform administrators and cannot be turned off. If you lose your phone,
              use a backup code; if you have neither, an operator must issue a recovery code.
            </p>
          ) : (
            <div className="space-y-4">
              <Alert tone="green">Two-step sign-in is on for your account.</Alert>
              <MfaDisableForm />
            </div>
          )}
        </div>
        {!mustEnrol && (
          <p className="mt-6 text-center text-sm">
            <Link href="/" className="font-medium text-brand-600 hover:text-brand-700">
              ← Back
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
