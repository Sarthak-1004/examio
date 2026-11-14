"use client";

import { useActionState } from "react";
import { issueResetCodeAction } from "@/app/admin/actions";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

/**
 * Issues a one-time password reset code for one school administrator. The code appears once,
 * for the platform admin to hand over after verifying who is asking.
 */
export function ResetCodeForm({ userId, userName }: { userId: string; userName: string }) {
  const [state, action] = useActionState(issueResetCodeAction, {});
  const reasonId = `reason-${userId}`;
  const f = state.fields ?? {};
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm font-medium text-brand-600 hover:text-brand-700">Reset password…</summary>
      <div className="mt-3 space-y-3">
        {state.code ? (
          <Alert tone="green">
            <p>
              One-time code for {userName}: <span className="font-mono font-semibold tracking-wider">{state.code}</span>
            </p>
            <p className="mt-1">
              Valid until {state.codeExpires}. Give it to them directly; it is not shown again. They enter it at{" "}
              <span className="font-mono">/redeem</span> to choose a new password.
            </p>
          </Alert>
        ) : (
          <form action={action} className="space-y-3">
            <input type="hidden" name="userId" value={userId} />
            {state.message && <Alert>{state.message}</Alert>}
            <Field
              label="Reason"
              htmlFor={reasonId}
              error={f.reason}
              hint="How you confirmed who is asking. Recorded in the audit log."
            >
              <Input
                id={reasonId}
                name="reason"
                required
                minLength={5}
                maxLength={200}
                defaultValue={state.values?.reason}
                invalid={!!f.reason}
                aria-describedby={f.reason ? `${reasonId}-error` : undefined}
              />
            </Field>
            <SubmitButton variant="secondary" pendingText="Creating code…">
              Create reset code
            </SubmitButton>
          </form>
        )}
      </div>
    </details>
  );
}
