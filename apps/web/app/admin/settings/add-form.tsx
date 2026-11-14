"use client";

import { useActionState, useEffect, useRef } from "react";
import { addLookupAction } from "@/app/admin/actions";
import { Input } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export function AddLookupForm({ kind }: { kind: "board" | "medium" }) {
  const [state, action] = useActionState(addLookupAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action}>
      <input type="hidden" name="kind" value={kind} />
      <div className="flex gap-2">
        <Input name="name" required placeholder={kind === "board" ? "e.g. Maharashtra State Board" : "e.g. Punjabi"} aria-label={`New ${kind}`} />
        <SubmitButton variant="secondary">Add</SubmitButton>
      </div>
      {state.message && <p className={`mt-2 text-sm ${state.ok ? "text-emerald-700" : "text-red-600"}`}>{state.message}</p>}
    </form>
  );
}
