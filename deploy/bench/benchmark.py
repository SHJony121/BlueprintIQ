"""Measure the production container under Linux resource limits.

Usage: python deploy/bench/benchmark.py <image> <inputs dir> <results.json> [profile ...]

Needs Docker on a Linux host with cgroup v2 (a GitHub-hosted Ubuntu runner qualifies). For each
profile it starts a fresh container with that memory/CPU limit, then measures:

  cold start       docker run -> /api/health answers 200
  idle             memory and per-process RSS after the app has settled
  sequential       latency, CPU and peak memory for each input, three times each
  concurrent       three uploads at once (the container admits three, runs one worker)
  over the limit   an 11 MiB-ish body, which must be refused cheaply
  after            memory some seconds later, to show cleanup

Peaks come from sampler.py running inside the container (50 ms) and from the cgroup's own
memory.peak. Everything printed is measured on that run; nothing is estimated. Standard
library only. Rate limiting is raised for the run so one client can send the whole workload;
every other setting is the container's production default unless a profile overrides it.
"""

import http.client
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

NAME = "bq-bench"
HOST_PORT = 18080
PUBLIC_HOST = "bench.test"
BASE_ENV = {
    "PORT": "8080",
    "BLUEPRINTIQ_ALLOWED_HOSTS": PUBLIC_HOST,
    "BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE": "6000",
    "BLUEPRINTIQ_RATE_LIMIT_BURST": "1000",
    "BLUEPRINTIQ_MAX_UPLOADS_PER_CLIENT": "20",
}
MIB = 1024 * 1024

# name -> (docker limit flags, extra environment)
PROFILES: dict[str, tuple[list[str], dict[str, str]]] = {
    "reference-1536m-2cpu": (["--memory", "1536m", "--memory-swap", "1536m", "--cpus", "2"], {}),
    "512m-1cpu": (["--memory", "512m", "--memory-swap", "512m", "--cpus", "1"], {}),
    "render-free-512m-0.1cpu": (["--memory", "512m", "--memory-swap", "512m", "--cpus", "0.1"], {}),
    "render-free-forkserver": (
        ["--memory", "512m", "--memory-swap", "512m", "--cpus", "0.1"],
        {"BLUEPRINTIQ_WORKER_START_METHOD": "forkserver"},
    ),
    "512m-1cpu-forkserver": (
        ["--memory", "512m", "--memory-swap", "512m", "--cpus", "1"],
        {"BLUEPRINTIQ_WORKER_START_METHOD": "forkserver"},
    ),
}


def run(*args: str, check: bool = True, timeout: float = 300) -> str:
    done = subprocess.run(list(args), capture_output=True, text=True, timeout=timeout)
    if check and done.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}\n{done.stdout}\n{done.stderr}")
    return done.stdout


def exec_in(command: str) -> str:
    return run("docker", "exec", NAME, "sh", "-c", command, check=False)


def cgroup() -> dict[str, int]:
    text = exec_in(
        "cd /sys/fs/cgroup && for f in memory.current memory.peak memory.events cpu.stat; do "
        "echo \"## $f\"; cat $f 2>/dev/null; done"
    )
    out: dict[str, int] = {}
    section = ""
    for line in text.splitlines():
        if line.startswith("## "):
            section = line[3:]
        elif section in ("memory.current", "memory.peak") and line.strip().isdigit():
            out[section] = int(line)
        elif " " in line and section in ("memory.events", "cpu.stat"):
            key, value = line.split()[:2]
            out[f"{section}:{key}"] = int(value)
    return out


def set_phase(name: str) -> None:
    exec_in(f"echo '{name}' > /tmp/phase")


def inspect_state() -> dict:
    fmt = "{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}} {{.RestartCount}}"
    running, oom, code, restarts = run("docker", "inspect", "-f", fmt, NAME).split()
    return {"running": running == "true", "oom_killed": oom == "true", "exit_code": int(code), "restarts": int(restarts)}


