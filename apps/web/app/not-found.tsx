import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found" };

/** Also shown for records the signed-in user may not see, so existence is never disclosed. */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-12">
      <div className="max-w-md rounded-xl bg-white px-6 py-10 text-center shadow-sm ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm text-slate-600">The page does not exist, or you do not have access to it.</p>
        <Link href="/" className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700">
          Go to start
        </Link>
      </div>
    </div>
  );
}
