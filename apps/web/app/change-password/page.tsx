import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { ChangePasswordForm } from "./form";

export const metadata: Metadata = { title: "Change password" };

export default async function ChangePasswordPage() {
  const s = await requireSession({ allowMustChangePassword: true });
  return (
    <div className="flex min-h-dvh flex-col justify-center bg-slate-50 px-4 py-12">
      <div className="mx-auto w-full max-w-sm">
        <h1 className="text-center text-2xl font-bold text-slate-900">
          {s.user.mustChangePassword ? "Set a new password" : "Change password"}
        </h1>
        <p className="mt-2 text-center text-sm text-slate-600">
          {s.user.mustChangePassword
            ? "Your account was created with a temporary password. Please choose your own to continue."
            : "Other devices signed in to your account will be signed out."}
        </p>
        <div className="mt-8 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
          <ChangePasswordForm />
        </div>
        {!s.user.mustChangePassword && (
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
