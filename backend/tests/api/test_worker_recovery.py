"""Worker start-up failures, a fork server that dies or hangs, memory caps and clean-up.

The first group does not depend on the start method: a fake fork-server context stands in for
one that fails or hangs, so it runs everywhere. The second group uses a real fork server and
runs on Linux only (the CI platform of the production container).
"""

import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from blueprintiq.api import worker
from blueprintiq.api.worker import (
    resolve_data_limit_mb,
    run_job,
    use_start_method,
)
from tests.api import jobs

BACKEND = Path(__file__).resolve().parents[2]
LINUX = pytest.mark.skipif(sys.platform != "linux", reason="needs Linux (fork server, /proc)")


@pytest.fixture(autouse=True)
def spawn_afterwards() -> Iterator[None]:
    yield
    use_start_method("spawn")


class _FakeProcess:
    def __init__(self, behaviour: str, release: threading.Event) -> None:
        self.behaviour = behaviour
        self.release = release

    def start(self) -> None:
        if self.behaviour == "fail":
            raise OSError("fork server is gone")
        self.release.wait(60)  # "hang": the fork server never answers


class _FakeForkServerContext:
    """What the worker module sees as its context when the fork server misbehaves."""

    def __init__(self, behaviour: str) -> None:
        self.behaviour = behaviour
        self.release = threading.Event()
        self._real = worker.multiprocessing.get_context("spawn")

    def Pipe(self, duplex: bool = True) -> Any:
        return self._real.Pipe(duplex=duplex)

    def Process(self, **kwargs: Any) -> _FakeProcess:
        return _FakeProcess(self.behaviour, self.release)


@pytest.mark.parametrize("behaviour", ["fail", "hang"])
def test_a_fork_server_that_fails_or_hangs_is_replaced_by_spawn(
    monkeypatch: pytest.MonkeyPatch, behaviour: str
) -> None:
    fake = _FakeForkServerContext(behaviour)
    monkeypatch.setattr(worker, "_CONTEXT", fake)
    monkeypatch.setattr(worker, "_METHOD", "forkserver")
    monkeypatch.setattr(worker, "_START_TIMEOUT_S", 0.5)
    started = time.monotonic()
    try:
        result = run_job(jobs.echo, ({"a": 1},), timeout_s=30, memory_limit_mb=None)
    finally:
        fake.release.set()
    assert (result.kind, result.value) == ("ok", {"a": 1})
    assert time.monotonic() - started < 25
    assert worker._METHOD == "spawn"  # later jobs do not try the fork server again
    again = run_job(jobs.echo, (2,), timeout_s=30, memory_limit_mb=None)
    assert again.value == 2


