import { isIP } from "node:net";

/** Upper bound for TRUSTED_PROXY_HOPS; more than a handful of proxies is a configuration error. */
export const MAX_TRUSTED_PROXY_HOPS = 5;

/**
 * Parses the TRUSTED_PROXY_HOPS setting: how many reverse proxies you operate in front of the
 * application. Unset means 0 (no proxy is trusted). Anything else must be a whole number 0–5.
 */
export function parseTrustedProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  if (!/^\d+$/.test(raw.trim())) throw new Error("TRUSTED_PROXY_HOPS must be a whole number from 0 to 5.");
  const hops = Number(raw.trim());
  if (hops > MAX_TRUSTED_PROXY_HOPS) throw new Error("TRUSTED_PROXY_HOPS must be a whole number from 0 to 5.");
  return hops;
}

/**
 * Resolves the client address from `X-Forwarded-For` without trusting values a client can forge.
 *
 * Each proxy appends the address it received the request from, so only the last
 * `trustedProxyHops` entries were written by infrastructure you control. The client address is
 * the entry that many positions from the right. Everything further left is client-supplied.
 *
 * Returns null when no proxy is trusted, the header is shorter than expected, or the entry is
 * not an IP address. Callers must then skip address-based limits rather than use a forged value.
 */
export function clientIpFromForwardedFor(header: string | null | undefined, trustedProxyHops: number): string | null {
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 1 || trustedProxyHops > MAX_TRUSTED_PROXY_HOPS) return null;
  if (!header || header.length > 2000) return null;
  const parts = header.split(",").map((p) => p.trim());
  const candidate = parts[parts.length - trustedProxyHops];
  if (!candidate) return null;
  return isIP(candidate) === 0 ? null : candidate.toLowerCase();
}
