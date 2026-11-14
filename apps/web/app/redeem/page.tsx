import type { Metadata } from "next";
import Link from "next/link";
import { RedeemCodeForm } from "./form";

export const metadata: Metadata = { title: "Set your password", referrer: "no-referrer" };

/**
 * Public page: a person who was handed a one-time code by their school (first activation or a
 * password reset) chooses their own password. The code may arrive in the link as `?code=`.
 */
export default async function RedeemPage({ searchParams }: { searchParams: Promise<{ code?: string | string[] }> }) {
  const { code } = await searchParams;
  const initialCode = typeof code === "string" ? code.slice(0, 40) : undefined;
  return (
    <div className="flex min-h-dvh flex-col justify-center bg-gradient-to-b from-brand-50 to-slate-50 px-4 py-12">
      <div className="mx-auto w-full max-w-sm">
        <p className="text-center text-3xl font-extrabold tracking-tight text-brand-900">examio</p>
        <h1 className="mt-4 text-center text-xl font-bold text-slate-900">Set your password</h1>
        <p className="mt-2 text-center text-sm text-slate-600">
          Enter the code your school gave you and choose a password. The code works once.
        </p>
        <div className="mt-8 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
          <RedeemCodeForm initialCode={initialCode} />
        </div>
        <p className="mt-6 text-center text-sm">
          <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">
            ← Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
