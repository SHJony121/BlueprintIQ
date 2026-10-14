# Render Free: configuration for a controlled trial

**Status: prepared, not deployed.** Nothing here has run on Render. The container was measured at Render-sized limits (512 MiB, 0.1 CPU) on a CI runner ([free-hosting.md](free-hosting.md)); Render's real CPU policy, start-up and proxy behaviour may differ. Items marked **verify in the trial** are not established by Render's documentation as read in October 2026. No payment method is needed or should be entered; if Render asks for one during sign-up or service creation, stop (the project budget is $0).

Do not start the trial until the AGPL source URL is public and verified ([source-release-checklist.md](source-release-checklist.md)).

## Service settings

| Setting | Value |
|---|---|
| Service type | Web Service |
| Runtime / language | Docker (the repository `Dockerfile`, root context) |
| Instance type | Free |
| Region | any |
| Auto-deploy | **Off** for the trial (Render also offers "After CI Checks Pass"); deploy a chosen commit by hand |
| Health check path | `/api/health` (set under Settings, Health Checks) |
| Start command | none (the image's `ENTRYPOINT` starts both processes) |

Render documents that a web service must bind `0.0.0.0` on `PORT` (default 10000). The container reads `PORT` and binds the public port there; the backend stays on `127.0.0.1:8001` inside the container.

**Health check:** Render treats a 2xx or 3xx answer as healthy, fails a check after 5 s, stops routing after 15 s of failures and restarts after 60 s; a new deploy that is not healthy within 15 minutes is cancelled and the old one keeps serving. `/api/health` answers 200 only when the backend answers, and never touches a drawing. **Verify in the trial:** whether Free instances use the path, and how long Render waits for the port to open (not stated).

## Environment variables

Set in the service's Environment page. None is a secret.

| Variable | Value | Why |
|---|---|---|
| `BLUEPRINTIQ_ALLOWED_HOSTS` | the exact host, for example `blueprintiq-xxxx.onrender.com` (no scheme, no port) | Required; the container refuses to start without it. Render serves each service on its own `onrender.com` host, terminates TLS and redirects HTTP to HTTPS. Add a custom domain here too if one is attached. |
| `BLUEPRINTIQ_TRUSTED_PROXY_HOPS` | `1` | Render's proxy sits in front. The client address is taken as the last `X-Forwarded-For` entry (the one the proxy added); earlier entries, which a visitor can forge, are ignored. Community reports say Render appends to a client-supplied header rather than replacing it, which is why the last entry is used, not the first. **Verify in the trial** that the rate limit separates two clients and cannot be dodged with a forged header. If it cannot be established, set `0` (everyone shares one strict bucket) rather than trust it. |
| `BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE` / `BLUEPRINTIQ_RATE_LIMIT_BURST` | defaults `10` / `5` | Per client, in memory (one instance, so no multiplication). |
| `BLUEPRINTIQ_MAX_UPLOADS_PER_CLIENT` | default `2` | |
| `BLUEPRINTIQ_MAX_CONCURRENT_JOBS` | default `1` | One worker: 512 MiB does not fit more. |
| `BLUEPRINTIQ_JOB_TIMEOUT_S` | default `30` | The heaviest accepted drawing measured 11 to 13 s at 0.1 CPU. |
| `NEXT_PUBLIC_SOURCE_URL` | the public source address | See below. |

Everything else keeps its default: worker start method `forkserver`, worker memory cap derived from the container limit, 10 MiB upload limit.

**Source URL and build arguments.** The image build needs `SOURCE_URL` (an https address) and refuses to continue without it; the value is baked into the footer link at build time. Render's Dockerfile builds can use service environment variables as build arguments, but Render's pages I read did not confirm this. **Verify in the trial:** set `SOURCE_URL` as an environment variable and check that the build passes and the footer shows the link. If it does not pass, change the Dockerfile default `ARG` in a reviewed commit rather than weakening the check. `SITE_URL` (optional, same mechanism) gives the social-preview image an absolute address.

## What to expect

* **Idle:** a Free service spins down after 15 minutes without requests and takes "about one minute" to start again (Render). The container then needs roughly 20 to 40 s of its own start-up at 0.1 CPU (measured). A first visitor after idle can wait one to two minutes.
* **Hours:** 750 free instance hours per workspace per month; when used up, Free services are suspended until the next month. Free bandwidth is limited and without a payment method services are suspended rather than billed.
* **Work:** a typical drawing takes 0.5 to 5 s, the heaviest accepted drawing 11 to 13 s. Simultaneous visitors queue behind one worker; a request that waits 15 s gets a 503 "busy" answer. Memory peaks near 340 MiB of 512.
* **Restarts:** Render may restart a Free instance at any time and its filesystem is ephemeral; the app keeps nothing.

## Trial checklist (verify, do not assume)

1. Sign-up and service creation completed with **no** payment method requested.
2. Build passes with `SOURCE_URL` supplied as an environment variable; footer source link correct.
3. Service reaches healthy; note the time from deploy to healthy and from spin-down to first response.
4. Upload both samples through the public address. Host/Origin accepted on the `onrender.com` host; an upload with a wrong `Host` header refused.
5. Rate limit: repeated uploads from one client give 429 with `Retry-After`; a second client is unaffected; a forged `X-Forwarded-For` prefix does not help.
6. A 10 MiB upload and an 11 MiB upload (the latter refused with 413).
7. Memory and restarts in Render's metrics during a few uploads; any unexpected restart means stop.
8. Security headers present on pages and `no-store` on inspection responses (browser developer tools).
9. `/docs`, `/openapi.json`, `/pdfjs-check` and `/viewer-check` answer 404.

## Rollback and troubleshooting

* **Roll back:** Render's Manual Deploy menu offers "Deploy a specific commit" (it turns auto-deploy off). Render also has a Rollbacks feature that its pages describe separately; its limits for Free services were not read. To stop serving at once, suspend the service in the dashboard.
* **Container exits at start with code 2:** the log names the invalid setting; the usual cause is a missing or malformed `BLUEPRINTIQ_ALLOWED_HOSTS`.
* **Deploy never becomes healthy:** check the log for "the backend did not start in time" (the entrypoint waits up to 180 s) and for out-of-memory restarts; compare with `docs/free-hosting.md`.
* **Every upload gets 403:** the `Host` is not in `BLUEPRINTIQ_ALLOWED_HOSTS` (include the exact service host, with no port).
* **Every upload gets 429:** all visitors share one bucket because the client address could not be read; recheck `BLUEPRINTIQ_TRUSTED_PROXY_HOPS`.
* **Uploads fail with 503 under load:** one worker and a small CPU share; expected under simultaneous use.
* **Restarts after memory growth:** capture the time and the upload involved; do not raise limits to hide it.
