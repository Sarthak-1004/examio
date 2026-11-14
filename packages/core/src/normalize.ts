/** Returns 10-digit Indian mobile digits, or the raw digits for other lengths, or null if not phone-like. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export function normalizeIdentifier(input: string): string {
  return input.trim().toLowerCase();
}

/** Longest login identifier accepted (the maximum length of an email address). */
export const MAX_IDENTIFIER_LENGTH = 254;
/** Longest password accepted anywhere; matches the limit applied when a password is set. */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * One key per account identifier, however it is typed: phone numbers in any format collapse to
 * their digits, everything else is Unicode-normalised, trimmed and lowercased. Used for rate
 * limiting so that re-formatting an identifier does not earn extra attempts.
 */
export function canonicalLoginKey(input: string): string {
  if (isPhoneLike(input)) {
    const phone = normalizePhone(input);
    if (phone) return `phone:${phone}`;
  }
  return `id:${normalizeIdentifier(input.normalize("NFKC"))}`;
}

/** Looks like a phone number only if it has no letters and no '@'. */
export function isPhoneLike(input: string): boolean {
  return /^[\d\s+()-]+$/.test(input.trim());
}
