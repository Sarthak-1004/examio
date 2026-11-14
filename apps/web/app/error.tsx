"use client";

import { ErrorView } from "@/components/error-view";

/** Errors outside the admin and school areas (sign-in pages, student area). */
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-12">
      <ErrorView error={error} retry={retry} />
    </div>
  );
}
