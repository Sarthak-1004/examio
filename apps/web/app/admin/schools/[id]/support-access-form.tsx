"use client";

import { useActionState } from "react";
import { startSupportAccessAction } from "@/app/admin/actions";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

/** Opens a one-hour support access grant for this school. The reason is shown to the school. */
export function SupportAccessForm({ schoolId }: { schoolId: string }) {
  const [state, action] = useActionState(startSupportAccessAction, {});
  const f = state.fields ?? {};
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="schoolId" value={schoolId} />
      {state.message && <Alert>{state.message}</Alert>}
      <Field label="Reason for access" htmlFor="support-reason" error={f.reason} hint="Visible to this school's administrators and kept in its audit log.">
        <Input
          id="support-reason"
          name="reason"
          required
          minLength={10}
          maxLength={500}
          defaultValue={state.values?.reason}
          invalid={!!f.reason}
          aria-describedby={f.reason ? "support-reason-error" : undefined}
        />
      </Field>
      <SubmitButton variant="secondary" pendingText="Opening…">
        Open access for 1 hour
      </SubmitButton>
    </form>
  );
}
