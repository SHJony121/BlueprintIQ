"""Runs inside the container: records the peak memory of the container and of each kind of
process, per phase. Standard library only, Linux only.

Usage: python sampler.py   (started by benchmark.py; the phase is read from /tmp/phase)

Writes /tmp/bench.json once a second:
  {phase: {"cgroup_peak_kb": n, "procs": {label: {"rss_peak_kb": n, "sum_peak_kb": n, "count_peak": n}}}}
`sum_peak_kb` is the largest total RSS of all processes with that label seen at one instant.
Sampling every 50 ms means a worker that lives for less than that can be missed; the
cgroup's own memory.peak (read by benchmark.py) is the cross-check.
"""

import json
import os
import time

INTERVAL = 0.05
PHASE_FILE = "/tmp/phase"
OUT = "/tmp/bench.json"
CGROUP = "/sys/fs/cgroup/memory.current"


def label(pid: str) -> str | None:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as handle:
            cmd = handle.read().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return None
    if not cmd or "sampler.py" in cmd:
        return None
    if "multiprocessing.spawn" in cmd or "spawn_main" in cmd:
        return "worker"
    if "forkserver" in cmd:
        return "forkserver?"  # the fork server and the workers forked from it look alike
    if "uvicorn" in cmd:
        return "backend"
    if "entrypoint.mjs" in cmd:
        return "supervisor"
    if "next-server" in cmd or ("next" in cmd and "node" in cmd):
        return "frontend"
    return "other"


def parent_of(pid: str) -> str:
    try:
        with open(f"/proc/{pid}/stat") as handle:
            return handle.read().rsplit(")", 1)[1].split()[1]
    except (OSError, IndexError):
        return ""


def memory_kb(pid: str) -> tuple[int, int, int]:
    """(resident, virtual, data) size of a process in kB. The virtual size is what RLIMIT_AS
    limits and the data size (heap and private mappings) is what RLIMIT_DATA limits."""
    rss = vsize = data = 0
    try:
        with open(f"/proc/{pid}/status") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1])
                elif line.startswith("VmSize:"):
                    vsize = int(line.split()[1])
                elif line.startswith("VmData:"):
                    data = int(line.split()[1])
    except OSError:
        pass
    return rss, vsize, data


def read_int(path: str) -> int:
    try:
        with open(path) as handle:
            return int(handle.read().strip())
    except (OSError, ValueError):
        return 0


def main() -> None:
    data: dict[str, dict] = {}
    last_dump = 0.0
    while True:
        try:
            with open(PHASE_FILE) as handle:
                phase = handle.read().strip() or "none"
        except OSError:
            phase = "none"
        entry = data.setdefault(phase, {"cgroup_peak_kb": 0, "procs": {}})
        entry["cgroup_peak_kb"] = max(entry["cgroup_peak_kb"], read_int(CGROUP) // 1024)
        totals: dict[str, list[tuple[int, int, int]]] = {}
        fork_pids = {p for p in os.listdir("/proc") if p.isdigit() and label(p) == "forkserver?"}
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            name = label(pid)
            if name is None:
                continue
            if name == "forkserver?":
                # A fork-server worker has the fork server as its parent; the server does not.
                name = "worker" if parent_of(pid) in fork_pids else "forkserver"
            totals.setdefault(name, []).append(memory_kb(pid))
        for name, values in totals.items():
            proc = entry["procs"].setdefault(
                name,
                {"rss_peak_kb": 0, "sum_peak_kb": 0, "count_peak": 0, "vsize_peak_kb": 0, "data_peak_kb": 0},
            )
            proc["rss_peak_kb"] = max(proc["rss_peak_kb"], max(v[0] for v in values))
            proc["vsize_peak_kb"] = max(proc["vsize_peak_kb"], max(v[1] for v in values))
            proc["data_peak_kb"] = max(proc["data_peak_kb"], max(v[2] for v in values))
            proc["sum_peak_kb"] = max(proc["sum_peak_kb"], sum(v[0] for v in values))
            proc["count_peak"] = max(proc["count_peak"], len(values))
        now = time.monotonic()
        if now - last_dump > 1.0:
            with open(OUT + ".tmp", "w") as handle:
                json.dump(data, handle)
            os.replace(OUT + ".tmp", OUT)
            last_dump = now
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
