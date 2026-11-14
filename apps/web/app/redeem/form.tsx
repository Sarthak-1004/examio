"use client";

import { useActionState } from "react";
import { redeemCodeAction } from "@/app/actions/auth";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export function RedeemCodeForm({ initialCode }: { initialCode?: string }) {
  const [state, action] = useActionState(redeemCodeAction, {});
  const f = state.fields ?? {};
  return (
    <form action={action} className="space-y-5">
      {state.message && <Alert>{state.message}</Alert>}
      <Field label="Code from your school" htmlFor="code" error={f.code} hint="16 letters and numbers, for example ABCD-EFGH-2345-6789.">
        <Input
          id="code"
          name="code"
          required
          maxLength={40}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono tracking-wider"
          defaultValue={state.values?.code ?? initialCode}
          invalid={!!f.code}
          aria-describedby={f.code ? "code-error" : undefined}
        />
      </Field>
      <Field label="New password" htmlFor="newPassword" error={f.newPassword} hint="At least 8 characters.">
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          required
          minLength={8}
          maxLength={128}
          autoComplete="new-password"
          invalid={!!f.newPassword}
          aria-describedby={f.newPassword ? "newPassword-error" : undefined}
        />
      </Field>
      <Field label="Confirm new password" htmlFor="confirmPassword" error={f.confirmPassword}>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          required
          minLength={8}
          maxLength={128}
          autoComplete="new-password"
          invalid={!!f.confirmPassword}
          aria-describedby={f.confirmPassword ? "confirmPassword-error" : undefined}
        />
      </Field>
      <SubmitButton className="w-full" pendingText="Saving…">
        Set password
      </SubmitButton>
    </form>
  );
}
