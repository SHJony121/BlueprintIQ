import "server-only";
import { isIP } from "node:net";
import { RateLimiter } from "./rate-limit";

// Everything that differs between running on one machine and running on a public host, read
// from server-side environment variables only (never NEXT_PUBLIC_*, never from a request).
//
//   BLUEPRINTIQ_ALLOWED_HOSTS          exact Host values the public site answers to, comma
//                                      separated (example.com,www.example.com,example.com:8443).
//                                      Unset: only loopback names are accepted (local use).
//   BLUEPRINTIQ_TRUSTED_PROXY_HOPS     how many reverse proxies in front of this server append
//                                      to X-Forwarded-For (0 = none, the header is ignored).
//   BLUEPRINTIQ_CLIENT_IP_HEADER       a header that a trusted edge sets to the client address
//                                      (for example Fly-Client-IP); ignored unless set.
//   BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE  inspections per client per minute; unset or 0 = off.
//   BLUEPRINTIQ_RATE_LIMIT_BURST       short burst allowed (default 5).
//   BLUEPRINTIQ_MAX_UPLOADS_PER_CLIENT uploads one client may have running at once (default 2).
//   BLUEPRINTIQ_MAX_TRACKED_CLIENTS    memory bound for the limiter (default 10000).
//
// Nothing here switches a protection off: with no configuration the proxy accepts loopback
// hosts only, exactly as before.

const LOCAL_HOST = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d{1,5})?$/i;
const HOST_NAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d{1,5})?$/;
const MAX_ALLOWED_HOSTS = 20;
const MAX_PROXY_HOPS = 5;

export interface HostPolicy {
  /** Lower-case Host header values that are accepted besides loopback names. */
  readonly allowed: ReadonlySet<string>;
  /** Set when BLUEPRINTIQ_ALLOWED_HOSTS is present but unusable: nothing public is accepted. */
  readonly invalid: string | null;
}

export interface ClientIdentity {
  readonly hops: number;
  /** Lower-case name of a header set by a trusted edge, or null. */
  readonly header: string | null;
}

export interface ProxyPolicy {
  readonly hosts: HostPolicy;
  readonly clients: ClientIdentity;
  readonly limiter: RateLimiter | null;
}

/** Parse the allow-list. An unusable value is reported, and nothing public is allowed. */
export function parseAllowedHosts(raw: string | undefined): HostPolicy {
  if (raw === undefined || raw.trim() === "") return { allowed: new Set(), invalid: null };
  const entries = raw.split(",").map((entry) => entry.trim().toLowerCase());
  if (entries.length > MAX_ALLOWED_HOSTS) return refuse("lists too many hosts");
  for (const entry of entries) {
    if (entry === "" || entry.includes("*") || !HOST_NAME.test(entry)) {
      return refuse("contains an entry that is not a plain host name (no scheme, path or wildcard)");
    }
  }
  return { allowed: new Set(entries), invalid: null };
}

function refuse(reason: string): HostPolicy {
  return { allowed: new Set(), invalid: reason };
}

/**
 * May this Host header be served? Loopback names always, other names only if listed exactly.
 * Browsers send the Host they used, including a non-default port; list it that way.
 */
export function hostAllowed(host: string | null, policy: HostPolicy): boolean {
  if (host === null) return false;
  const value = host.toLowerCase();
  return LOCAL_HOST.test(value) || policy.allowed.has(value);
}

/**
 * Is this a request from the application's own pages? The Host must be allowed; an Origin, if
 * present, must be exactly that host (https is accepted only for a listed host, since a
 * loopback server has no certificate); Sec-Fetch-Site, if present, must be same-origin.
 * Requests without browser headers (curl, tests) are allowed, as before.
 */
export function sameOrigin(headers: Headers, policy: HostPolicy): boolean {
  const host = headers.get("host");
  if (!hostAllowed(host, policy)) return false;
  const value = host!.toLowerCase();
  const origin = headers.get("origin");
  if (origin !== null) {
    const lower = origin.toLowerCase();
    const httpsOk = !LOCAL_HOST.test(value) && lower === `https://${value}`;
    if (lower !== `http://${value}` && !httpsOk) return false;
  }
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

/**
 * The client a request counts against, or "unknown".
 *
 * Only headers a trusted piece of infrastructure writes are used. X-Forwarded-For is read
 * from the RIGHT: with N trusted proxies the Nth entry from the end is the address the first
 * of them saw; everything to its left was supplied by the client or by earlier hops and is
 * ignored, so a visitor cannot choose their own key. With no trusted proxy configured the
 * header is ignored altogether and every request shares one bucket, which is safe (strict)
 * rather than spoofable.
 */
export function clientKey(headers: Headers, identity: ClientIdentity): string {
  if (identity.header !== null) {
    const value = headers.get(identity.header)?.trim();
    if (value !== undefined && isIP(value) !== 0) return value.toLowerCase();
    return "unknown";
  }
  if (identity.hops < 1) return "unknown";
  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const entry = entries.length >= identity.hops ? entries[entries.length - identity.hops] : undefined;
  return entry !== undefined && isIP(entry) !== 0 ? entry.toLowerCase() : "unknown";
}

function integer(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^\d{1,9}$/.test(raw.trim())) return fallback;
  return Math.min(max, Math.max(min, Number(raw)));
}

export function clientIdentity(env: NodeJS.ProcessEnv = process.env): ClientIdentity {
  const header = env.BLUEPRINTIQ_CLIENT_IP_HEADER?.trim().toLowerCase();
  return {
    hops: integer(env.BLUEPRINTIQ_TRUSTED_PROXY_HOPS, 0, 0, MAX_PROXY_HOPS),
    header: header !== undefined && /^[a-z0-9-]{1,64}$/.test(header) ? header : null,
  };
}

declare global {
  var __blueprintiqLimiter: { signature: string; limiter: RateLimiter | null } | undefined;
}

/**
 * The limiter for this configuration, shared by every request of this process. In memory:
 * each running instance counts separately, so N instances allow N times the limits (use the
 * platform's own limit or an edge rule for a global one).
 */
export function limiterFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimiter | null {
  const perMinute = integer(env.BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE, 0, 0, 100_000);
  const burst = integer(env.BLUEPRINTIQ_RATE_LIMIT_BURST, 5, 1, 1_000);
  const concurrent = integer(env.BLUEPRINTIQ_MAX_UPLOADS_PER_CLIENT, 2, 1, 100);
  const tracked = integer(env.BLUEPRINTIQ_MAX_TRACKED_CLIENTS, 10_000, 100, 1_000_000);
  const signature = [perMinute, burst, concurrent, tracked].join("/");
  const cached = globalThis.__blueprintiqLimiter;
  if (cached !== undefined && cached.signature === signature) return cached.limiter;
  const limiter =
    perMinute === 0
      ? null
      : new RateLimiter({ perMinute, burst, maxConcurrent: concurrent, maxClients: tracked });
  globalThis.__blueprintiqLimiter = { signature, limiter };
  return limiter;
}

let warned = false;

/** The proxy's policy from the environment (read per request, so a restart is not needed in tests). */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): ProxyPolicy {
  const hosts = parseAllowedHosts(env.BLUEPRINTIQ_ALLOWED_HOSTS);
  if (hosts.invalid !== null && !warned) {
    warned = true;
    console.error(`BLUEPRINTIQ_ALLOWED_HOSTS ${hosts.invalid}; no public host is accepted.`);
  }
  return { hosts, clients: clientIdentity(env), limiter: limiterFromEnv(env) };
}
