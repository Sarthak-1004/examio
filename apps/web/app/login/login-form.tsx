"use client";

import { useActionState } from "react";
import { loginAction } from "@/app/actions/auth";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export function LoginForm() {
  const [state, action] = useActionState(loginAction, {});
  return (
    <form action={action} className="space-y-5">
      {state.message && <Alert>{state.message}</Alert>}
      <Field label="Email, mobile number or username" htmlFor="identifier">
        <Input
          id="identifier"
          name="identifier"
          required
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          defaultValue={state.values?.identifier}
          autoFocus
        />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" required autoComplete="current-password" />
      </Field>
      <SubmitButton className="w-full" pendingText="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}
