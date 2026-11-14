"use client";

import { useActionState } from "react";
import { verifyMfaAction } from "@/app/actions/auth";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export function MfaChallengeForm() {
  const [state, action] = useActionState(verifyMfaAction, {});
  const f = state.fields ?? {};
  return (
    <form action={action} className="space-y-5">
      {state.message && <Alert>{state.message}</Alert>}
      <Field label="Code from your authenticator app" htmlFor="code" error={f.code} hint="6 digits. If you lost your phone, enter one of your backup codes instead.">
        <Input
          id="code"
          name="code"
          required
          maxLength={40}
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          className="font-mono tracking-widest"
          invalid={!!f.code}
          aria-describedby={f.code ? "code-error" : undefined}
        />
      </Field>
      <SubmitButton className="w-full" pendingText="Checking…">
        Verify
      </SubmitButton>
    </form>
  );
}
