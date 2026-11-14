export type ErrorCode =
  | "INVALID_CREDENTIALS"
  | "AMBIGUOUS_LOGIN"
  | "ACCOUNT_DISABLED"
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION";

/** Expected, user-facing errors. Anything else is a bug and should surface as a 500. */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}
