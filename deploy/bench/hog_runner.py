"""Run one memory-hungry job inside the container with the service's own worker code.

Usage (inside the container): python /bench/hog_runner.py <control|protected> <megabytes>

It uses blueprintiq.api.worker.run_job exactly as the API does, in the same container memory
cgroup as the running service, so the kernel sees the same competition for memory. "control"
runs the job with only the address-space limit the service always had; "protected" adds the
private-memory cap derived from the container limit and the out-of-memory priority.
"""

import json
import sys

sys.path.insert(0, "/bench")
sys.path.insert(0, "/app/backend/src")

import hogs  # noqa: E402

from blueprintiq.api.worker import resolve_data_limit_mb, run_job, use_start_method  # noqa: E402


def main(mode: str, megabytes: int) -> None:
    use_start_method("forkserver")
    protected = mode == "protected"
    data_limit = resolve_data_limit_mb(None, 1024) if protected else None
    result = run_job(
        hogs.touch,
        (megabytes,),
        timeout_s=90,
        memory_limit_mb=1024,
        data_limit_mb=data_limit,
        prefer_oom_victim=protected,
    )
    print(json.dumps({"mode": mode, "kind": result.kind, "exitcode": result.exitcode, "data_limit_mb": data_limit}))


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]))
