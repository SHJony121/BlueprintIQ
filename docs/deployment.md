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
* Python dependencies are installed from `backend/uv.lock` with `pip --require-hashes`; Node dependencies with `npm ci`. Base images are pinned by tag only; pin them by digest when the release image is built.
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

The backend runs one inspection at a time. Plan for, per instance:

| Part | Budget |
|---|---|
| Inspection worker | up to `BLUEPRINTIQ_JOB_MEMORY_LIMIT_MB` (1 GiB address space) |
| FastAPI process | ~0.1 GiB |
| Next.js | ~0.25 GiB (`--max-old-space-size=192`) |

**Start at 1.5 GiB of memory and one worker.** A 512 MB host does **not** fit one 1 GiB worker; do not run it there, and do not raise `BLUEPRINTIQ_MAX_CONCURRENT_JOBS` without adding about 1 GiB per worker. Actual worker memory on Linux for realistic drawings has not been measured (the address-space limit is an upper bound, not typical use); measure it on the target host before choosing a plan.

Overload is graceful: excess requests receive `429` (per client) or `503 SERVER_BUSY` (global), never a hang.

## Free hosting constraint

The project budget is **$0**: no paid host and no billing account. Render's free web service offers only 512 MB of RAM and 0.1 CPU, which is below the tested configuration (about 1.5 GiB, one 1 GiB-capped worker). **Compatibility with Render Free (or any 512 MB host) is not claimed** and will not be until Linux resource measurements of real inspections show the worker fits. Do not lower the worker memory limit or other security limits to make a smaller host work without those measurements.

## Validation

`.github/workflows/container-ci.yml` builds the image on every relevant change and checks: non-root user, no PDFs (other than the two original samples) or secrets in the image, startup refusal without allowed hosts, read-only start with a memory cap and platform `PORT`, backend unreachable from outside, the Docker health check, `deploy/smoke.sh` (production `Host` header, spoofed origin, bad uploads, rate limit, security headers, hidden diagnostics), and a clean `docker stop`. Docker was not available on the machine where this was written, so these steps ran only in CI.

## Release blockers

1. **Public source URL (AGPL section 13).** The repository is private. A public deployment needs a public, anonymously readable repository (or equivalent source archive) of the exact version it runs, passed as `SOURCE_URL`. Making the repository public is a separate decision (check history for secrets and personal data first). A private repository does not satisfy the licence.
2. **Host and TLS.** No host is chosen. TLS and the public host name come from the platform; set `BLUEPRINTIQ_ALLOWED_HOSTS` and the proxy hop count to match it, and test the real `X-Forwarded-For` behaviour there.
3. **Worker memory on Linux** must be measured on the real host.
4. **First container build in CI** (the CI job above) must pass; image digests should be pinned for the release.
5. No authentication, abuse reporting or privacy notice exists; decide whether the anonymous-upload site needs them before launch.
6. **Source URL verification stays a launch requirement:** run `node deploy/verify-source-url.mjs <url> --online` against the exact `SOURCE_URL` before any public launch; it must pass.

## Dependency maintenance

`npm audit` (all dependencies) reports 5 high-severity findings, all through `braces` 3.0.3 (GHSA-vfj7-8cjw-p6xm, stack exhaustion on deeply nested patterns) via `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch`. It is a development-only chain (lint tooling); `npm audit --omit=dev` reports 0 vulnerabilities and the image prunes dev dependencies. Recorded 2026-10-14 for dependency maintenance: update `eslint-config-next` when a release resolves it, rather than using `npm audit fix --force`.
