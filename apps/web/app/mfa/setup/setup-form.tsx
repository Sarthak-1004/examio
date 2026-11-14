"use client";

import Link from "next/link";
import { useActionState } from "react";
import { beginMfaAction, confirmMfaAction, disableMfaAction } from "@/app/actions/auth";
import { Alert, ButtonLink, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

/** Splits a base32 key into groups of four so it is easier to type into an app. */
const grouped = (key: string) => key.match(/.{1,4}/g)?.join(" ") ?? key;

function CodeField({ id, error, label }: { id: string; error?: string; label: string }) {
  return (
    <Field label={label} htmlFor={id} error={error}>
      <Input
        id={id}
        name="code"
        required
        maxLength={40}
        inputMode="numeric"
        autoComplete="one-time-code"
        className="font-mono tracking-widest"
        invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
    </Field>
  );
}

/** Two-step enrolment: get a key, add it to the app, confirm with the first code, save backup codes. */
export function MfaSetupForm({ required }: { required: boolean }) {
  const [begun, begin] = useActionState(beginMfaAction, {});
  const [confirmed, confirm] = useActionState(confirmMfaAction, begun);
  // The confirm state starts empty until its own action has run; fall back to the key just issued.
  const secret = confirmed.mfaSecret ?? begun.mfaSecret;
  const uri = confirmed.mfaUri ?? begun.mfaUri;

  if (confirmed.recoveryCodes) {
    return (
      <div className="space-y-4">
        <Alert tone="green">Two-step sign-in is on. From now on you need your password and a code from the app.</Alert>
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Backup codes</h2>
          <p className="mt-1 text-sm text-slate-600">
            Each code works once if you cannot use the app. Write them down and keep them somewhere safe. They are not shown again.
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-1 font-mono text-sm text-slate-900 sm:grid-cols-2" aria-label="Backup codes">
            {confirmed.recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <ButtonLink href="/" className="w-full">
          I have saved my backup codes
        </ButtonLink>
      </div>
    );
  }

  if (!secret) {
    return (
      <form action={begin} className="space-y-4">
        {begun.message && <Alert>{begun.message}</Alert>}
        <p className="text-sm text-slate-600">
          You need an authenticator app on your phone, such as Google Authenticator or Microsoft Authenticator.
          {required && " Platform administrators must set this up before they can continue."}
        </p>
        <SubmitButton className="w-full" pendingText="Preparing…">
          Start setup
        </SubmitButton>
      </form>
    );
  }

  return (
    <form action={confirm} className="space-y-5">
      {confirmed.message && <Alert>{confirmed.message}</Alert>}
      <input type="hidden" name="issued" value="1" />
      <ol className="list-decimal space-y-3 pl-5 text-sm text-slate-700">
        <li>
          In your authenticator app choose <b>Add account</b>, then <b>Enter a setup key</b>.
        </li>
        <li>
          Account name: <b>Examio</b>. Key (time-based):
          <span className="mt-1 block break-all rounded-md bg-slate-100 px-3 py-2 font-mono text-sm text-slate-900" data-testid="mfa-secret">
            {grouped(secret)}
          </span>
          {uri && (
            <a href={uri} className="mt-1 inline-block font-medium text-brand-600 hover:text-brand-700">
              On this phone? Open in authenticator app
            </a>
          )}
        </li>
        <li>Enter the 6-digit code the app now shows.</li>
      </ol>
      <CodeField id="code" label="Code from the app" error={confirmed.fields?.code} />
      <SubmitButton className="w-full" pendingText="Checking…">
        Turn on two-step sign-in
      </SubmitButton>
    </form>
  );
}

export function MfaDisableForm() {
  const [state, action] = useActionState(disableMfaAction, {});
  return (
    <form action={action} className="space-y-4">
      {state.message && <Alert>{state.message}</Alert>}
      <CodeField id="disable-code" label="Current code from the app, to turn it off" error={state.fields?.code} />
      <div className="flex flex-wrap gap-3">
        <SubmitButton variant="danger" pendingText="Turning off…">
          Turn off two-step sign-in
        </SubmitButton>
        <Link href="/" className="self-center text-sm font-medium text-brand-600 hover:text-brand-700">
          Keep it on
        </Link>
      </div>
    </form>
  );
}
