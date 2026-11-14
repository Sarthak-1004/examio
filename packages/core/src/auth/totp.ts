import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238) as used by authenticator apps:
 * HMAC-SHA1, 6 digits, 30-second steps. Implemented with node:crypto only.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous and next step as well, to tolerate clock drift and slow typing. */
const TOTP_WINDOW = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32-encoded as authenticator apps expect. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const binary = ((mac[offset]! & 127) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Returns the time step a code belongs to, or null if it is wrong.
 * The caller must still refuse a step that was already accepted (replay).
 */
export function matchTotp(secret: string, code: string, nowMs: number = Date.now()): number | null {
  const candidate = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(candidate)) return null;
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(candidate)) && matched === null) matched = step;
  }
  return matched;
}

/** The setup link understood by authenticator apps (also what a QR code would contain). */
export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------------------------------ */
/* Encryption of stored secrets                                        */
/* ------------------------------------------------------------------ */

/** Development-only key, used when MFA_ENCRYPTION_KEY is unset outside production. Public; protects nothing. */
const DEV_KEY = Buffer.from("examio-development-only-mfa-key!", "utf8"); // 32 bytes

/**
 * Resolves the 32-byte key that encrypts authenticator secrets at rest (MFA_ENCRYPTION_KEY,
 * base64). The key must be set in production; a database copy alone then reveals no secrets.
 */
export function resolveMfaKey(raw: string | undefined, isProduction: boolean): Buffer {
  if (raw === undefined || raw.trim() === "") {
    if (isProduction) throw new Error("MFA_ENCRYPTION_KEY must be set in production (32 random bytes, base64).");
    return DEV_KEY;
  }
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new Error("MFA_ENCRYPTION_KEY must be 32 bytes encoded as base64.");
  return key;
}

export function encryptSecret(key: Buffer, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(key: Buffer, stored: string): string {
  const [version, iv, tag, body] = stored.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unreadable authenticator secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
