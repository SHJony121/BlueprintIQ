# Frontend F1: backend proxy

**Scope:** one server-side route in the Next.js app that forwards a PDF upload to the FastAPI backend and relays the answer. No upload UI, viewer or overlay yet (F2–F4).

**This proxy is for trusted local use, like the backend.** It is not production-secure and must not be deployed publicly. It has no authentication, rate limiting or TLS. See [security-and-deployment.md](security-and-deployment.md).

## Routes

| Route (Next.js, port 3000) | Behaviour |
|---|---|
| `POST /api/inspections` | Forwarded to the backend's `POST /api/v1/inspections`. Body: the raw PDF, `Content-Type: application/pdf`, optional `X-Filename` (percent-encoded UTF-8), the same contract as the backend. |
| any other method on `/api/inspections` | `405 METHOD_NOT_ALLOWED` with `Allow: POST`. Nothing is forwarded. |
| any other `/api/...` path, including `/api` | `404 NOT_FOUND`. Nothing is forwarded. |

The browser never learns the backend's address. The proxy only ever requests the one fixed backend path; nothing in a request (path, query, headers) can change the destination.

## Configuration

| Variable | Default | Rules |
|---|---|---|
| `BLUEPRINTIQ_BACKEND_URL` | `http://127.0.0.1:8000` | Read on the server at request time. It is deliberately **not** `NEXT_PUBLIC_*`, so it is never inlined into browser code. Must be `http://` plus a **loopback IP literal** (`127.0.0.0/8` or `[::1]`) and an optional port from 1 to 65535, with no credentials, path, query or fragment. Host names, including `localhost`, are refused because their resolution is outside the app's control. |

**Fail closed:** if the variable is set but invalid (including empty), every inspection request gets `500 PROXY_MISCONFIGURED`. The proxy does not fall back to the default. The server log states the reason once without echoing the value.

`npm run dev` and `npm run start` bind Next.js to `127.0.0.1` only.

**Warning: start the app only through these scripts.** Next's own default is `0.0.0.0` (all interfaces). If the server is started another way (`npx next start`, an IDE run configuration, a container entrypoint), it listens on the network. A program on another machine can then send `Host: 127.0.0.1:3000` without browser headers, pass the `Host` check, and reach the unauthenticated backend through the proxy. The handler cannot detect the bound address: Next reports an all-interfaces bind as `localhost`. Enforcing the bind at runtime would need a custom server. **Decision (F2): no custom server is added.** The supported launch commands are `npm run dev` and `npm run start`; the scripts and the actual listening addresses are verified by tests (see [frontend-f2.md](frontend-f2.md#loopback-binding-a-decision-restated)). The `Host` and `Origin` checks described below are not a substitute for loopback binding.

## Protections

**Who may call it**
* `Host` must be `localhost`, `127.x.x.x` or `[::1]` (with an optional port). Otherwise `403 FORBIDDEN`. This blocks DNS-rebinding pages, whose requests carry a foreign `Host`.
* If the browser sends `Origin`, it must be exactly this app's origin. If it sends `Sec-Fetch-Site`, it must be `same-origin`. Requests without these headers (curl, scripts on the same machine) are allowed.
* No CORS headers are ever sent. `Content-Type: application/pdf` is not a CORS "simple" type, so a cross-site page cannot send this request without a preflight, and the preflight (`OPTIONS`) is refused.

**What is forwarded**
* The upstream request's headers are built from scratch: `Content-Type: application/pdf`, `Accept: application/json`, `Accept-Encoding: identity`, the validated `X-Filename` if present, and what Node adds itself (`Host`, `Transfer-Encoding: chunked`, `Connection: close`). Cookies, `Authorization`, `Proxy-Authorization`, `X-Forwarded-*`, `Forwarded`, the client's `X-Request-ID`, and hop-by-hop headers are never forwarded.
* `X-Filename` must be visible ASCII or space (percent-encoded UTF-8 is), at most 3,060 characters (255 code points × 12). Otherwise `422 REQUEST_VALIDATION_ERROR`. The backend still applies its own check of 255 decoded characters, and its answer is relayed.
* The browser's `Content-Length` is not forwarded. The upload goes upstream chunked, so a false `Content-Length` cannot desynchronize the backend connection.

**Upload size**
* A declared `Content-Length` above 10 MiB (10,485,760 bytes) is refused at once with `413 FILE_TOO_LARGE`, without reading the body.
* The streamed bytes are counted as they pass. When the count would exceed 10 MiB, the upstream request is aborted and `413` is returned. The backend has never received more than 10 MiB, and never a complete request. This is the limit that is actually enforced; `Content-Length` is only used for the early refusal. Status, code and message are identical to the backend's own 413.
* Only the chunk in flight is held in memory (backpressure through `stream.pipeline`).

