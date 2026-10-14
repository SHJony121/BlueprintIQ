"""BlueprintIQ HTTP API (layer G).

Run: ``uvicorn blueprintiq.api.app:create_app --factory``

Upload protocol: the PDF is the raw request body with ``Content-Type:
application/pdf`` (not multipart). The body is read as a stream and counted, and
the request is refused with 413 as soon as it exceeds the limit, so an oversized
upload is never buffered in full and nothing is written to disk. The optional
original file name is sent in the ``X-Filename`` header, percent-encoded UTF-8
(a header, not a query parameter, so it never appears in access logs; it is
only echoed in the report, never used to open files). A browser sends a ``File``
directly: ``fetch(url, {method: "POST", body: file, headers: {"Content-Type":
"application/pdf"}})``.

Admission: at most ``max_admitted_requests`` requests are accepted at once
(uploading, waiting or running), and the whole body must arrive within
``upload_timeout_s``; otherwise 503 / 408. This bounds memory held by uploads and
stops slow-upload attacks from tying up the server.

Each inspection runs in a separate worker process with a wall-clock timeout (and a
memory limit on Linux); see ``api.worker``. The API is stateless.
"""

import hashlib
import logging
import threading
import time
import uuid
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from typing import Any
from urllib.parse import unquote

import anyio
from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import ClientDisconnect

from blueprintiq import __version__
from blueprintiq.api.errors import REJECTION_STATUS, ApiError, ErrorResponse, error_response
from blueprintiq.api.jobs import inspection_job
from blueprintiq.api.logging_setup import configure_logging
from blueprintiq.api.settings import Settings
from blueprintiq.api.worker import JobResult, run_job
from blueprintiq.domain.models import InspectionReport
from blueprintiq.ingestion.limits import MIB, IngestionLimits
from blueprintiq.rules.config import Ruleset, load_ruleset
from blueprintiq.rules.requirements import (
    MAX_HEADER_CHARS,
    RequirementsError,
    parse_requirements,
)

Job = Callable[..., Any]
_MAX_FILENAME = 255

_ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorResponse, "description": text}
    for status, text in [
        (400, "Upload interrupted by the client (CLIENT_DISCONNECTED)"),
        (408, "Upload not received in time (UPLOAD_TIMEOUT)"),
        (413, "Upload larger than the limit (FILE_TOO_LARGE)"),
        (415, "Not sent as application/pdf (UNSUPPORTED_CONTENT_TYPE), or not a PDF "
              "(UNSUPPORTED_FILE_TYPE)"),
        (422, "PDF refused or could not be processed within limits (see error.code)"),
        (500, "Unexpected server error (INTERNAL_ERROR)"),
        (503, "Too many requests in progress (SERVER_BUSY)"),
    ]
}  # fmt: skip


