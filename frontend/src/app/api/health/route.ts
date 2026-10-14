import http from "node:http";
import { backendConfig } from "@/server/backend-config";

// Liveness and readiness for a container or load balancer: 200 only while this server is up
// AND the internal backend answers. It returns nothing but a status word, takes no input,
// and is the one route that does not check the Host header (probes use the platform's own).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function reply(ok: boolean): Response {
  return new Response(JSON.stringify({ status: ok ? "ok" : "unavailable" }), {
    status: ok ? 200 : 503,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function backendIsUp(): Promise<boolean> {
  const config = backendConfig();
  if (!config.ok) return Promise.resolve(false);
  return new Promise((resolve) => {
    const request = http.get(
      { host: config.hostname, port: config.port, path: "/healthz", timeout: 2_000, agent: false },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

export async function GET(): Promise<Response> {
  return reply(await backendIsUp());
}
