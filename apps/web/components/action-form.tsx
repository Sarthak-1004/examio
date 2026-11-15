"use client";

import { createContext, startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import type { FormState } from "@/lib/forms";
import { cx } from "./ui";

/** Lets SubmitButton show the pending state of an ActionForm (which submits without the form `action` prop). */
export const ActionFormPending = createContext(false);

/**
 * A form bound to a server action that returns FormState. Shows the action's message after it
 * runs: errors as an alert next to the form (announced to screen readers), successes as a polite
 * status.
 *
 * It submits through `onSubmit` rather than the form `action` prop on purpose: with the prop,
 * React clears every input after each submission, so a validation error would wipe what the
 * person typed. Here inputs are kept on errors and cleared only after a success (unless
 * `keepValues` is set). Browser validation (required, min, max) still runs first.
 */
export function ActionForm({
  action,
  children,
  className,
  keepValues = false,
  inline = false,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  children: ReactNode;
  className?: string;
  keepValues?: boolean;
  /** Lay out children and the message on one line (row actions). */
  inline?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok && !keepValues) ref.current?.reset();
  }, [state, keepValues]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    // Include the clicked button's name/value (forms with several submit buttons).
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    const fd = new FormData(e.currentTarget, submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : null);
    startTransition(() => formAction(fd));
  };

  const message = state.message ? (
    <div role={state.ok ? "status" : "alert"} className={cx("text-sm", state.ok ? "text-emerald-700" : "text-red-700")}>
      <p>{state.message}</p>
      {state.code && (
        // One-time codes are shown once, right after they are issued; the page never stores them.
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-slate-900 ring-1 ring-emerald-200">
          One-time code: <span className="font-mono text-base font-semibold tracking-wider" data-testid="one-time-code">{state.code}</span>
          {state.codeExpires && <span className="block text-xs text-slate-600">Valid until {state.codeExpires}. It is not shown again.</span>}
        </p>
      )}
    </div>
  ) : null;
  return (
    <ActionFormPending.Provider value={pending}>
      <form ref={ref} onSubmit={onSubmit} aria-busy={pending || undefined} className={cx(inline ? "flex flex-wrap items-center gap-2" : "space-y-3", className)}>
        {children}
        {message}
      </form>
    </ActionFormPending.Provider>
  );
}
