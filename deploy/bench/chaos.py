"""Failure-recovery checks for the production container under Render Free-sized limits.

Usage: python deploy/bench/chaos.py <image> <inputs dir> <results.json> [cpus]

Linux and Docker only (a GitHub-hosted Ubuntu runner qualifies). Every scenario is bounded in
size and time and runs against a real container started with --memory 512m --memory-swap 512m
and the given CPU share (default 0.1). It checks that a problem with one inspection or with the
worker machinery ends in a controlled response or a recovery, never in the whole service going
down, and that nothing is left running afterwards:

  memory      a memory-hungry job, with and without the protections (control vs protected), while
              the service handles other requests; then every legitimate input must still pass
  fork server killed, then stopped (hung), while the service handles an upload
  client disconnects mid-inspection, repeatedly
  shutdown    docker stop while an inspection is running

The sizes used are far below anything that could harm the runner. Exit status is non-zero if an
expectation fails; "control" results are reported, not asserted.
"""

import http.client
import json
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark as bm  # noqa: E402

LIST_PROCS = (
    "import os\n"
    "out = []\n"
    "for p in os.listdir('/proc'):\n"
    "    if not p.isdigit(): continue\n"
    "    try:\n"
    "        cmd = open(f'/proc/{p}/cmdline','rb').read().replace(b'\\0', b' ').decode('utf-8','replace')\n"
    "        stat = open(f'/proc/{p}/stat').read().rsplit(')', 1)[1].split()\n"
    "    except OSError:\n"
    "        continue\n"
    "    out.append((int(p), int(stat[1]), stat[0], cmd[:100]))\n"
    "print(repr(out))\n"
)

results: list[dict] = []


def procs() -> list[tuple[int, int, str, str]]:
    text = bm.run("docker", "exec", bm.NAME, "python", "-c", LIST_PROCS, check=False)
    try:
        return eval(text, {"__builtins__": {}})  # a list of tuples we printed ourselves
    except Exception:
        return []


def fork_server_and_workers() -> tuple[int | None, list[int]]:
    table = procs()
    forks = {p for p, _, _, cmd in table if "forkserver" in cmd and "sampler" not in cmd}
    server = next((p for p, ppid, _, cmd in table if p in forks and ppid not in forks), None)
    workers = [p for p, ppid, state, cmd in table if p in forks and ppid in forks and state != "Z"]
    return server, workers


def record(name: str, ok: bool, *, informational: bool = False, **facts: object) -> None:
    """Record a scenario. An informational one (the control) is reported, never asserted."""
    state = bm.inspect_state()
    if informational:
        label, ok = "info", True
    else:
        ok = ok and state["running"] and not state["oom_killed"]
        label = "ok" if ok else "FAIL"
    results.append({"scenario": name, "ok": ok, "informational": informational, "container": state, **facts})
    print(f"[{label}] {name}: {json.dumps(facts, default=str)} container={state}", flush=True)


def legit(files: dict[str, bytes], names: tuple[str, ...]) -> dict[str, int]:
    return {n: bm.post(files[n])["status"] for n in names}


def fresh(image: str, bench: Path, limits: list[str]) -> None:
    cold = bm.start(image, bench, limits, {})
    print(f"started in {cold} s", flush=True)


def oom_kills() -> int:
    return bm.cgroup().get("memory.events:oom_kill", 0)


def memory(files: dict[str, bytes], limits: list[str], image: str, bench: Path) -> None:
    for mode in ("control", "protected"):
        fresh(image, bench, limits)
        base = oom_kills()
        served: list[int] = []
        stop = threading.Event()

        def traffic() -> None:
            while not stop.is_set():
                served.append(bm.post(files["sample-cad"], timeout=120)["status"])

        thread = threading.Thread(target=traffic)
        thread.start()
        out = bm.run("docker", "exec", "-e", "PYTHONPATH=/bench", bm.NAME, "python", "/bench/hog_runner.py", mode, "900", check=False, timeout=300)
        stop.set()
        thread.join()
        try:
            outcome = json.loads(out.strip().splitlines()[-1])
        except (ValueError, IndexError):
            outcome = {"raw": out[-300:]}
        after = bm.post(files["sample-cad"])["status"]
        facts = {
            "job": outcome,
            "oom_kills_during": oom_kills() - base,
            "requests_during": {str(s): served.count(s) for s in set(served)},
            "inspection_after": after,
            "health": bm.health(),
        }
        if mode == "control":
            record("memory:control (no data cap, no oom priority)", True, informational=True, **facts)
        else:
            record(
                "memory:protected",
                outcome.get("kind") in ("resource_limit", "crashed") and after == 200 and facts["health"],
                **facts,
            )
            if outcome.get("kind") != "resource_limit":
                print("note: protected job did not end as resource_limit", flush=True)
            statuses = legit(files, ("sample-basic", "sample-cad", "complex", "heavy", "near-limit", "at-limit"))
            record("memory:legitimate inputs still pass under the protections", all(v == 200 for v in statuses.values()), statuses=statuses)


