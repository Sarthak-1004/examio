import { createHash, randomBytes } from "node:crypto";

/**
 * One-time codes that a school hands to a person (account activation, password reset,
 * membership invitation). 16 characters of Crockford base32 = 80 random bits: far beyond
 * guessing, yet short enough to copy from paper. Only the SHA-256 hash is ever stored.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
const CODE_LENGTH = 16;

export function generateCode(): string {
  const bytes = randomBytes(10); // 80 bits
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out = ALPHABET[Number(bits & 31n)]! + out;
    bits >>= 5n;
  }
  return out;
}

/** Display form: XXXX-XXXX-XXXX-XXXX. */
export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/**
 * Accepts a code however it was typed: any case, with or without spaces or hyphens, and with
 * the look-alike letters O, I and L read as 0, 1 and 1. Returns null if it cannot be a code.
 */
export function normalizeCode(input: string): string | null {
  if (input.length > 64) return null;
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null;
  return cleaned;
}

export function hashCode(normalizedCode: string): string {
  return createHash("sha256").update(normalizedCode).digest("hex");
}
