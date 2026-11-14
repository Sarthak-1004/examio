"use client";

import { ErrorView } from "@/components/error-view";

export default function SchoolError({ error, retry }: { error: unknown; retry: () => void }) {
  return <ErrorView error={error} retry={retry} homeHref="/school" />;
}
