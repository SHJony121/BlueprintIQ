// Container health check: exit 0 only if the public port answers /api/health with 200, which in
// turn requires the internal backend to be up.
import http from "node:http";

const port = Number(process.env.PORT ?? "8080");
const request = http.get(
  { host: "127.0.0.1", port, path: "/api/health", timeout: 3_000, agent: false },
  (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);
request.on("timeout", () => request.destroy());
request.on("error", () => process.exit(1));