def post(body: bytes, timeout: float = 180) -> dict:
    started = time.monotonic()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", HOST_PORT, timeout=timeout)
        conn.request(
            "POST",
            "/api/inspections",
            body=body,
            headers={"Host": PUBLIC_HOST, "Content-Type": "application/pdf", "Content-Length": str(len(body))},
        )
        response = conn.getresponse()
        data = response.read()
        conn.close()
        status = response.status
        try:
            parsed = json.loads(data)
            code = parsed.get("error", {}).get("code") if isinstance(parsed, dict) else None
        except ValueError:
            code = None
    except Exception as error:  # a reset or timeout is a result, not a crash of the benchmark
        status, code = 0, type(error).__name__
    return {"status": status, "code": code, "seconds": round(time.monotonic() - started, 2)}


def concurrent(body: bytes, count: int) -> list[dict]:
    results: list[dict] = [{}] * count

    def one(index: int) -> None:
        results[index] = post(body)

    threads = [threading.Thread(target=one, args=(i,)) for i in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results


def health() -> bool:
    try:
        conn = http.client.HTTPConnection("127.0.0.1", HOST_PORT, timeout=2)
        conn.request("GET", "/api/health")
        ok = conn.getresponse().status == 200
        conn.close()
        return ok
    except Exception:
        return False


def start(image: str, bench: Path, limits: list[str], env: dict[str, str]) -> float:
    run("docker", "rm", "-f", NAME, check=False)
    args = ["docker", "run", "-d", "--name", NAME, "--read-only", "--tmpfs", "/tmp:rw,size=128m", "--init"]
    args += ["--cap-drop", "ALL", "--security-opt", "no-new-privileges", *limits]
    for key, value in {**BASE_ENV, **env}.items():
        args += ["-e", f"{key}={value}"]
    args += ["-p", f"127.0.0.1:{HOST_PORT}:8080", "-v", f"{bench}:/bench:ro", image]
    t0 = time.monotonic()
    run(*args)
    while time.monotonic() - t0 < 180:
        if health():
            return round(time.monotonic() - t0, 2)
        time.sleep(0.05)
    raise RuntimeError("container did not become healthy in 180 s\n" + run("docker", "logs", NAME, check=False))


def cpu_seconds(before: dict[str, int], after: dict[str, int]) -> float:
    return round((after.get("cpu.stat:usage_usec", 0) - before.get("cpu.stat:usage_usec", 0)) / 1e6, 2)


def throttled_seconds(before: dict[str, int], after: dict[str, int]) -> float:
    return round((after.get("cpu.stat:throttled_usec", 0) - before.get("cpu.stat:throttled_usec", 0)) / 1e6, 2)


def phase(name: str, work) -> dict:  # type: ignore[no-untyped-def]
    set_phase(name)
    before, t0 = cgroup(), time.monotonic()
    result = work()
    wall = time.monotonic() - t0
    after = cgroup()
    return {
        "phase": name,
        "wall_s": round(wall, 2),
        "cpu_s": cpu_seconds(before, after),
        "throttled_s": throttled_seconds(before, after),
        "result": result,
    }


def sampler_data() -> dict:
    time.sleep(2.5)
    text = exec_in("cat /tmp/bench.json")
    try:
        return json.loads(text)
    except ValueError:
        return {}


def measure(image: str, inputs: Path, bench: Path, name: str) -> dict:
    limits, env = PROFILES[name]
    report: dict = {"profile": name, "limits": limits, "env": env}
    report["cold_start_s"] = start(image, bench, limits, env)
    exec_in("python /bench/sampler.py >/dev/null 2>&1 &")
    time.sleep(1)
    files = {p.stem: p.read_bytes() for p in sorted(inputs.glob("*.pdf"))}
    steps: list[dict] = []
    try:
        steps.append(phase("idle-start", lambda: time.sleep(15)))
        report["after_start_cgroup_mb"] = round(cgroup().get("memory.current", 0) / MIB, 1)
        for stem in ("sample-basic", "sample-cad", "complex", "near-limit", "at-limit"):
            steps.append(phase(f"seq:{stem}", lambda s=stem: [post(files[s]) for _ in range(3)]))
        for stem in ("sample-cad", "complex"):
            steps.append(phase(f"concurrent3:{stem}", lambda s=stem: concurrent(files[s], 3)))
        steps.append(phase("concurrent3:near-limit", lambda: concurrent(files["near-limit"], 3)))
        steps.append(phase("over-limit", lambda: [post(files["over-limit"])]))
        steps.append(phase("idle-after", lambda: time.sleep(30)))
        report["end_cgroup_mb"] = round(cgroup().get("memory.current", 0) / MIB, 1)
    except Exception as error:  # the container may have died: report what is known
        report["error"] = f"{type(error).__name__}: {error}"
    cg = cgroup()
    report["cgroup"] = {
        "memory_peak_mb": round(cg.get("memory.peak", 0) / MIB, 1),
        "oom_events": cg.get("memory.events:oom", 0),
        "oom_kills": cg.get("memory.events:oom_kill", 0),
        "total_cpu_s": round(cg.get("cpu.stat:usage_usec", 0) / 1e6, 2),
        "throttled_periods": cg.get("cpu.stat:nr_throttled", 0),
    }
    report["steps"] = steps
    report["container"] = inspect_state()
    report["health_at_end"] = health()
    report["processes"] = sampler_data()
    report["log_tail"] = run("docker", "logs", "--tail", "15", NAME, check=False)[-1500:]
    run("docker", "rm", "-f", NAME, check=False)
    return report


def summarize(report: dict) -> str:
    lines = [f"### {report['profile']}", ""]
    lines.append(f"cold start {report['cold_start_s']} s; memory after start {report.get('after_start_cgroup_mb')} MiB; "
                 f"after the workload {report.get('end_cgroup_mb')} MiB; cgroup peak {report['cgroup']['memory_peak_mb']} MiB; "
                 f"OOM kills {report['cgroup']['oom_kills']}; container {report['container']}; healthy at end {report['health_at_end']}")
    if "error" in report:
        lines.append(f"ERROR: {report['error']}")
    lines += ["", "| phase | wall s | cpu s | throttled s | results (status:seconds) |", "|---|---|---|---|---|"]
    for step in report["steps"]:
        result = step["result"]
        cells = ""
        if isinstance(result, list):
            cells = " ".join(f"{r['status'] or r['code']}:{r['seconds']}" for r in result)
        lines.append(f"| {step['phase']} | {step['wall_s']} | {step['cpu_s']} | {step['throttled_s']} | {cells} |")
    lines += ["", "peak RSS per process kind (MiB; one process / all at once / most at once):", ""]
    lines += ["| phase | container peak | " + " | ".join(["backend", "frontend", "forkserver", "worker"]) + " |", "|---|---|---|---|---|---|"]
    for name, data in report["processes"].items():
        procs = data["procs"]

        def cell(kind: str) -> str:
            p = procs.get(kind)
            return "-" if p is None else f"{p['rss_peak_kb'] / 1024:.0f} / {p['sum_peak_kb'] / 1024:.0f} / {p['count_peak']}"

        lines.append(f"| {name} | {data['cgroup_peak_kb'] / 1024:.0f} | {cell('backend')} | {cell('frontend')} | {cell('forkserver')} | {cell('worker')} |")
    return "\n".join(lines)


def main() -> None:
    image, inputs, out = sys.argv[1], Path(sys.argv[2]).resolve(), Path(sys.argv[3])
    names = sys.argv[4:] or list(PROFILES)
    bench = Path(__file__).resolve().parent
    results = []
    for name in names:
        print(f"== {name}", flush=True)
        report = measure(image, inputs, bench, name)
        results.append(report)
        print(summarize(report), flush=True)
        out.write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
