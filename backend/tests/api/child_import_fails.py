"""Imports fine in the test process but fails inside a worker (a broken deployment).

The test sets FAIL_WORKER_IMPORT only after this module is imported in the parent; a
spawned worker inherits the variable and fails while importing the job.
"""

import os

if os.environ.get("BLUEPRINTIQ_TEST_FAIL_WORKER_IMPORT") == "1":
    raise ImportError("simulated failure while the worker starts")


def job() -> None:
    return None
