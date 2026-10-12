import "server-only";

// Where the proxy sends inspections. Read from server-side configuration only: the
// variable is deliberately not NEXT_PUBLIC_*, so Next.js never inlines it into browser
// code, and nothing in a request can change it.
export const BACKEND_URL_ENV = "BLUEPRINTIQ_BACKEND_URL";

// The address the backend README starts uvicorn on.
export const DEFAULT_BACKEND_URL = "http://127.0.0.1:8000";

export type BackendConfig =
  | { ok: true; hostname: string; port: number }
  | { ok: false; reason: string };

/**
 * Validate the configured backend address. Only plain-HTTP origins on a loopback IP
 * literal are accepted (127.0.0.0/8 or [::1]), matching the trusted-local-use model.
 * Host names, including "localhost", are refused because their resolution is outside
 * our control. Unset means the default; any value that is set must be valid, and an
 * invalid value disables the proxy (fail closed) instead of falling back.
 */
export function parseBackendUrl(raw: string | undefined): BackendConfig {
  const value = raw ?? DEFAULT_BACKEND_URL;
  if (value === "" || value.trim() !== value) {
    return { ok: false, reason: "is empty or has surrounding whitespace" };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "is not a valid URL" };
  }
  if (url.protocol !== "http:") {
    return { ok: false, reason: "must use http://" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "must not contain credentials" };
  }
  // `value` may end in a bare "?" or "#", which URL normalizes away; refuse those too.
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || /[?#]/.test(value)) {
    return { ok: false, reason: "must be an origin only, without path, query or fragment" };
  }
  const hostname = loopbackAddress(url.hostname);
  if (hostname === undefined) {
    return { ok: false, reason: "must be a loopback IP address (127.0.0.0/8 or [::1])" };
  }
  const port = url.port === "" ? 80 : Number(url.port);
  if (port < 1) {
    return { ok: false, reason: "must use a port from 1 to 65535" };
  }
  return { ok: true, hostname, port };
}

// URL has already normalized IPv4 forms such as "127.1" or "0x7f.0.0.1" to dotted
// decimal and IPv6 to its compressed form, so exact matching here is sufficient.
function loopbackAddress(hostname: string): string | undefined {
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return hostname;
  if (hostname === "[::1]") return "::1";
  return undefined;
}

let reported: string | undefined;

/** Read and validate the configuration, logging an invalid value once (without echoing it). */
export function backendConfig(): BackendConfig {
  const config = parseBackendUrl(process.env[BACKEND_URL_ENV]);
  if (!config.ok && reported !== config.reason) {
    reported = config.reason;
    console.error(`[proxy] ${BACKEND_URL_ENV} ${config.reason}; inspections are disabled.`);
  }
  return config;
}