def create_app(settings: Settings | None = None, *, job: Job = inspection_job) -> FastAPI:
    """Build the app. Loads and validates the ruleset now: an invalid one stops startup."""
    settings = settings or Settings()
    logger = configure_logging(settings.log_level)
    ruleset = load_ruleset(settings.ruleset_path)  # raises RulesetConfigError
    limits = IngestionLimits(max_bytes=settings.max_upload_bytes)
    # A thread semaphore (not asyncio's) so the limit holds whatever event loop runs
    # the request; it is taken inside the worker thread, with a bounded wait.
    workers = threading.BoundedSemaphore(settings.max_concurrent_jobs)
    admission = _Admission(settings.max_admitted_requests)
    logger.info(
        "ruleset loaded",
        extra={"event": "startup", "detail": f"{ruleset.ruleset.id} {ruleset.ruleset.version}"},
    )  # fmt: skip

    documented = settings.environment != "production"
    app = FastAPI(
        title="BlueprintIQ",
        version=__version__,
        docs_url="/docs" if documented else None,
        redoc_url="/redoc" if documented else None,
        openapi_url="/openapi.json" if documented else None,
        description="Assistive engineering-drawing inspection prototype. Not certified "
        "compliance software; findings must be reviewed by a qualified person.",
    )

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request.state.request_id = uuid.uuid4().hex  # never taken from the client
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception as exc:  # last line of defence: never let a traceback out
            logger.error(
                "unhandled error",
                exc_info=exc,
                extra={"event": "error", "request_id": request.state.request_id},
            )
            response = error_response(
                request, 500, "INTERNAL_ERROR", "An unexpected error occurred."
            )
        response.headers["X-Request-ID"] = request.state.request_id
        logger.info(
            "request",
            extra={
                "event": "request",
                "request_id": request.state.request_id,
                "status": response.status_code,
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
            },
        )
        return response

    @app.exception_handler(ApiError)
    async def api_error(request: Request, exc: ApiError) -> Response:
        return error_response(request, exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> Response:
        return error_response(
            request, 422, "REQUEST_VALIDATION_ERROR", "The request parameters are invalid."
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> Response:
        codes = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}
        return error_response(
            request,
            exc.status_code,
            codes.get(exc.status_code, "HTTP_ERROR"),
            "Request not handled.",
        )

    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception) -> Response:
        logger.error(
            "unhandled error",
            exc_info=exc,
            extra={"event": "error", "request_id": getattr(request.state, "request_id", "")},
        )
        return error_response(request, 500, "INTERNAL_ERROR", "An unexpected error occurred.")

    @app.get("/healthz", summary="Liveness check")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post(
        "/api/v1/inspections",
        response_model=InspectionReport,
        responses=_ERRORS,
        summary="Inspect one PDF drawing",
        openapi_extra={
            "parameters": [
                {
                    "name": "X-Inspection-Requirements",
                    "in": "header",
                    "required": False,
                    "description": "Optional per-request requirements: percent-encoded JSON "
                    "(version 1; min_thickness_mm, max_diameter_mm, min_length_mm, max_length_mm, "
                    "material). Without it the server's demonstration ruleset is used.",
                    "schema": {"type": "string", "maxLength": MAX_HEADER_CHARS},
                }
            ],
            "requestBody": {
                "required": True,
                "content": {"application/pdf": {"schema": {"type": "string", "format": "binary"}}},
            },
        },
    )
    async def inspect(request: Request) -> Response:
        content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if content_type != "application/pdf":
            raise ApiError(
                415,
                "UNSUPPORTED_CONTENT_TYPE",
                "Send the PDF as the request body with Content-Type: application/pdf.",
            )
        filename = _filename(request)
        with admission.slot():
            try:
                with anyio.fail_after(settings.upload_timeout_s):
                    data = await _read_body(request, settings.max_upload_bytes)
            except TimeoutError:
                raise ApiError(
                    408, "UPLOAD_TIMEOUT", "The upload was not received in time."
                ) from None
            except ClientDisconnect:
                logger.info(
                    "client disconnected",
                    extra={"event": "client_disconnect", "request_id": request.state.request_id},
                )
                raise ApiError(400, "CLIENT_DISCONNECTED", "The upload was interrupted.") from None
            # After the body is read, so a refusal never answers while the client is still
            # sending (which can reset its connection before it reads the reply).
            rules = _requirements(request, ruleset)
            return await _inspect(request, data, filename, rules)

    async def _inspect(
        request: Request, data: bytes, filename: str | None, rules: Ruleset
    ) -> Response:

        gone = threading.Event()  # set when the client disconnects: stop work nobody awaits

        def run_when_a_worker_is_free() -> JobResult | None:
            waited = 0.0
            while not workers.acquire(timeout=0.2):
                waited += 0.2
                if gone.is_set() or waited >= settings.queue_timeout_s:
                    return None
            try:
                return run_job(
                    job,
                    (data, rules, filename, limits),
                    timeout_s=settings.job_timeout_s,
                    memory_limit_mb=settings.job_memory_limit_mb,
                    cancel=gone,
                )
            finally:
                workers.release()

        async def watch_for_disconnect() -> None:
            # A blocking receive: the body is already read, so the only message left is the
            # disconnect. (Polling with is_disconnected() never sees it through the
            # BaseHTTPMiddleware that adds the request id.) Cancelled when the job ends.
            while True:
                message = await request.receive()
                if message["type"] == "http.disconnect":
                    gone.set()
                    return

        async with anyio.create_task_group() as tasks:
            tasks.start_soon(watch_for_disconnect)
            result = await anyio.to_thread.run_sync(run_when_a_worker_is_free)
            tasks.cancel_scope.cancel()
        if gone.is_set():
            logger.info(
                "client disconnected",
                extra={"event": "client_disconnect", "request_id": request.state.request_id},
            )
            raise ApiError(400, "CLIENT_DISCONNECTED", "The upload was interrupted.")
        if result is None:
            raise ApiError(503, "SERVER_BUSY", "All workers are busy; try again later.")
        return _respond(request, result, data, logger)

    return app