**What is returned**
* The backend's response is read into memory up to **16 MiB** and checked before anything is sent to the browser:
  * `200`: `Content-Type: application/json`, valid UTF-8, and a JSON object.
  * `400, 404, 405, 408, 413, 415, 422, 500, 503` (the statuses the backend documents): JSON with the error envelope (`error.code`, `error.message`, `error.request_id`).
  * Anything else is `502 BACKEND_INVALID_RESPONSE`: redirects (never followed), other statuses, a non-JSON or truncated body, a body over the cap (declared or counted).
* Valid responses are relayed **byte for byte** with their status. Response headers are rebuilt: only `Content-Type`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `X-Request-ID`. The backend's id is kept if it is 32 hex characters; otherwise the proxy's own id is used.
* Why buffer the response instead of streaming it? The report is one bounded JSON document. Streaming would commit to a `200` before the proxy knows the body is complete and valid, so a truncated or malformed report could reach the browser as a success.

**Response size cap: how 16 MiB was chosen.** PDFs were generated at the backend's text limits (5,000 lines, 100,000 characters) with the backend's own fixture writer, and inspected. The largest report produced was **4.31 MiB** (5,000 ambiguous-unit annotations such as `LENGTH: 25 M`). Measurement lines gave 2.1–2.3 MiB; 5,000 ambiguous diameters gave 4.12 MiB. This is the largest **measured**, not a proven maximum; 16 MiB leaves about 3.7× headroom.

## Limits and timeouts