def test_a_spawn_failure_is_not_hidden(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeForkServerContext("fail")
    monkeypatch.setattr(worker, "_CONTEXT", fake)
    monkeypatch.setattr(worker, "_METHOD", "spawn")
    with pytest.raises(OSError):
        run_job(jobs.echo, (1,), timeout_s=30, memory_limit_mb=None)


# ------------------------------------------------------------------ memory caps


@pytest.mark.parametrize(
    ("configured", "address_space", "cgroup", "expected"),
    [
        (0, 1024, 512, None),  # switched off
        (256, 1024, 512, 256),  # as configured
        (None, 1024, 512, 212),  # container limit less the memory kept for the rest
        (None, 1024, 400, 192),  # never below the floor
        (None, 1024, 4096, 1024),  # never above the address-space limit
        (None, 1024, None, None),  # no container limit: no cap
        (None, None, 512, 212),
    ],
)
def test_the_data_limit_is_derived_from_the_container(
    monkeypatch: pytest.MonkeyPatch,
    configured: int | None,
    address_space: int | None,
    cgroup: int | None,
    expected: int | None,
) -> None:
    monkeypatch.setattr(worker, "cgroup_memory_limit_mb", lambda: cgroup)
    assert resolve_data_limit_mb(configured, address_space) == expected


@LINUX
def test_a_private_memory_cap_stops_a_runaway_job_and_allows_normal_work() -> None:
    hog = run_job(jobs.touch, (600,), timeout_s=60, memory_limit_mb=2048, data_limit_mb=300)
    assert hog.kind == "resource_limit"
    normal = run_job(jobs.touch, (40,), timeout_s=60, memory_limit_mb=2048, data_limit_mb=300)
    assert (normal.kind, normal.value) == ("ok", 40 * 1024 * 1024)


@LINUX
def test_a_worker_asks_to_be_the_first_the_kernel_stops() -> None:
    chosen = run_job(
        jobs.read_oom_score_adj, (), timeout_s=30, memory_limit_mb=None, prefer_oom_victim=True
    )
    plain = run_job(jobs.read_oom_score_adj, (), timeout_s=30, memory_limit_mb=None)
    assert chosen.value == "1000"
    assert plain.value != "1000"


# ---------------------------------------------------- a real fork server misbehaving


def _fork_server_pid() -> int:
    from multiprocessing import forkserver

    pid = forkserver._forkserver._forkserver_pid
    assert isinstance(pid, int)
    return pid


def _alive(pid: int) -> bool:
    try:
        with open(f"/proc/{pid}/stat") as handle:
            return handle.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return False


def _children_of(pid: int) -> list[int]:
    found = []
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                with open(f"/proc/{entry}/stat") as handle:
                    if int(handle.read().rsplit(")", 1)[1].split()[1]) == pid:
                        found.append(int(entry))
            except (OSError, ValueError, IndexError):
                pass
    return found


@LINUX
def test_a_killed_fork_server_does_not_stop_the_service() -> None:
    use_start_method("forkserver")
    assert run_job(jobs.echo, (1,), timeout_s=60, memory_limit_mb=None).value == 1
    pid = _fork_server_pid()
    os.kill(pid, signal.SIGKILL)
    deadline = time.monotonic() + 10
    while _alive(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    result = run_job(jobs.echo, (2,), timeout_s=60, memory_limit_mb=None)
    assert (result.kind, result.value) == ("ok", 2)


@LINUX
def test_a_hung_fork_server_is_ended_and_replaced(monkeypatch: pytest.MonkeyPatch) -> None:
    use_start_method("forkserver")
    assert run_job(jobs.echo, (1,), timeout_s=60, memory_limit_mb=None).value == 1
    pid = _fork_server_pid()
    os.kill(pid, signal.SIGSTOP)  # alive but not answering
    monkeypatch.setattr(worker, "_START_TIMEOUT_S", 2.0)
    started = time.monotonic()
    try:
        result = run_job(jobs.echo, (3,), timeout_s=60, memory_limit_mb=None)
    finally:
        if _alive(pid):
            os.kill(pid, signal.SIGCONT)
    assert (result.kind, result.value) == ("ok", 3)
    assert time.monotonic() - started < 30
    assert worker._METHOD == "spawn"
    deadline = time.monotonic() + 10
    while _alive(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not _alive(pid), "the hung fork server was left running"


@LINUX
def test_repeated_worker_termination_leaves_nothing_behind() -> None:
    use_start_method("forkserver")
    assert run_job(jobs.echo, (1,), timeout_s=60, memory_limit_mb=None).value == 1
    server = _fork_server_pid()
    for _ in range(10):
        assert run_job(jobs.sleep_forever, (30,), timeout_s=0.5, memory_limit_mb=None).kind == (
            "timeout"
        )
    cancel = threading.Event()
    threading.Timer(0.5, cancel.set).start()
    assert run_job(
        jobs.sleep_forever, (30,), timeout_s=60, memory_limit_mb=None, cancel=cancel
    ).kind == ("cancelled")
    deadline = time.monotonic() + 10
    while _children_of(server) and time.monotonic() < deadline:
        time.sleep(0.2)
    assert _children_of(server) == []
    assert run_job(jobs.echo, (5,), timeout_s=60, memory_limit_mb=None).value == 5  # still serving


@LINUX
def test_nothing_survives_the_killed_server(tmp_path: Path) -> None:
    """Kill the API process while a worker runs: the fork server and the worker must both go."""
    info = tmp_path / "info.txt"
    script = (
        f"import sys, threading; sys.path.insert(0, {str(BACKEND)!r})\n"
        "from multiprocessing import forkserver\n"
        "from blueprintiq.api.worker import run_job, use_start_method\n"
        "from tests.api import jobs\n"
        "if __name__ == '__main__':\n"
        "    use_start_method('forkserver')\n"
        "    run_job(jobs.echo, (1,), timeout_s=60, memory_limit_mb=None)\n"
        f"    open({str(info)!r}, 'w').write(str(forkserver._forkserver._forkserver_pid))\n"
        "    run_job(jobs.sleep_forever, (120,), timeout_s=120, memory_limit_mb=None)\n"
    )
    runner = tmp_path / "runner.py"
    runner.write_text(script, encoding="utf-8")
    parent = subprocess.Popen([sys.executable, str(runner)], cwd=BACKEND)
    try:
        deadline = time.monotonic() + 60
        while not info.exists() and time.monotonic() < deadline:
            time.sleep(0.2)
        assert info.exists(), "the fork server never started"
        server = int(info.read_text(encoding="utf-8"))
        deadline = time.monotonic() + 30
        while not _children_of(server) and time.monotonic() < deadline:
            time.sleep(0.2)
        workers = _children_of(server)
        assert workers, "the worker never started"
    finally:
        parent.kill()  # hard kill: no clean-up runs in the parent
        parent.wait()
    deadline = time.monotonic() + 20
    while (_alive(server) or any(_alive(w) for w in workers)) and time.monotonic() < deadline:
        time.sleep(0.25)
    assert not _alive(server), "the fork server outlived the API process"
    assert not any(_alive(w) for w in workers), "a worker outlived the API process"
