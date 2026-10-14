"""Run untrusted PDF work in a separate, disposable process with hard limits.

Each job runs in a fresh process. By default it is started with the ``spawn`` method
(identical on Windows and Linux; no state is inherited from the server). On Linux the
``forkserver`` method can be chosen instead (``use_start_method``): each job is still its own
new process, killed when done, but it is forked from a small helper that has already imported
the libraries, which saves most of the per-job start-up CPU. The helper never receives a
drawing, and inherits nothing from the API server. Limits:

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
import logging
import multiprocessing
import os
import signal
import sys
import threading
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass
from multiprocessing.connection import Connection, wait
from typing import Any, Literal

from blueprintiq.ingestion.errors import DocumentRejectedError

_CONTEXT: Any = multiprocessing.get_context("spawn")
# Modules the fork server imports once, so that a job does not. They hold no per-request state.
_PRELOAD = ["blueprintiq.api.worker", "blueprintiq.api.jobs"]
_KILL_GRACE_S = 5.0
_MAX_RESULT_BYTES = 64 * 1024 * 1024
_WATCHDOG_EXIT = 70  # exit code when the child's own watchdog fires
_POLL_S = 0.2  # how often a running job looks at its cancel flag
# How long starting a worker may take before the fork server is treated as unavailable. It must
# outlast the fork server's own first start-up (it imports the libraries before it accepts), which
# takes about 20 s on a tenth of a CPU.
_START_TIMEOUT_S = 45.0
_METHOD = "spawn"  # the start method in use ("forkserver" falls back to "spawn" on failure)
_LOG = logging.getLogger("blueprintiq")

Kind = Literal["ok", "rejected", "timeout", "crashed", "resource_limit", "error", "cancelled"]


@dataclass(frozen=True, slots=True)
class JobResult:
    kind: Kind
    value: Any = None  # the job's (JSON-serializable) return value when kind == "ok"
    code: str | None = None  # DocumentRejectedError.code when kind == "rejected"
    message: str | None = None  # user-safe message when kind == "rejected"
    detail: str | None = None  # internal detail for server logs only; never sent to clients
    exitcode: int | None = None  # the worker's exit code once it has ended


def use_start_method(method: str) -> str:
    """Choose how worker processes are started and return the method actually in use.

    ``forkserver`` falls back to ``spawn`` where the platform has none (Windows). Call it
    before the first job: the fork server starts on first use and imports ``_PRELOAD`` then.
    """
    global _CONTEXT, _METHOD
    if method == "forkserver" and "forkserver" in multiprocessing.get_all_start_methods():
        context = multiprocessing.get_context("forkserver")
        context.set_forkserver_preload(_PRELOAD)
        _CONTEXT = context
        from multiprocessing import forkserver  # not importable on Windows

        forkserver.ensure_running()  # import in the background now, not on the first request
        _METHOD = "forkserver"
        return "forkserver"
    _CONTEXT = multiprocessing.get_context("spawn")
    _METHOD = "spawn"
    return "spawn"


def _abandon_fork_server(reason: str) -> None:
    """Stop using the fork server: end it if it is running, and start every later job by spawn.

    A job that could not be started has not run, so it is safe to start it again by spawn.
    """
    if _METHOD == "forkserver":
        _LOG.warning(
            "fork server unavailable, using spawn", extra={"event": "worker", "detail": reason}
        )
        try:
            from multiprocessing import forkserver  # not importable on Windows

            pid = getattr(forkserver._forkserver, "_forkserver_pid", None)
            if isinstance(pid, int) and sys.platform != "win32":
                os.kill(pid, signal.SIGKILL)
        except (ImportError, OSError, AttributeError):
            pass
    use_start_method("spawn")


def _start(process: Any) -> bool:
    """Start ``process``; False if the fork server failed or took too long (_START_TIMEOUT_S)."""
    failure: list[BaseException] = []

    def go() -> None:
        try:
            process.start()
        except BaseException as exc:  # reported to the caller below
            failure.append(exc)

    thread = threading.Thread(target=go, daemon=True, name="worker-start")
    thread.start()
    thread.join(_START_TIMEOUT_S)
    if thread.is_alive() or failure:
        if _METHOD != "forkserver":
            if failure:
                raise failure[0]  # spawn itself failed: not something to paper over
            raise TimeoutError("starting a worker process timed out")
        _abandon_fork_server("start timed out" if thread.is_alive() else type(failure[0]).__name__)
        return False
    return True


def run_job(
    job: Callable[..., Any],
    args: tuple[Any, ...],
    *,
    timeout_s: float,
    memory_limit_mb: int | None,
    data_limit_mb: int | None = None,
    prefer_oom_victim: bool = False,
    cancel: threading.Event | None = None,
) -> JobResult:
    """Run ``job(*args)`` in a new process; never raises for problems inside the job.

    ``job`` must be a module-level function (it is imported again in the child) and
    must return a JSON-serializable value. If ``cancel`` is set while the job runs (the
    client went away), the process is killed at once and the result is ``cancelled``.
    """
    child_args = (job, args, memory_limit_mb, data_limit_mb, prefer_oom_victim, timeout_s)
    receive, send = _CONTEXT.Pipe(duplex=False)
    process = _CONTEXT.Process(target=_child, args=(send, *child_args), daemon=True)
    if not _start(process):
        # The fork server could not start the worker. Nothing has run: start it by spawn.
        receive.close()
        send.close()
        receive, send = _CONTEXT.Pipe(duplex=False)
        process = _CONTEXT.Process(target=_child, args=(send, *child_args), daemon=True)
        process.start()
    send.close()  # only the child writes
    raw: bytes | None = None
    try:
        # Wake on a result, or on the process ending (even if it died before it
        # could close its end of the pipe), or on the deadline.
        deadline = time.monotonic() + timeout_s
        cancelled = False
        while True:
            remaining = deadline - time.monotonic()
            ready = wait([receive, process.sentinel], timeout=max(0.0, min(_POLL_S, remaining)))
            if ready or remaining <= _POLL_S:
                break
            if cancel is not None and cancel.is_set():
                cancelled = True
                break
        if receive in ready or receive.poll(0):
            try:
                raw = receive.recv_bytes(maxlength=_MAX_RESULT_BYTES)
            except (EOFError, OSError):  # exited without a result, or result too large
                raw = None
        if ready:
            process.join(_KILL_GRACE_S)
        timed_out = not ready and not cancelled
    finally:
        receive.close()
        if process.is_alive():
            process.kill()
            process.join(_KILL_GRACE_S)
    if cancelled:
        return JobResult("cancelled", exitcode=process.exitcode)
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
    data_limit_mb: int | None,
    prefer_oom_victim: bool,
    timeout_s: float,
) -> None:
    _start_watchdog(timeout_s)
    try:
        if prefer_oom_victim:
            _prefer_oom_victim()
        if memory_limit_mb is not None or data_limit_mb is not None:
            _limit_memory(memory_limit_mb, data_limit_mb)
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


def _limit_memory(address_space_mb: int | None, data_mb: int | None = None) -> None:
    """Cap the address space (RLIMIT_AS) and, if given, the private writable memory (RLIMIT_DATA).

    The address space counts every mapped library, so it is a loose bound. The data limit counts
    what a job allocates (heap and private mappings), which is what fills a container.
    """
    if sys.platform == "win32":
        return  # not supported on Windows; documented limitation
    import resource

    if address_space_mb is not None:
        limit = address_space_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    if data_mb is not None:
        limit = data_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_DATA, (limit, limit))


def _prefer_oom_victim() -> None:
    """Make the kernel out-of-memory killer choose this worker before any other process.

    Raising a process own oom_score_adj needs no privilege. If memory runs out anyway, the
    disposable worker dies, not the API server, the web server or the supervisor.
    """
    try:
        with open("/proc/self/oom_score_adj", "w") as handle:
            handle.write("1000")
    except OSError:
        pass  # not Linux, or not permitted: the other limits still apply


# Memory kept for everything that is not a worker when the data limit is derived from the
# container limit: measured peaks of the API server, web server, fork server and held upload
# bodies came to about 270 MiB (docs/free-hosting.md).
_RESERVE_MB = 300
_MIN_DATA_MB = 192


def cgroup_memory_limit_mb() -> int | None:
    """The container memory limit in MiB (cgroup v2), or None if there is none."""
    try:
        with open("/sys/fs/cgroup/memory.max") as handle:
            text = handle.read().strip()
    except OSError:
        return None
    return int(text) // (1024 * 1024) if text.isdigit() else None


def resolve_data_limit_mb(configured: int | None, address_space_mb: int | None) -> int | None:
    """The worker private-memory cap: as configured (0 = none), or derived from the container.

    Derived: the container limit less the memory kept for the rest of the service, never below
    ``_MIN_DATA_MB`` and never above the address-space limit. With no container limit, no cap.
    """
    if configured == 0:
        return None
    if configured is not None:
        return configured
    limit = cgroup_memory_limit_mb()
    if limit is None:
        return None
    derived = max(_MIN_DATA_MB, limit - _RESERVE_MB)
    return min(derived, address_space_mb) if address_space_mb else derived


def memory_limit_supported() -> bool:
    return sys.platform != "win32"
