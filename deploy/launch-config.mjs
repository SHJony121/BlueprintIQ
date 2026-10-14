// The single place that turns the deployment environment into the settings of the two
// processes (backend and frontend) the container runs. Pure functions, no side effects, so
// they are tested without starting anything. Nothing here weakens a protection: invalid or
// missing public settings stop the launch instead of falling back to something open.

import { isIP } from "node:net";

// Same rules as frontend/src/server/production-config.ts (a test checks the two agree).
const HOST_NAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d{1,5})?$/;

export const DEFAULTS = Object.freeze({
  PORT: "8080",
  BLUEPRINTIQ_BIND: "0.0.0.0",
  BLUEPRINTIQ_BACKEND_PORT: "8001",
  // Anonymous traffic: strict per-client limits, one inspection worker.
  BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE: "10",
  BLUEPRINTIQ_RATE_LIMIT_BURST: "5",
  BLUEPRINTIQ_MAX_UPLOADS_PER_CLIENT: "2",
  BLUEPRINTIQ_MAX_CONCURRENT_JOBS: "1",
  BLUEPRINTIQ_MAX_ADMITTED_REQUESTS: "3",
  BLUEPRINTIQ_JOB_MEMORY_LIMIT_MB: "1024",
  BLUEPRINTIQ_JOB_TIMEOUT_S: "30",
  BLUEPRINTIQ_UPLOAD_TIMEOUT_S: "30",
  BLUEPRINTIQ_QUEUE_TIMEOUT_S: "15",
  // Every job is still its own new process; "forkserver" forks it from a helper that has already
  // imported the libraries. Measured at 0.1 CPU: about 10 s of start-up CPU per job becomes ~0.1 s.
  BLUEPRINTIQ_WORKER_START_METHOD: "forkserver",
});

const isLoopback = (address) => /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address) || address === "::1";

function port(value, name, errors) {
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    errors.push(`${name} must be a port from 1 to 65535`);
    return 0;
  }
  return Number(value);
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ok: true, config: object} | {ok: false, errors: string[]}}
 */
export function readLaunchConfig(env) {
  const errors = [];
  const get = (name) => (env[name] === undefined || env[name] === "" ? DEFAULTS[name] : env[name]);

  const bind = get("BLUEPRINTIQ_BIND");
  if (isIP(bind) === 0) errors.push("BLUEPRINTIQ_BIND must be an IP address (for example 0.0.0.0)");
  const frontendPort = port(get("PORT"), "PORT", errors);
  const backendPort = port(get("BLUEPRINTIQ_BACKEND_PORT"), "BLUEPRINTIQ_BACKEND_PORT", errors);
  if (frontendPort !== 0 && frontendPort === backendPort) {
    errors.push("PORT and BLUEPRINTIQ_BACKEND_PORT must differ");
  }

  // A server that answers on a public interface must name the hosts it serves.
  const hosts = (env.BLUEPRINTIQ_ALLOWED_HOSTS ?? "").trim();
  if (hosts === "") {
    if (!isLoopback(bind)) {
      errors.push("BLUEPRINTIQ_ALLOWED_HOSTS is required when binding to a non-loopback address");
    }
  } else {
    const entries = hosts.split(",").map((entry) => entry.trim().toLowerCase());
    if (entries.length > 20 || entries.some((e) => e === "" || e.includes("*") || !HOST_NAME.test(e))) {
      errors.push("BLUEPRINTIQ_ALLOWED_HOSTS must list plain host names (no scheme, path or wildcard)");
    }
  }

  const hops = env.BLUEPRINTIQ_TRUSTED_PROXY_HOPS;
  if (hops !== undefined && hops !== "" && !/^[0-5]$/.test(hops)) {
    errors.push("BLUEPRINTIQ_TRUSTED_PROXY_HOPS must be a number from 0 to 5");
  }
  for (const name of [
    "BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE",
    "BLUEPRINTIQ_RATE_LIMIT_BURST",
    "BLUEPRINTIQ_MAX_UPLOADS_PER_CLIENT",
    "BLUEPRINTIQ_MAX_CONCURRENT_JOBS",
    "BLUEPRINTIQ_MAX_ADMITTED_REQUESTS",
    "BLUEPRINTIQ_JOB_MEMORY_LIMIT_MB",
  ]) {
    if (!/^\d{1,6}$/.test(get(name)) || Number(get(name)) < 1) {
      errors.push(`${name} must be a positive whole number`);
    }
  }
  for (const name of [
    "BLUEPRINTIQ_JOB_TIMEOUT_S",
    "BLUEPRINTIQ_UPLOAD_TIMEOUT_S",
    "BLUEPRINTIQ_QUEUE_TIMEOUT_S",
  ]) {
    if (!/^\d{1,4}(\.\d{1,3})?$/.test(get(name)) || Number(get(name)) <= 0) {
      errors.push(`${name} must be a positive number of seconds`);
    }
  }
  if (!["spawn", "forkserver"].includes(get("BLUEPRINTIQ_WORKER_START_METHOD"))) {
    errors.push("BLUEPRINTIQ_WORKER_START_METHOD must be spawn or forkserver");
  }
  if (errors.length > 0) return { ok: false, errors };

  const shared = {
    BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE: get("BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE"),
    BLUEPRINTIQ_RATE_LIMIT_BURST: get("BLUEPRINTIQ_RATE_LIMIT_BURST"),
    BLUEPRINTIQ_MAX_UPLOADS_PER_CLIENT: get("BLUEPRINTIQ_MAX_UPLOADS_PER_CLIENT"),
  };
  return {
    ok: true,
    config: {
      bind,
      port: frontendPort,
      backendPort,
      // The backend listens on loopback only and never sees a browser.
      backendEnv: {
        BLUEPRINTIQ_ENVIRONMENT: "production",
        BLUEPRINTIQ_MAX_CONCURRENT_JOBS: get("BLUEPRINTIQ_MAX_CONCURRENT_JOBS"),
        BLUEPRINTIQ_MAX_ADMITTED_REQUESTS: get("BLUEPRINTIQ_MAX_ADMITTED_REQUESTS"),
        BLUEPRINTIQ_JOB_MEMORY_LIMIT_MB: get("BLUEPRINTIQ_JOB_MEMORY_LIMIT_MB"),
        BLUEPRINTIQ_JOB_TIMEOUT_S: get("BLUEPRINTIQ_JOB_TIMEOUT_S"),
        BLUEPRINTIQ_UPLOAD_TIMEOUT_S: get("BLUEPRINTIQ_UPLOAD_TIMEOUT_S"),
        BLUEPRINTIQ_QUEUE_TIMEOUT_S: get("BLUEPRINTIQ_QUEUE_TIMEOUT_S"),
        BLUEPRINTIQ_WORKER_START_METHOD: get("BLUEPRINTIQ_WORKER_START_METHOD"),
      },
      frontendEnv: {
        BLUEPRINTIQ_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
        NODE_ENV: "production",
        ...shared,
      },
    },
  };
}
