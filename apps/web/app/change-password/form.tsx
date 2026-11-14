"use client";

import { useActionState } from "react";
import { changePasswordAction } from "@/app/actions/auth";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePasswordAction, {});
  const f = state.fields ?? {};
  return (
    <form action={action} className="space-y-5">
      {state.message && <Alert>{state.message}</Alert>}
      <Field label="Current password" htmlFor="currentPassword" error={f.currentPassword}>
        <Input id="currentPassword" name="currentPassword" type="password" required autoComplete="current-password" invalid={!!f.currentPassword} />
      </Field>
      <Field label="New password" htmlFor="newPassword" error={f.newPassword} hint="At least 8 characters.">
        <Input id="newPassword" name="newPassword" type="password" required minLength={8} autoComplete="new-password" invalid={!!f.newPassword} />
      </Field>
      <Field label="Confirm new password" htmlFor="confirmPassword" error={f.confirmPassword}>
        <Input id="confirmPassword" name="confirmPassword" type="password" required minLength={8} autoComplete="new-password" invalid={!!f.confirmPassword} />
      </Field>
      <SubmitButton className="w-full" pendingText="Saving…">
        Save password
      </SubmitButton>
    </form>
  );
}
