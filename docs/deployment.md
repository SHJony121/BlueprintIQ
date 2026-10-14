# Deployment (Launch-1 preparation)

This describes how BlueprintIQ is prepared to run as a free, anonymous public upload site. **Nothing is deployed, and no host is chosen.** Public release stays blocked until the items under [Release blockers](#release-blockers) are done.

## Shape

One container, two processes, started by `deploy/entrypoint.mjs`:

| Process | Listens on | Reachable from |
|---|---|---|
| Next.js (`next start`) | `0.0.0.0:$PORT` (default 8080) | the platform's reverse proxy |
| FastAPI (`uvicorn`) | `127.0.0.1:8001` | the frontend process only |

The browser only ever talks to Next.js. The frontend reaches the backend at `BLUEPRINTIQ_BACKEND_URL` (set by the entrypoint to the loopback address); the address is never sent to a browser. If either process exits, the other is stopped and the container exits non-zero so the platform restarts it. `SIGTERM` stops both (10 s grace, then `SIGKILL`); inspection workers are children of the backend and die with it.

## Build and run

```bash
docker build --build-arg SOURCE_URL=https://<public source of this version> -t blueprintiq .
docker run --rm --init --read-only --tmpfs /tmp --memory 1536m -p 8080:8080 \
  -e BLUEPRINTIQ_ALLOWED_HOSTS=<your public host name> \
  -e BLUEPRINTIQ_TRUSTED_PROXY_HOPS=1 \
  blueprintiq
```

* `--build-arg SITE_URL=https://<public origin>` is optional: it gives the social-preview image an absolute address. Without it no preview image is linked (nothing points at localhost).
* The build **fails** unless `SOURCE_URL` is an `https` address (AGPL section 13; the footer links it). `deploy/verify-source-url.mjs <url> --online` additionally checks that anonymous visitors can read it; a private repository fails that check.
* Python dependencies are installed from `backend/uv.lock` with `pip --require-hashes`; Node dependencies with `npm ci`. Base images are pinned by digest.
* The container runs as UID 10001, needs only a writable `/tmp`, and contains no PDFs other than the two original sample drawings, and no secrets or env files. Do not bake secrets into the image; there are none to supply.

## Settings

The container refuses to start (exit code 2, reason printed) when a setting is invalid, or when it binds a non-loopback address without `BLUEPRINTIQ_ALLOWED_HOSTS`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Public port (platforms set this). |
| `BLUEPRINTIQ_BIND` | `0.0.0.0` | Public bind address. |
| `BLUEPRINTIQ_BACKEND_PORT` | `8001` | Internal backend port (loopback). |
| `BLUEPRINTIQ_ALLOWED_HOSTS` | none | **Required.** Comma-separated exact `Host` values the site answers to (`demo.example.org`, or `host:port`). No schemes, paths or wildcards; an invalid list serves nothing public. Loopback names are always answered (health check, local use). |
| `BLUEPRINTIQ_TRUSTED_PROXY_HOPS` | `0` | Number of reverse proxies that append to `X-Forwarded-For`. The client address is read that many entries from the **right**; entries to its left (which a visitor can forge) are ignored. `0` ignores the header: all visitors share one bucket (strict, never spoofable). |
| `BLUEPRINTIQ_CLIENT_IP_HEADER` | none | Alternative: a header your edge sets itself and overwrites on every request (for example `fly-client-ip`). Use only if the platform guarantees that. |
| `BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE` / `_BURST` | `10` / `5` | Per-client upload rate (token bucket). Over the limit: `429 RATE_LIMITED` with `Retry-After`. |
| `BLUEPRINTIQ_MAX_UPLOADS_PER_CLIENT` | `2` | Uploads in flight per client: `429 TOO_MANY_UPLOADS`. |
| `BLUEPRINTIQ_MAX_CONCURRENT_JOBS` | `1` | Inspection workers running at once. |
| `BLUEPRINTIQ_MAX_ADMITTED_REQUESTS` | `3` | Requests admitted at once (running + waiting); more get `503 SERVER_BUSY`. |
| `BLUEPRINTIQ_WORKER_START_METHOD` | `forkserver` | `forkserver` or `spawn`: how each job's new process is started. |
| `BLUEPRINTIQ_JOB_DATA_LIMIT_MB` | derived | Cap on a worker's private memory (Linux). Unset: container limit minus 300 MiB, at least 192 MiB (212 MiB at 512 MiB); `0` turns it off. |
| `BLUEPRINTIQ_WORKER_PREFER_OOM_VICTIM` | `1` | The worker asks the kernel to stop it first if the container runs out of memory. |
| `BLUEPRINTIQ_JOB_MEMORY_LIMIT_MB` | `1024` | Address-space limit per worker (`RLIMIT_AS`, Linux). |
| `BLUEPRINTIQ_JOB_TIMEOUT_S` / `_UPLOAD_TIMEOUT_S` / `_QUEUE_TIMEOUT_S` | `30` / `30` / `15` | Worker run time, time allowed to receive the upload, time allowed to wait for a free worker. |
| `BLUEPRINTIQ_BACKEND_ALLOW_PRIVATE` | unset | `1` lets `BLUEPRINTIQ_BACKEND_URL` be a private-network IP (RFC 1918). Not needed in this container. |
| `BLUEPRINTIQ_ENABLE_DIAGNOSTICS` | unset | `1` serves `/pdfjs-check` and `/viewer-check`. For automated tests only; never set it in production. |

## Protections in production

* **Host and Origin:** requests whose `Host` is not allow-listed get `403` before any upload byte is read; `Origin`, when sent, must be the site itself (`https://<allowed host>`, or `http://` for the same host), `Sec-Fetch-Site` must not be cross-site. Nothing is disabled globally.
* **Client identity** comes only from the trusted proxy hops or edge header above, never from an arbitrary `X-Forwarded-For`. Client-identity headers and cookies are not forwarded to the backend.
* **Limits:** 10 MiB upload (enforced while streaming, `Content-Length` not trusted), upload and total request deadlines, per-client rate and concurrency, global worker concurrency and admission control, per-worker timeout and memory limit.
* **Abandoned requests:** a client that disconnects mid-upload or while waiting stops its worker (kill and reap) instead of letting it run to the timeout.
* **Headers:** CSP (`default-src 'self'`, no framing, same-origin workers, `wasm-unsafe-eval` for PDF.js), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, permissions/COOP/CORP policies, HSTS. Inspection responses carry `Cache-Control: no-store`. The CSP allows inline scripts because Next.js inlines hydration data; a nonce would make every page dynamic. This is a documented trade-off.
* **Removed in production:** backend `/docs`, `/redoc`, `/openapi.json`; the `/pdfjs-check` and `/viewer-check` pages.
* **Logs:** request id, status, duration, sizes and hash prefixes; never PDF contents or text.

### Rate-limit limitations

The limiter is **in memory, per container instance**. Running N instances gives each client up to N times the limit, and a restart resets all counters. Memory is bounded (10,000 tracked clients, idle entries dropped first). It stops casual abuse and accidental floods, not a distributed attack; put the platform's own edge limits in front for that. Run one instance until a shared limiter exists.

## Resources

Measured on Linux in the production container (see [free-hosting.md](free-hosting.md) for method, numbers and caveats):

| Part | Measured peak (resident) |
|---|---|
| Inspection worker | 69 MiB typical, 133 MiB for the heaviest accepted drawing (271 MiB virtual) |
| FastAPI process | 85 MiB, up to 188 MiB while three 10 MiB uploads are held |
| Next.js (`--max-old-space-size=192`) | 130 to 175 MiB |
| Fork server (workers are forked from it) | 70 MiB |
| Whole container | 340 MiB peak at 512 MiB, no OOM kills; 360 MiB at 1.5 GiB |

**512 MiB fits one worker; 1 GiB is comfortable.** Do not raise `BLUEPRINTIQ_MAX_CONCURRENT_JOBS` without adding about 150 MiB per worker. CPU matters more than memory on a small share: at 0.1 CPU a typical drawing takes 0.5 to 5 s and the heaviest accepted drawing 11 to 13 s against the 30 s job limit. `BLUEPRINTIQ_WORKER_START_METHOD` defaults to `forkserver` in the container (workers are still one new process per job); `spawn` costs about 1 CPU-second per job, which is 10 s at a 10% share. The 1 GiB worker address-space limit was not lowered, and a hostile PDF aimed at memory was not tested.

Overload is graceful: excess requests receive `429` (per client) or `503 SERVER_BUSY` (global), never a hang.

## Free hosting constraint

The project budget is **$0**: no paid host and no billing account. Render's free web service offers 512 MB of RAM and 0.1 CPU. Launch-3 measured the container at exactly those limits on Linux: it fits in memory and finishes tested work, slowly ([free-hosting.md](free-hosting.md)). **Compatibility with Render Free is still not claimed**: nothing has run on Render itself, and its sign-up and Docker-on-Free details are unconfirmed. Do not lower the worker memory limit or other security limits to make a smaller host work without further measurements.

## Validation

`.github/workflows/container-ci.yml` builds the image on every relevant change and checks: non-root user, no PDFs (other than the two original samples) or secrets in the image, startup refusal without allowed hosts, read-only start with a memory cap and platform `PORT`, backend unreachable from outside, the Docker health check, `deploy/smoke.sh` (production `Host` header, spoofed origin, bad uploads, rate limit, security headers, hidden diagnostics), and a clean `docker stop`. Docker was not available on the machine where this was written, so these steps ran only in CI.

## Release blockers

1. **Public source URL (AGPL section 13).** The repository is private. A public deployment needs a public, anonymously readable repository (or equivalent source archive) of the exact version it runs, passed as `SOURCE_URL`. Making the repository public is a separate decision (check history for secrets and personal data first). A private repository does not satisfy the licence.
2. **Host and TLS.** No host is chosen. TLS and the public host name come from the platform; set `BLUEPRINTIQ_ALLOWED_HOSTS` and the proxy hop count to match it, and test the real `X-Forwarded-For` behaviour there.
3. **Real-host check:** the Linux measurements were taken on a CI runner with Render-sized limits; confirm start-up, one real upload and the sign-up flow on the chosen host.
4. **First container build in CI** (the CI job above) must pass; base images are now pinned by digest (`deploy/refresh-digests.sh` prints the current ones to paste in; a pinned digest gets no base-image security updates until it is refreshed, so refresh and re-run CI before each release).
5. No authentication, abuse reporting or privacy notice exists; decide whether the anonymous-upload site needs them before launch.
6. **Source URL verification stays a launch requirement:** run `node deploy/verify-source-url.mjs <url> --online` against the exact `SOURCE_URL` before any public launch; it must pass.
7. **Render itself has not been tested.** The 512 MiB / 0.1 CPU numbers come from a simulated limit on a CI runner. Compatibility with Render Free is not claimed.
8. **Hostile PDFs aimed at memory: partly addressed.** Launch-4A added a container-aware private-memory cap and an out-of-memory priority for workers and showed, with a generic memory-hungry job at 512 MiB, that the service stays up and answers a controlled `resource_limit` ([free-hosting.md](free-hosting.md)). Still untested: what particular malformed or adversarial PDFs do inside the PDF engine. Test with the cap in place before public anonymous uploads.
9. **Fork-server failure and cleanup: tested, with gaps.** Killed and hung fork servers, repeated worker kills, client disconnects, shutdown and a killed API process are covered (Linux CI and the `resilience` workflow). Not covered: a fork server that dies in the middle of starting a worker under load, and long-running leak checks.
10. **Budget:** the project budget is strictly $0 and no billing details will be entered; any host that asks for a card is out.

## Dependency maintenance

`npm audit` (all dependencies) reports 5 high-severity findings, all through `braces` 3.0.3 (GHSA-vfj7-8cjw-p6xm, stack exhaustion on deeply nested patterns) via `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch`. It is a development-only chain (lint tooling); `npm audit --omit=dev` reports 0 vulnerabilities and the image prunes dev dependencies. Recorded 2026-10-14 for dependency maintenance: update `eslint-config-next` when a release resolves it, rather than using `npm audit fix --force`.
