"use client";

import { useActionState } from "react";
import { acceptInvitationAction } from "@/app/actions/auth";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export function JoinSchoolForm() {
  const [state, action] = useActionState(acceptInvitationAction, {});
  const f = state.fields ?? {};
  return (
    <form action={action} className="space-y-5">
      {state.message && <Alert>{state.message}</Alert>}
      <Field label="Invitation code" htmlFor="code" error={f.code} hint="16 letters and numbers from the school that invited you.">
        <Input
          id="code"
          name="code"
          required
          maxLength={40}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono tracking-wider"
          defaultValue={state.values?.code}
          invalid={!!f.code}
          aria-describedby={f.code ? "code-error" : undefined}
        />
      </Field>
      <SubmitButton className="w-full" pendingText="Joining…">
        Join school
      </SubmitButton>
    </form>
  );
}
