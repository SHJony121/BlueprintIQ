"""Run untrusted PDF work in a separate, disposable process with hard limits.

Each job runs in a fresh process started with the ``spawn`` method (identical on
Windows and Linux; no state is inherited from the server). Limits:

* **Timeout, enforced twice.** The parent waits at most ``timeout_s`` and then kills
  the process. The child also runs a watchdog that exits on the same deadline, or
  as soon as the parent process has gone, so a worker cannot outlive a killed
  server.
* **Memory (Linux/macOS only).** The child caps its address space at
  ``memory_limit_mb`` before touching the PDF. Windows has no ``resource`` module,
  so there only the timeout applies.
* **Results are JSON, not pickle.** The child sends ``json`` bytes (size-capped), so
  even a compromised child cannot run code in the server by crafting a result.

A crash, hang or memory blow-up therefore ends one disposable process, never the
API server. Guarantees are tested in tests/api/test_worker.py.
"""

import json
import multiprocessing
import os
import sys
import threading
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass
from multiprocessing.connection import Connection, wait
from typing import Any, Literal

from blueprintiq.ingestion.errors import DocumentRejectedError

_CONTEXT = multiprocessing.get_context("spawn")
_KILL_GRACE_S = 5.0
_MAX_RESULT_BYTES = 64 * 1024 * 1024
_WATCHDOG_EXIT = 70  # exit code when the child's own watchdog fires

Kind = Literal["ok", "rejected", "timeout", "crashed", "resource_limit", "error"]


@dataclass(frozen=True, slots=True)
class JobResult:
    kind: Kind
    value: Any = None  # the job's (JSON-serializable) return value when kind == "ok"
    code: str | None = None  # DocumentRejectedError.code when kind == "rejected"
    message: str | None = None  # user-safe message when kind == "rejected"
    detail: str | None = None  # internal detail for server logs only; never sent to clients
    exitcode: int | None = None  # the worker's exit code once it has ended


def run_job(
    job: Callable[..., Any],
    args: tuple[Any, ...],
    *,
    timeout_s: float,
    memory_limit_mb: int | None,
) -> JobResult:
    """Run ``job(*args)`` in a new process; never raises for problems inside the job.

    ``job`` must be a module-level function (it is imported again in the child) and
    must return a JSON-serializable value.
    """
    receive, send = _CONTEXT.Pipe(duplex=False)
    process = _CONTEXT.Process(
        target=_child, args=(send, job, args, memory_limit_mb, timeout_s), daemon=True
    )
    process.start()
    send.close()  # only the child writes
    raw: bytes | None = None
    try:
        # Wake on a result, or on the process ending (even if it died before it
        # could close its end of the pipe), or on the deadline.
        ready = wait([receive, process.sentinel], timeout=timeout_s)
        if receive in ready or receive.poll(0):
            try:
                raw = receive.recv_bytes(maxlength=_MAX_RESULT_BYTES)
            except (EOFError, OSError):  # exited without a result, or result too large
                raw = None
        if ready:
            process.join(_KILL_GRACE_S)
        timed_out = not ready
    finally:
        receive.close()
        if process.is_alive():
            process.kill()
            process.join(_KILL_GRACE_S)
    if timed_out:
        return JobResult("timeout", exitcode=process.exitcode)
    if raw is None:
        return JobResult("crashed", exitcode=process.exitcode)
    return _decode(raw, process.exitcode)


def _decode(raw: bytes, exitcode: int | None) -> JobResult:
    try:
        outcome = json.loads(raw)
        kind = outcome["kind"]
    except (ValueError, KeyError, TypeError):
        return JobResult("error", detail="malformed worker result", exitcode=exitcode)
    if kind == "ok":
        return JobResult("ok", value=outcome.get("value"), exitcode=exitcode)
    if kind == "rejected":
        return JobResult(
            "rejected",
            code=str(outcome["code"]),
            message=str(outcome["message"]),
            exitcode=exitcode,
        )
    if kind == "resource_limit":
        return JobResult("resource_limit", exitcode=exitcode)
    return JobResult("error", detail=str(outcome.get("detail", "")), exitcode=exitcode)


def _child(
    send: Connection,
    job: Callable[..., Any],
    args: tuple[Any, ...],
    memory_limit_mb: int | None,
    timeout_s: float,
) -> None:
    _start_watchdog(timeout_s)
    try:
        if memory_limit_mb is not None:
            _limit_memory(memory_limit_mb)
        try:
            outcome: dict[str, Any] = {"kind": "ok", "value": job(*args)}
        except DocumentRejectedError as exc:
            outcome = {"kind": "rejected", "code": exc.code, "message": exc.message}
        except MemoryError:
            outcome = {"kind": "resource_limit"}
        except Exception:  # anything else is a server-side error; detail stays in logs
            outcome = {"kind": "error", "detail": _safe_detail()}
        try:
            payload = json.dumps(outcome)
        except (TypeError, ValueError):  # the job returned something JSON cannot carry
            payload = json.dumps({"kind": "error", "detail": "job result is not JSON-serializable"})
        send.send_bytes(payload.encode("utf-8"))
    finally:
        send.close()


def _safe_detail() -> str:
    """Exception type and code locations only: its message may quote a drawing."""
    exc = sys.exc_info()[1]
    frames = traceback.extract_tb(exc.__traceback__)[-5:] if exc else []
    where = " <- ".join(
        f"{os.path.basename(f.filename)}:{f.lineno} {f.name}" for f in reversed(frames)
    )
    return f"{type(exc).__name__} at {where}"


def _start_watchdog(timeout_s: float) -> None:
    """Exit the child at its deadline, or when the parent process has gone."""
    deadline = time.monotonic() + timeout_s
    parent = multiprocessing.parent_process()

    def watch() -> None:
        while True:
            if time.monotonic() >= deadline or (parent is not None and not parent.is_alive()):
                os._exit(_WATCHDOG_EXIT)
            time.sleep(0.5)

    threading.Thread(target=watch, daemon=True, name="deadline-watchdog").start()


def _limit_memory(megabytes: int) -> None:
    if sys.platform == "win32":
        return  # not supported on Windows; documented limitation
    import resource

    limit = megabytes * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


def memory_limit_supported() -> bool:
    return sys.platform != "win32"
