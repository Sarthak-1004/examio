"use client";

import { Button } from "./ui";

/** Opens the browser's print dialog (save as PDF from there). */
export function PrintButton({ label = "Print or save as PDF" }: { label?: string }) {
  return (
    <Button type="button" variant="secondary" onClick={() => window.print()} className="print:hidden">
      {label}
    </Button>
  );
}
