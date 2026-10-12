# Security and deployment restrictions

**BlueprintIQ (the Phase 1 backend and the Phase 2A local frontend) is for trusted local use only. Public deployment is BLOCKED.**

## What is implemented (and tested)

* **Upload limits:** raw body streamed and counted; refused beyond 10 MiB without buffering the rest; `Content-Length` never trusted; MIME type checked but the `%PDF-` signature and all PDF validation still run; nothing written to disk; no multipart parsing.
* **Admission control:** a limited number of requests are admitted at once, counted before the body is read (`503 SERVER_BUSY`); the whole upload must arrive within a deadline (`408 UPLOAD_TIMEOUT`).
* **Process isolation:** each inspection runs in a fresh `spawn` worker process with a wall-clock timeout (the process is killed and verified to have exited), a watchdog inside the worker (deadline, parent death), and JSON-only results. A worker crash or hang does not stop the server. Tested on Windows and Linux.
* **Memory limit:** enforced with `RLIMIT_AS` on **Linux only**; tested in Linux CI.
* **Complexity limits:** decoded page content (including nested Form XObjects, weighted by invocation count) ≤ 2 MiB, characters ≤ 100,000, text lines ≤ 5,000, forms nested ≤ 8, pages ≤ 1.
* **Errors:** one envelope for every error; generic messages; no stack traces, paths, library text or PDF contents in responses; MuPDF's own stderr output disabled.
* **Logging:** JSON lines with request id, status, duration, upload size, SHA-256 prefix and outcome counts; never drawing text, file names (sent in a header, not the URL) or upload bytes; exceptions logged by type only.
* **Configuration:** the ruleset is validated at startup; an invalid file stops the server.

## Not implemented — release blockers

| Gap | Consequence |
|---|---|
| **Windows has no memory limit** | On Windows only the timeout bounds a worker. |
| **No authentication or authorization** | Anyone who can reach the port can use it. |
| **No rate limiting** | Admission control caps concurrency, not request rate. |
| **No TLS / CORS configuration** | Needs a reverse proxy and a decision in the frontend phase. |
| **No cancellation on client disconnect** | A running inspection continues until it finishes or times out. |
| **Slow-connection and malformed-HTTP handling** | Left to uvicorn / a reverse proxy; malformed HTTP is answered outside the error envelope. |
| **Per-request process cost (~1.2 s on Windows)** | A warm worker pool would help but weakens per-request isolation. |
| **Real industrial CAD PDFs not benchmarked** | Behaviour on real files is unknown. |
| **Parser/PDF attack surface in MuPDF** | Mitigated by isolation and limits, not eliminated; keep PyMuPDF updated. |

## Frontend proxy (Phase 2A, F1)

The Next.js app forwards uploads to the backend through one server-side route, `POST /api/inspections`. It binds to `127.0.0.1`, refuses foreign `Host`/`Origin` headers, forwards only an allow-listed set of headers to a fixed loopback backend address, counts upload bytes against the 10 MiB limit, caps and validates backend responses, and aborts the backend request when the browser disconnects. That abort **does not cancel backend processing** (see the table above). Loopback binding comes only from the launch scripts (`npm run dev` and `npm run start`, both `--hostname 127.0.0.1`), which tests verify; the `Host` and `Origin` checks do not replace it, and public deployment stays blocked. The proxy adds **no** authentication, rate limiting or TLS and is **not** production-secure. Details: [frontend-f1.md](frontend-f1.md).

## Licensing

* **PyMuPDF is licensed AGPL-3.0 (or a commercial licence).** The decision for a public release is **unresolved**: publish under AGPL-3.0, obtain a commercial licence, or replace the engine with a permissively licensed one such as pypdfium2 (it would need its own line-grouping and coordinate conversion; PyMuPDF use is confined to `ingestion/pdf_loader.py` and `extraction/text_layer.py`). See [design/adr-001-pdf-engine.md](design/adr-001-pdf-engine.md).
* The repository currently has **no licence**: all rights reserved, and it is **private**.

## Safe local use

Run the server on `127.0.0.1` only (the default in the README commands). Do not expose the port. Do not upload confidential drawings to a shared machine without understanding that uploads are processed in memory and in worker processes, and that logs contain sizes and hash prefixes but no drawing text.
