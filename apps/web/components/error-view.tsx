"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Button } from "./ui";

/**
 * Fallback shown by route error boundaries. Shows only the server-side reference (`digest`),
 * never the error message itself, which may contain internal details. The heading takes
 * focus so screen-reader and keyboard users notice the change.
 */
export function ErrorView({ error, retry, homeHref = "/" }: { error: unknown; retry: () => void; homeHref?: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const digest = typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : undefined;
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div role="alert" className="mx-auto max-w-md rounded-xl bg-white px-6 py-10 text-center shadow-sm ring-1 ring-slate-200">
      <h1 ref={heading} tabIndex={-1} className="text-lg font-semibold text-slate-900 outline-none">
        Something went wrong
      </h1>
      <p className="mt-2 text-sm text-slate-600">
        This page could not be loaded. Your saved work is not affected. Try again, or go back to the start.
      </p>
      {digest && (
        <p className="mt-3 text-xs text-slate-500">
          Reference for support: <span className="font-mono">{digest}</span>
        </p>
      )}
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Button onClick={() => retry()}>Try again</Button>
        <Link href={homeHref} className="inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-semibold text-brand-600 hover:bg-slate-50">
          Go to start
        </Link>
      </div>
    </div>
  );
}