| Limit | Value | Result |
|---|---|---|
| Upload size | 10 MiB, the backend's default (`MAX_UPLOAD_BYTES`) | `413 FILE_TOO_LARGE` |
| Upload deadline: the whole body must reach the backend in | 35 s (the backend's own deadline is 30 s, so its `408` normally wins) | `408 UPLOAD_TIMEOUT` |
| Whole exchange, first byte to last | 120 s (backend worst case with its **default** settings: 30 s upload + 30 s queue + 30 s job + process start) | `504 BACKEND_TIMEOUT` |
| Response size | 16 MiB | `502 BACKEND_INVALID_RESPONSE` |

The proxy's limits are constants matching the backend's **defaults**. If the backend's `BLUEPRINTIQ_UPLOAD_TIMEOUT_S`, `QUEUE_TIMEOUT_S` or `JOB_TIMEOUT_S` are raised, the proxy may answer `504` while the backend is still working, and that job still occupies a worker slot. Change both together.

The whole-exchange deadline also covers a backend that accepts the connection but never answers, and a response body that stalls. Connecting to a loopback port that nothing listens on fails immediately (`502 BACKEND_UNAVAILABLE`).

## Errors

Every error uses the backend's envelope `{"error": {"code", "message", "request_id"}}` and the `X-Request-ID` header, with fixed messages: no addresses, ports, Node error text or stack traces. Errors the proxy makes itself have a proxy-generated id, which does not appear in backend logs.

| Status | Code | Origin |
|---|---|---|
| 400 | `CLIENT_DISCONNECTED` | browser went away (no one receives it) |
| 403 | `FORBIDDEN` | `Host`, `Origin` or `Sec-Fetch-Site` check |
| 404 / 405 | `NOT_FOUND` / `METHOD_NOT_ALLOWED` | route or method not proxied |
| 408 | `UPLOAD_TIMEOUT` | upload deadline (or relayed from the backend) |
| 413 | `FILE_TOO_LARGE` | upload limit (or relayed) |
| 415 | `UNSUPPORTED_CONTENT_TYPE` | not `application/pdf` (or relayed) |
| 422 | `REQUEST_VALIDATION_ERROR` | malformed `X-Filename` (or relayed) |
| 500 | `PROXY_MISCONFIGURED` | invalid `BLUEPRINTIQ_BACKEND_URL` |
| 502 | `BACKEND_UNAVAILABLE` | connection refused, or closed before an answer |
| 502 | `BACKEND_INVALID_RESPONSE` | redirect, unexpected status, malformed, truncated or oversized response |
| 504 | `BACKEND_TIMEOUT` | whole-exchange deadline |
| *backend's* | *backend's* | every documented backend error is relayed unchanged |

The proxy logs one JSON line per failure to the server console: event, reason, request id, error class and Node error code. It never logs addresses, file names, error messages or upload data.

## Cancellation

When the browser disconnects, mid-upload or while waiting, the proxy aborts its backend request and closes that connection. Next.js signals this through `request.signal`, which fires when the response closes before it has finished. This is verified against a real `next start` server.

**This does not cancel the backend's processing.** The backend has no disconnect cancellation (a documented Phase 1 limitation). An inspection that has already started runs until it finishes or reaches its 30 s job timeout, and still holds one of its worker slots meanwhile.

## Known limitations

* **Loopback binding is enforced only by the npm scripts** (see Configuration), and is verified by tests, not by the proxy.
* **Early backend answers can be lost.** The backend can answer before it has read the whole body: `503 SERVER_BUSY` under load is decided before reading. It then closes the connection while the proxy is still uploading, and the resulting TCP reset can discard the answer before it is read (observed on Windows with a 4 MiB upload). The browser then gets a `502` (`BACKEND_UNAVAILABLE`, or `BACKEND_INVALID_RESPONSE` if the reset cuts off the answer's body) instead of `503`. HTTP/1.1 has no way to recover this. It is never reported as success.
* **Trusted local use only.** There is no authentication: any process on the machine can call the proxy. The `Host`/`Origin` checks guard against web pages, not local programs.
* **Response buffering.** Up to 16 MiB per request is held in memory. Validation adds roughly 3–4× that transiently: the decoded UTF-16 string and the parsed JSON. Backend admission control (4 requests at once) bounds the total in normal use; the proxy itself has no concurrency limit.
* **No Next.js proxy/middleware file.** If `proxy.ts` or `middleware.ts` were added, Next would copy every request body into memory and silently truncate it at 10 MB (`proxyClientMaxBodySize`). An oversized upload would then reach the route looking complete and be forwarded truncated. A unit test (`tests/proxy/guards.test.ts`) fails if such a file appears.
* **Over-limit streaming clients see a reset.** A client still streaming a chunked body past 10 MiB receives the complete `413`, then a TCP reset when it keeps writing. Browsers send `Content-Length` for `File` bodies, so they get the early refusal before any body is sent.
* **The limit is fixed.** The proxy's 10 MiB limit is a constant equal to the backend's default. If the backend is configured lower, its own 413 is relayed. If it is configured higher, the proxy remains the stricter limit.
* **One backend connection per request** (no keep-alive), which is simple and leaves nothing open between requests. This is fine at local volumes.

## Tests

`npm test` (unit), `npm run test:server` (needs `npm run build`), `npm run test:backend` (needs `npm run build` and `uv sync --locked` in `backend/`). All use real HTTP servers on `127.0.0.1`; the only stand-in is a scripted HTTP server playing the backend for failure cases that the real backend cannot produce on demand.

| Suite | What it runs against | Covers |
|---|---|---|
| `src/server/backend-config.test.ts` | pure function | accepted and refused backend addresses (alternative IPv4 spellings, IPv4-mapped IPv6, link-local, credentials, path/query/fragment, whitespace, other schemes) |
| `tests/proxy/handler.test.ts` | the handler in-process, scripted backend over real HTTP | byte-identical relay, exact upstream header set, envelope pass-through, content types, `X-Filename`, `Host`/`Origin`/`Sec-Fetch-Site`, upload at and over the limit (with no or understated `Content-Length`), redirects, unexpected statuses, malformed/truncated/non-UTF-8/oversized responses, refused connection, dropped connection, timeouts (no answer, stalled body, stalled upload), early backend answers, client aborts, misconfiguration, no leaked connections or timers after mixed failures |
| `tests/proxy/next-server.test.ts` | the production build (`next start`), scripted backend, raw TCP sockets | relay through real Next, 405/404 envelopes without CORS headers, foreign `Host`, cross-site requests, a declared 50 MiB `Content-Length`, a chunked upload past 10 MiB, a pipelined request after a short `Content-Length`, disconnect mid-upload and while waiting, fail-closed configuration that does not leak the address |
| `tests/proxy/guards.test.ts` | project files | no Next.js `proxy`/`middleware` file exists |
| `tests/proxy/backend.test.ts` | production build + **real FastAPI backend** | all 32 committed fixtures sent both directly and through the proxy, with identical status and body (apart from `processing_time_ms`); UTF-8 file names; the backend's own file-name length check; empty and non-PDF bodies; 413 identical to the backend's; an upload of exactly 10 MiB |

**Do the tests prove the protections?** Each of these was removed in turn, and the unit suite then failed: the `$` anchor of the `Host` check, upload byte counting, the client-abort listener, the response-status allow-list, the counted response cap, the upstream header allow-list, and clearing either deadline timer. Not caught: removing `request.signal`'s listener *cleanup* after a finished exchange, which has no observable effect in the tests.

CI (`frontend-ci`) runs unit and server tests in the `checks` job and the real-backend suite in a separate `proxy-backend` job (uv + locked backend environment).
