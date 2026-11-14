import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert } from "@/components/ui";
import { getSession } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  if (await getSession()) redirect("/");
  const { reset } = await searchParams;
  return (
    <div className="flex min-h-dvh flex-col justify-center bg-gradient-to-b from-brand-50 to-slate-50 px-4 py-12">
      <div className="mx-auto w-full max-w-sm">
        <p className="text-center text-3xl font-extrabold tracking-tight text-brand-900">examio</p>
        <p className="mt-2 text-center text-sm text-slate-600">Sign in to your school account</p>
        {reset === "1" && (
          <div className="mt-6">
            <Alert tone="green">Your password is set. Sign in with your new password.</Alert>
          </div>
        )}
        <div className="mt-8 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
          <LoginForm />
        </div>
        <p className="mt-6 text-center text-xs text-slate-500">
          Students: use the username or mobile number your school gave you.
          <br />
          Forgot your password? Ask your school office for a reset code.
        </p>
        <p className="mt-3 text-center text-sm">
          <Link href="/redeem" className="font-medium text-brand-600 hover:text-brand-700">
            I have a code from my school
          </Link>
        </p>
      </div>
    </div>
  );
}
