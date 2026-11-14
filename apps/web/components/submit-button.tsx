"use client";

import { useContext } from "react";
import { useFormStatus } from "react-dom";
import { ActionFormPending } from "./action-form";
import { Button } from "./ui";
import type { ComponentProps } from "react";

export function SubmitButton({
  children,
  pendingText,
  ...p
}: ComponentProps<typeof Button> & { pendingText?: string }) {
  // Pending for forms using the `action` prop (useFormStatus) and for ActionForm (context).
  const { pending: formPending } = useFormStatus();
  const actionFormPending = useContext(ActionFormPending);
  const pending = formPending || actionFormPending;
  return (
    <Button type="submit" disabled={pending || p.disabled} aria-busy={pending} {...p}>
      {pending && (
        <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="4" />
          <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        </svg>
      )}
      {pending ? (pendingText ?? children) : children}
    </Button>
  );
}
