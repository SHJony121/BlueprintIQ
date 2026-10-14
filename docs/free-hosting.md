# Free hosting: Linux measurements and feasibility (Launch-3)

**Question:** can the production container run on a $0 host such as Render Free (stated as 512 MB RAM and 0.1 CPU)?

**Short answer:** memory fits (peak 340 MiB of 512 MiB, no out-of-memory kills in 55 requests); CPU does not leave room to spare. At 0.1 CPU a typical drawing takes about 0.5 to 5 s, and the heaviest drawing the backend accepts takes 11 to 13 s, inside the 30 s job limit. That needs the fork-server worker start added in this change; with the earlier per-job `spawn` start the same limits gave 8 to 10 s for a small sample and 20 to 23 s for the heaviest drawing. **Nothing was run on Render itself**, and some sign-up and platform facts are unconfirmed (see [Render Free](#render-free)).

## How it was measured

`deploy/bench/benchmark.py` (run by the manual `benchmark` workflow on a GitHub-hosted Ubuntu runner, cgroup v2) starts the production image with `docker run --memory 512m --memory-swap 512m --cpus 0.1` (no swap) and sends real uploads through the real proxy with a production `Host` header. Peaks come from a sampler inside the container (every 50 ms, per process, from `/proc`) and from the cgroup's own counters. Rate limiting is raised so one client can send the workload; every other setting is the container default. The sampler itself costs about 2% of a CPU, so CPU figures are slightly high.

Inputs are all synthetic (`deploy/bench/make_inputs.py`): the two shipped samples; a busy drawing (about 1,800 line runs, 120 circles, 400 notes); a **heavy** drawing near the backend's own complexity limits (7,000 line runs, 4,700 text lines); and valid drawings padded to 10,483,659 and 10,485,707 bytes (**at** the 10 MiB limit). An 11 MiB body checks the refusal. The proprietary SolidWorks drawing was not used.

Profiles: the same image at 2 CPU / 1.5 GiB (reference), 1 CPU / 512 MiB, **0.1 CPU / 512 MiB** (the Render Free-sized limit), and 0.1 CPU / 512 MiB with the old `spawn` start for comparison.

## Results

Memory (MiB, one run each; the workload was 55 requests including 3 concurrent batches and a 24-request soak):

| | idle after start | peak (cgroup) | after the soak | OOM kills |
|---|---|---|---|---|
| 0.1 CPU / 512 MiB, fork server (default now) | 189 | 340 | 281 | 0 |
| 0.1 CPU / 512 MiB, `spawn` | 134 | 323 | 232 | 0 |
| 1 CPU / 512 MiB, fork server | 186 | 342 | 280 | 0 |
| 2 CPU / 1.5 GiB, fork server | 189 | 360 | 302 | 0 |

Per process at the worst moment (three concurrent 10 MiB uploads): backend 188, frontend 157, fork server 70, worker 69 MiB resident. The heaviest drawing's worker reached 133 MiB resident and 271 MiB virtual size. Memory settled after the work: it did not grow across the 24-request soak (281 MiB before and after). About 55 MiB more is resident at idle with the fork server (a process that has imported the libraries), traded for the CPU saved.

CPU and duration at **0.1 CPU / 512 MiB** (seconds per request, three repeats; "503" is the designed answer to a request that waited 15 s for the one worker):

| input | fork server | `spawn` |
|---|---|---|
| sample basic / CAD | 0.4 to 0.6 | 8.1 to 9.9 |
| busy drawing | 2.7 to 4.9 | 10.2 to 11.9 |
| heavy drawing | 11.4 to 13.1 | 20.0 to 22.7 |
| 10 MiB upload | 1.6 to 2.2 | 10.4 to 13.0 |
| 3 at once (heavy) | 12.9, 24.8, one 503 | 22.7, two 503 |
| 3 at once (small sample) | 0.7 to 1.5, all served | 8.9, 17.5, one 503 |
| 11 MiB (refused) | 413 in 0.14 | 413 in 0.1 |

Per request, CPU is roughly 0.07 s for a sample, 0.3 s for the busy drawing and 1.2 s for the heavy one (full-CPU runs: 0.03, 0.2 and 0.9 s of wall time). Start-up of a fresh worker was the cost: about 1 CPU-second per job with `spawn`, which at a 10% share is 10 s.

Cold start (container start to health 200): 19 to 39 s at 0.1 CPU across runs (about 3 s at 1 CPU or more). The fork server adds roughly 15 s at 0.1 CPU, so the entrypoint now waits up to 180 s for the backend instead of 60 s. Idle CPU is about 2.5% of a core.

## What changed, and what did not

* Workers are still one new process per job, killed afterwards, with the same timeout, memory limit and JSON-only results. The container now starts them from a fork server (`BLUEPRINTIQ_WORKER_START_METHOD=forkserver`, falling back to `spawn` where unavailable) instead of `spawn`. The helper only imports libraries; it never receives a drawing. The worker tests run under both methods in Linux CI. The setting's default outside the container stays `spawn`.
* Not changed: the 10 MiB limit, validation, Host/Origin checks, rate limiting, admission control, the 30 s job limit, or the 1 GiB worker address-space limit.
* The worker limit was **not** lowered. The heaviest accepted drawing needs 271 MiB of address space, so 1 GiB is generous, but a hostile PDF that drives a worker towards that limit could exhaust the 512 MiB container before the limit applies. That case was **not tested**; the kernel would be expected to stop the largest process (the worker), but this is not shown.

## Not tested

Real Render behaviour (CPU burst policy, cold-start timing, port detection, restarts); real industrial drawings (only synthetic inputs); a hostile PDF aimed at memory; long soaks beyond 24 requests; more than three concurrent clients; Windows (no memory limit there).

## Render Free

Checked against Render's documentation and search results (October 2026); verify before relying on it.

* **Specs:** the Free web service is listed as 512 MB RAM and 0.1 CPU. Measured above.
* **Idle behaviour:** spins down after 15 minutes without requests; spin-up takes "about one minute" per Render, plus this container's own 20 to 40 s. A first visitor can wait one to two minutes.
* **Hours:** 750 free instance hours per workspace each month; when exhausted, Free services are suspended until the next month. Outbound bandwidth is limited; the included amount was not stated, and without a payment method services are suspended rather than billed.
* **Restrictions:** single instance, ephemeral filesystem (fine here), may be restarted at any time, may be suspended for unusually high traffic, "not intended for production use".
* **Docker:** Render says it fully supports Docker deploys. Its pages did not state that this applies to the Free instance type; not confirmed.
* **Request timeout and body limits:** not found in Render's documentation (a staff forum reply mentions 100 minutes; not authoritative). The app's own limits are far shorter.
* **Billing details:** Render states no credit card is required for the Free tier, but a community thread reports a card being requested as an anti-abuse step. Unresolved until a real sign-up.

**Verdict:** *plausible but unproven.* The memory and CPU measurements support running it there, and all tested single-user work finishes; but simultaneous visitors queue behind one worker and may see 503s, first requests after idle are slow, and the CPU limit on Render itself was not measured. Do not claim compatibility until a trial deployment (which needs your approval) confirms start-up, a real upload and the sign-up flow.

## Other $0 options (unverified; check each provider's current page)

* **Koyeb free instance:** documented as 512 MB RAM, 0.1 vCPU, 2 GB disk, one per organisation, scales to zero after about an hour; whether a card is needed is reported inconsistently. Same size as Render, so the same measurements apply.
* **Hugging Face Spaces:** the free "CPU Basic" hardware is 2 vCPU and 16 GB, which would fit comfortably, **but** its current documentation says Docker Spaces require a paid plan to create (and sleep when idle), so it does not meet the $0 constraint as documented.
* **Oracle Cloud Always Free and Google Cloud Run:** generous free allowances, but both require a billing account or card at sign-up, which rules them out under your constraint.
* **SnapDeploy (third party):** reported to offer 512 MB containers without a card and 100 container-hours a month; not checked against its own documentation.

## Still required before any public launch

A public source URL for the AGPL source offer, a chosen host, and a trial deployment. See [deployment.md](deployment.md).
