"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { submitPracticeAttemptAction } from "../../actions";

/** Submits an attempt whose practice window has closed (answers saved so far are scored). */
export function ClosedSubmit({ attemptId }: { attemptId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <Button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await submitPracticeAttemptAction(attemptId);
            if (r && !r.ok) setError(r.message);
          })
        }
      >
        {pending ? "Submitting…" : "Submit attempt"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
