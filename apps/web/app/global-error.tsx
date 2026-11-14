"use client";

import "./globals.css";
import { ErrorView } from "@/components/error-view";

/** Last-resort fallback when the root layout itself fails. Renders its own document. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <title>Something went wrong · Examio</title>
        <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-12">
          <ErrorView error={error} retry={retry} />
        </div>
      </body>
    </html>
  );
}
