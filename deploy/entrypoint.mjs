// The container's only process manager: starts the backend (loopback only) and the frontend,
// waits for the backend before opening the public port, and stops both cleanly. If either one
// dies the other is stopped too and the container exits non-zero, so the platform restarts it.
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLaunchConfig } from "./launch-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const frontendDir = process.env.BLUEPRINTIQ_FRONTEND_DIR ?? path.join(root, "frontend");
const backendSrc = process.env.BLUEPRINTIQ_BACKEND_SRC ?? path.join(root, "backend", "src");
const python = process.env.BLUEPRINTIQ_PYTHON ?? "python";
const STOP_GRACE_MS = 10_000;
const BACKEND_START_MS = 60_000;

const launch = readLaunchConfig(process.env);
if (!launch.ok) {
  for (const problem of launch.errors) console.error(`[launch] ${problem}`);
  console.error("[launch] refusing to start with this configuration");
  process.exit(2);
}
const { bind, port, backendPort, backendEnv, frontendEnv } = launch.config;

const children = new Map();
let stopping = false;

function start(name, command, args, options) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (!stopping) {
      console.error(`[launch] ${name} exited (${signal ?? code}); stopping`);
      shutdown(1);
    }
  });
  return child;
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill("SIGTERM");
  const force = setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
  }, STOP_GRACE_MS);
  const wait = setInterval(() => {
    if (children.size === 0) {
      clearTimeout(force);
      clearInterval(wait);
      process.exit(code);
    }
  }, 100);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

function backendIsUp() {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port: backendPort, path: "/healthz", timeout: 1_000, agent: false },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

start(
  "backend",
  python,
  [
    "-m",
    "uvicorn",
    "blueprintiq.api.app:create_app",
    "--factory",
    "--host",
    "127.0.0.1",
    "--port",
    String(backendPort),
    "--no-server-header",
    "--timeout-keep-alive",
    "5",
    "--log-level",
    "warning",
  ],
  {
    cwd: frontendDir,
    env: {
      ...process.env,
      ...backendEnv,
      PYTHONPATH: [backendSrc, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
  },
);

const deadline = Date.now() + BACKEND_START_MS;
while (!stopping && !(await backendIsUp())) {
  if (Date.now() > deadline) {
    console.error("[launch] the backend did not start in time");
    shutdown(1);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

if (!stopping) {
  const nextBin = path.join(frontendDir, "node_modules", "next", "dist", "bin", "next");
  start("frontend", process.execPath, [nextBin, "start", "--hostname", bind, "--port", String(port)], {
    cwd: frontendDir,
    env: {
      ...process.env,
      ...frontendEnv,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=192",
    },
  });
  console.error(`[launch] listening on ${bind}:${port}; backend on 127.0.0.1:${backendPort} (internal)`);
}
