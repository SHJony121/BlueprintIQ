// Test helpers: real HTTP servers on 127.0.0.1, fixture loading, and a `next start` process.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

/**
 * The frontend directory: the nearest ancestor of the working directory whose package.json
 * is this app's. Found this way (not from import.meta) so the helpers also load in
 * Playwright, which runs these files as CommonJS.
 */
export const FRONTEND_DIR = findFrontendDir(process.cwd());

function findFrontendDir(start: string): string {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "blueprintiq-frontend") return dir;
    } catch {
      // no package.json here
    }
    if (path.dirname(dir) === dir) throw new Error(`run from inside frontend/ (started in ${start})`);
  }
}
export const DRAWINGS_DIR = path.resolve(FRONTEND_DIR, "../backend/tests/fixtures/drawings");
export const MIB = 1024 * 1024;

/** A synthetic drawing from the backend's committed fixtures. */
export function drawing(name: string): Buffer {
  return readFileSync(path.join(DRAWINGS_DIR, `${name}.pdf`));
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  /** Bytes received so far (complete only when `completed` is true). */
  readonly body: Buffer;
  completed: boolean;
  /** Resolves when the connection carrying this request closes, for whatever reason. */
  closed: Promise<void>;
}

export interface Upstream {
  port: number;
  requests: RecordedRequest[];
  openConnections(): number;
  close(): Promise<void>;
}

/**
 * A real HTTP server standing in for the backend. `handler` decides the response;
 * the server records every request (headers, body bytes, completion, connection close).
 */
export async function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, rec: RecordedRequest) => void,
): Promise<Upstream> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    let resolveClosed!: () => void;
    const chunks: Buffer[] = [];
    const rec: RecordedRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      get body() {
        return Buffer.concat(chunks);
      },
      completed: false,
      closed: new Promise((resolve) => (resolveClosed = resolve)),
    };
    requests.push(rec);
    req.socket.once("close", () => resolveClosed());
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => (rec.completed = true));
    req.on("error", () => {});
    res.on("error", () => {});
    handler(req, res, rec);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await listen(server);
  return {
    port,
    requests,
    openConnections: () => sockets.size,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Respond once the whole request body has arrived. */
export function afterBody(
  respond: (req: http.IncomingMessage, res: http.ServerResponse, rec: RecordedRequest) => void,
) {
  return (req: http.IncomingMessage, res: http.ServerResponse, rec: RecordedRequest) => {
    req.on("end", () => respond(req, res, rec));
  };
}

export function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export function envelope(code: string, requestId = "f".repeat(32)) {
  return { error: { code, message: "Backend message.", request_id: requestId } };
}

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
}

/** A port that nothing is listening on (bound once, then released). */
export async function unusedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Poll until `check` passes or the time runs out. */
export async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export interface ChildServer {
  port: number;
  output(): string;
  stop(): Promise<void>;
}

/** Start a long-running process and wait until `url(port)` answers with `readyStatus`. */
async function startProcess(
  command: string,
  args: (port: number) => string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; readyPath: string; readyStatus: number },
): Promise<ChildServer> {
  const port = await unusedPort();
  const child: ChildProcess = spawn(command, args(port), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const stop = async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}${options.readyPath}`);
      await response.arrayBuffer();
      if (response.status === options.readyStatus) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`server did not start:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { port, output: () => output, stop };
}

/**
 * Run one of the package.json launch scripts (`start` or `dev`) as npm would, but
 * without a shell, so the process can be stopped cleanly. The script's own arguments are
 * used unchanged (that is what is being tested); only a free port is added.
 */
export function startLaunchScript(script: "start" | "dev"): Promise<ChildServer> {
  const command = (
    JSON.parse(readFileSync(path.join(FRONTEND_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts[script];
  const [bin, ...args] = (command ?? "").split(" ");
  if (bin !== "next") throw new Error(`script "${script}" is not a plain next command: ${command}`);
  const nextBin = path.join(FRONTEND_DIR, "node_modules/next/dist/bin/next");
  return startProcess(
    process.execPath,
    (port) => [nextBin, ...args, "--port", String(port)],
    {
      cwd: FRONTEND_DIR,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      readyPath: "/api/ready",
      readyStatus: 404,
    },
  );
}

/** The production build served by `next start` on 127.0.0.1 (requires `npm run build`). */
export function startNext(backendUrl: string | undefined): Promise<ChildServer> {
  const env: NodeJS.ProcessEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
  delete env.BLUEPRINTIQ_BACKEND_URL;
  if (backendUrl !== undefined) env.BLUEPRINTIQ_BACKEND_URL = backendUrl;
  const nextBin = path.join(FRONTEND_DIR, "node_modules/next/dist/bin/next");
  return startProcess(
    process.execPath,
    (port) => [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: FRONTEND_DIR, env, readyPath: "/api/ready", readyStatus: 404 },
  );
}

export const BACKEND_DIR = path.resolve(FRONTEND_DIR, "../backend");

/** The backend's interpreter: ../backend/.venv (requires `uv sync --locked` there). */
export function backendPython(): string {
  return (
    process.env.BLUEPRINTIQ_BACKEND_PYTHON ??
    path.join(
      BACKEND_DIR,
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    )
  );
}

/** The real FastAPI backend from ../backend/.venv. */
export function startBackend(): Promise<ChildServer> {
  const backendDir = BACKEND_DIR;
  return startProcess(
    backendPython(),
    (port) => [
      "-m",
      "uvicorn",
      "blueprintiq.api.app:create_app",
      "--factory",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--log-level",
      "warning",
    ],
    { cwd: backendDir, env: { ...process.env }, readyPath: "/healthz", readyStatus: 200 },
  );
}

export interface RawResponse {
  status: number;
  head: string;
  body: string;
}

/** Parse the first HTTP/1.1 response from raw socket data. */
export function parseRaw(data: string): RawResponse {
  const end = data.indexOf("\r\n\r\n");
  const head = end === -1 ? data : data.slice(0, end);
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
  let body = end === -1 ? "" : data.slice(end + 4);
  if (/^transfer-encoding: chunked/im.test(head)) body = dechunk(body);
  return { status, head, body };
}

function dechunk(data: string): string {
  let out = "";
  let rest = data;
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd === -1) return out;
    const size = parseInt(rest.slice(0, lineEnd), 16);
    if (!size) return out;
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

/**
 * Talk to a server over a plain TCP socket, for things fetch cannot express: a false
 * Content-Length, a foreign Host header, or disconnecting halfway through an upload.
 */
export function rawSocket(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  let received = "";
  socket.on("data", (chunk: Buffer) => (received += chunk.toString("latin1")));
  socket.on("error", () => {});
  const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return {
    socket,
    /** Write, waiting for buffer space; resolves early if the server closes the socket. */
    write: (data: string | Buffer) =>
      new Promise<void>((resolve) => {
        if (socket.destroyed || socket.write(data)) return resolve();
        const done = () => {
          socket.off("drain", done);
          socket.off("close", done);
          resolve();
        };
        socket.once("drain", done);
        socket.once("close", done);
      }),
    /** Wait for the server to close the connection, then parse what it sent. */
    response: async (timeoutMs = 10_000): Promise<RawResponse> => {
      const timer = setTimeout(() => socket.destroy(), timeoutMs);
      await ended;
      clearTimeout(timer);
      return parseRaw(received);
    },
    received: () => received,
  };
}
