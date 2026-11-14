import { AppError } from "@examio/core";

export interface FormState {
  ok?: boolean;
  message?: string;
  fields?: Record<string, string>;
  /** Echo of submitted values so forms keep input after an error. */
  values?: Record<string, string>;
  /** A one-time code to show to the person who just issued it. Never stored in the page. */
  code?: string;
  /** When that code stops working, already formatted for display. */
  codeExpires?: string;
  /** Two-step sign-in setup: the secret and setup link, shown once to the person enrolling. */
  mfaSecret?: string;
  mfaUri?: string;
  /** Backup codes, shown once after enrolment. */
  recoveryCodes?: string[];
}

export function formValues(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !/password/i.test(k)) out[k] = v;
  return out;
}

/** Converts expected AppErrors to form state; rethrows unexpected errors (Next shows the error page). */
export function toFormState(e: unknown, fd?: FormData): FormState {
  if (e instanceof AppError) return { message: e.message, fields: e.fields, values: fd ? formValues(fd) : undefined };
  throw e;
}

export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}