class _Admission:
    """Admit at most ``capacity`` requests at once; refuse the rest immediately."""

    def __init__(self, capacity: int) -> None:
        self._capacity = capacity
        self._active = 0
        self._lock = threading.Lock()

    @contextmanager
    def slot(self) -> Iterator[None]:
        with self._lock:
            if self._active >= self._capacity:
                raise ApiError(
                    503, "SERVER_BUSY", "Too many requests in progress; try again later."
                )
            self._active += 1
        try:
            yield
        finally:
            with self._lock:
                self._active -= 1


def _requirements(request: Request, default: Ruleset) -> Ruleset:
    """The ruleset for this request: the one in the header if present, else the default."""
    raw = request.headers.get("x-inspection-requirements")
    if raw is None:
        return default
    try:
        return parse_requirements(raw)
    except RequirementsError as exc:
        raise ApiError(422, "INVALID_REQUIREMENTS", " ".join(exc.problems)[:480]) from None


def _filename(request: Request) -> str | None:
    raw = request.headers.get("x-filename")
    if raw is None:
        return None
    name = unquote(raw, errors="replace")
    if len(name) > _MAX_FILENAME:
        raise ApiError(422, "REQUEST_VALIDATION_ERROR", "The X-Filename header is too long.")
    return name


async def _read_body(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise _too_large(limit)  # early refusal; the count below is what is trusted
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise _too_large(limit)
        chunks.append(chunk)
    return b"".join(chunks)


def _too_large(limit: int) -> ApiError:
    return ApiError(
        413,
        "FILE_TOO_LARGE",
        f"The upload exceeds the limit of {limit / MIB:g} MiB ({limit} bytes).",
    )


def _respond(request: Request, result: JobResult, data: bytes, logger: logging.Logger) -> Response:
    log: dict[str, Any] = {
        "event": "inspection",
        "request_id": request.state.request_id,
        "size_bytes": len(data),
        "sha256_prefix": hashlib.sha256(data).hexdigest()[:12],
        "result": result.kind,
    }
    if result.kind == "ok":
        try:
            report = InspectionReport.model_validate_json(result.value)  # contract check
        except ValidationError as exc:
            # Never log the error text: it quotes the report (drawing text, file name).
            logger.error(
                "invalid worker report", extra=log | {"detail": f"{exc.error_count()} errors"}
            )
            raise ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred.") from None
        s = report.summary
        counts = {"passed": s.passed, "failed": s.failed, "missing": s.missing,
                  "needs_review": s.needs_review}  # fmt: skip
        logger.info("inspection", extra=log | counts)
        return Response(content=result.value, media_type="application/json")
    logger.info(
        "inspection", extra=log | {"code": result.code, "detail": f"exitcode={result.exitcode}"}
    )
    if result.kind == "rejected":
        assert result.code is not None and result.message is not None
        raise ApiError(REJECTION_STATUS.get(result.code, 422), result.code, result.message)
    if result.kind == "timeout":
        raise ApiError(422, "PROCESSING_TIMEOUT", "The document took too long to process.")
    if result.kind == "resource_limit":
        raise ApiError(
            422, "RESOURCE_LIMIT_EXCEEDED", "The document needs more memory than allowed."
        )
    if result.kind == "crashed":
        raise ApiError(422, "PROCESSING_FAILED", "The document could not be processed.")
    logger.error("worker error", extra=log | {"detail": result.detail})
    raise ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred.")