def fork_server_faults(files: dict[str, bytes], limits: list[str], image: str, bench: Path) -> None:
    fresh(image, bench, limits)
    time.sleep(5)
    assert bm.post(files["sample-cad"], timeout=180)["status"] == 200
    server, _ = fork_server_and_workers()
    bm.exec_in(f"kill -9 {server}")
    time.sleep(1)
    started = time.monotonic()
    answer = bm.post(files["sample-cad"], timeout=180)
    again = bm.post(files["sample-cad"], timeout=180)
    record(
        "fork server killed",
        server is not None and answer["status"] == 200 and again["status"] == 200,
        killed=server,
        first_after=answer,
        second_after=again,
        seconds=round(time.monotonic() - started, 1),
    )
    fresh(image, bench, limits)
    time.sleep(5)
    assert bm.post(files["sample-cad"], timeout=180)["status"] == 200
    server, _ = fork_server_and_workers()
    bm.exec_in(f"kill -STOP {server}")
    started = time.monotonic()
    answer = bm.post(files["sample-cad"], timeout=200)
    elapsed = round(time.monotonic() - started, 1)
    later = bm.post(files["sample-cad"], timeout=180)
    leftover = fork_server_and_workers()[0]
    # Controlled: served after the fall-back to spawn, or refused with a 5xx envelope. Never hung.
    record(
        "fork server hung (stopped)",
        server is not None and answer["status"] in (200, 503) and later["status"] == 200 and elapsed < 150,
        stopped=server,
        answer=answer,
        seconds=elapsed,
        next_request=later,
        hung_server_still_running=leftover == server,
    )


def disconnects(files: dict[str, bytes], limits: list[str], image: str, bench: Path) -> None:
    fresh(image, bench, limits)
    body = files["heavy"]
    for _ in range(8):
        with socket.create_connection(("127.0.0.1", bm.HOST_PORT), timeout=10) as sock:
            head = (
                f"POST /api/inspections HTTP/1.1\r\nHost: {bm.PUBLIC_HOST}\r\nContent-Type: application/pdf\r\n"
                f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
            ).encode()
            sock.sendall(head + body)
            time.sleep(0.5)
        time.sleep(0.2)
    deadline = time.monotonic() + 90
    workers: list[int] = [1]
    while workers and time.monotonic() < deadline:
        time.sleep(2)
        workers = fork_server_and_workers()[1]
    after = bm.post(files["sample-cad"], timeout=180)["status"]
    record("client disconnects mid-inspection (8 times)", not workers and after == 200 and bm.health(), workers_left=workers, inspection_after=after)


def shutdown(files: dict[str, bytes], limits: list[str], image: str, bench: Path) -> None:
    fresh(image, bench, limits)
    time.sleep(3)
    outcome: list[dict] = []
    thread = threading.Thread(target=lambda: outcome.append(bm.post(files["heavy"], timeout=120)))
    thread.start()
    time.sleep(1.5)
    started = time.monotonic()
    bm.run("docker", "stop", "--time", "20", bm.NAME, check=False, timeout=60)
    took = round(time.monotonic() - started, 1)
    thread.join()
    code = subprocess.run(["docker", "inspect", "-f", "{{.State.ExitCode}}", bm.NAME], capture_output=True, text=True).stdout.strip()
    state = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", bm.NAME], capture_output=True, text=True).stdout.strip()
    ok = took < 15 and code == "0" and state == "false"
    results.append({"scenario": "docker stop during an inspection", "ok": ok, "stop_seconds": took, "exit_code": code, "request": outcome})
    print(f"[{'ok' if ok else 'FAIL'}] docker stop during an inspection: stop {took}s exit {code} request {outcome}", flush=True)


def main() -> None:
    image, inputs, out = sys.argv[1], Path(sys.argv[2]).resolve(), Path(sys.argv[3])
    cpus = sys.argv[4] if len(sys.argv) > 4 else "0.1"
    limits = ["--memory", "512m", "--memory-swap", "512m", "--cpus", cpus]
    bench = Path(__file__).resolve().parent
    files = {p.stem: p.read_bytes() for p in sorted(inputs.glob("*.pdf"))}
    print(f"limits: {limits}", flush=True)
    for scenario in (memory, fork_server_faults, disconnects, shutdown):
        try:
            scenario(files, limits, image, bench)
        except Exception as error:  # a scenario that cannot run is a failure, not a skip
            results.append({"scenario": scenario.__name__, "ok": False, "error": f"{type(error).__name__}: {error}"})
            print(f"[FAIL] {scenario.__name__}: {type(error).__name__}: {error}", flush=True)
    bm.run("docker", "rm", "-f", bm.NAME, check=False)
    out.write_text(json.dumps(results, indent=2, default=str))
    bad = [r["scenario"] for r in results if not r["ok"]]
    print("\nSUMMARY:", "all expectations met" if not bad else f"FAILED: {bad}", flush=True)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
