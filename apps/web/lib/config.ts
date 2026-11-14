import "server-only";
import { parseTrustedProxyHops, resolveMfaKey } from "@examio/core";
import { ensureRootEnv } from "./env";

let hops: number | undefined;

/**
 * Number of reverse proxies operated in front of the app (TRUSTED_PROXY_HOPS, default 0).
 * Throws on an invalid value; checked at server start by verifyStartup().
 */
export function trustedProxyHops(): number {
  ensureRootEnv();
  return (hops ??= parseTrustedProxyHops(process.env.TRUSTED_PROXY_HOPS));
}

let key: Buffer | undefined;

/**
 * Key that encrypts authenticator secrets at rest (MFA_ENCRYPTION_KEY, 32 bytes as base64).
 * Required when the server runs in production mode; a public development key is used otherwise.
 */
export function mfaKey(): Buffer {
  ensureRootEnv();
  return (key ??= resolveMfaKey(process.env.MFA_ENCRYPTION_KEY, process.env.NODE_ENV === "production"));
}
