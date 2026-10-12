"""Process isolation: results, rejections, crashes, timeouts and memory limits."""

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from blueprintiq.api.worker import memory_limit_supported, run_job
from tests.api import child_import_fails, jobs

BACKEND = Path(__file__).resolve().parents[2]


def test_successful_job_returns_its_value() -> None:
    result = run_job(jobs.echo, ({"a": 1},), timeout_s=30, memory_limit_mb=None)
    assert (result.kind, result.value) == ("ok", {"a": 1})
    assert result.exitcode == 0


def test_document_rejection_keeps_its_code_and_safe_message() -> None:
    result = run_job(jobs.reject, (), timeout_s=30, memory_limit_mb=None)
    assert (result.kind, result.code) == ("rejected", "INVALID_PDF")
    assert result.message == "The file could not be read as a PDF."


def test_unexpected_exception_is_reported_with_detail_for_logs_only() -> None:
    result = run_job(jobs.fail_with_secret, (), timeout_s=30, memory_limit_mb=None)
    assert result.kind == "error"
    assert result.detail is not None and "RuntimeError" in result.detail
    assert "secret detail" not in result.detail and "someone" not in result.detail
    assert result.message is None  # nothing user-facing carries the detail


def test_crashing_worker_is_reported_not_raised() -> None:
    result = run_job(jobs.hard_exit, (3,), timeout_s=30, memory_limit_mb=None)
    assert result.kind == "crashed"
    assert result.exitcode == 3


def test_timeout_terminates_the_worker_and_it_has_exited() -> None:
    started = time.perf_counter()
    result = run_job(jobs.sleep_forever, (60,), timeout_s=3, memory_limit_mb=None)
    elapsed = time.perf_counter() - started
    assert result.kind == "timeout"
    assert result.exitcode is not None  # the process has ended (killed)
    assert result.exitcode != 0
    assert elapsed < 15  # did not wait for the 60 s job


@pytest.mark.skipif(not memory_limit_supported(), reason="no memory limit on Windows")
def test_memory_limit_stops_a_runaway_allocation() -> None:
    result = run_job(jobs.allocate, (2048,), timeout_s=30, memory_limit_mb=512)
    assert result.kind in ("resource_limit", "crashed")
    assert result.kind != "ok"


@pytest.mark.skipif(not memory_limit_supported(), reason="no memory limit on Windows")
def test_memory_limit_allows_normal_work() -> None:
    result = run_job(jobs.allocate, (50,), timeout_s=30, memory_limit_mb=512)
    assert (result.kind, result.value) == ("ok", 50 * 1024 * 1024)


def test_memory_limit_support_matches_platform() -> None:
    assert memory_limit_supported() is (sys.platform != "win32")


def test_child_watchdog_ends_a_worker_whose_parent_has_gone(tmp_path: Path) -> None:
    """Start a throwaway parent that starts a worker, kill the parent, the worker must exit."""
    pid_file = tmp_path / "worker.pid"
    script = (
        f"import sys; sys.path.insert(0, {str(BACKEND)!r})\n"
        "from blueprintiq.api.worker import run_job\n"
        "from tests.api import jobs\n"
        "if __name__ == '__main__':\n"
        f"    run_job(jobs.report_parent_and_sleep, ({str(pid_file)!r}, 120),\n"
        "            timeout_s=120, memory_limit_mb=None)\n"
    )
    runner = tmp_path / "runner.py"
    runner.write_text(script, encoding="utf-8")
    parent = subprocess.Popen([sys.executable, str(runner)], cwd=BACKEND)
    try:
        deadline = time.monotonic() + 30
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.2)
        assert pid_file.exists(), "worker never started"
        worker_pid = int(pid_file.read_text(encoding="utf-8"))
    finally:
        parent.kill()  # hard kill: no atexit cleanup in the parent
        parent.wait()
    deadline = time.monotonic() + 15
    while _alive(worker_pid) and time.monotonic() < deadline:
        time.sleep(0.25)
    assert not _alive(worker_pid), "worker outlived its killed parent"


def test_startup_failure_in_the_child_is_a_crash_not_a_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BLUEPRINTIQ_TEST_FAIL_WORKER_IMPORT", "1")
    started = time.perf_counter()
    result = run_job(child_import_fails.job, (), timeout_s=60, memory_limit_mb=None)
    assert result.kind == "crashed"
    assert time.perf_counter() - started < 20


def test_non_json_result_is_an_error_not_a_crash_of_the_server() -> None:
    result = run_job(jobs.echo, ({1, 2},), timeout_s=30, memory_limit_mb=None)  # a set
    assert result.kind == "error"


def _alive(pid: int) -> bool:
    if sys.platform == "win32":
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True
        ).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie still answers kill(0); check its state.
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
            return handle.read().split()[2] != "Z"
    except OSError:
        return False
