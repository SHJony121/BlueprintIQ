"""Module-level job functions for worker tests (spawned processes import them by name)."""

import os
import time

from blueprintiq.ingestion.errors import InvalidPdfError


def echo(value: object) -> object:
    return value


def sleep_forever(seconds: float) -> None:
    time.sleep(seconds)


def hard_exit(code: int) -> None:
    os._exit(code)


def allocate(megabytes: int) -> int:
    block = bytearray(megabytes * 1024 * 1024)
    return len(block)


def reject() -> None:
    raise InvalidPdfError("The file could not be read as a PDF.")


def fail_with_secret() -> None:
    raise RuntimeError("secret detail C:\\Users\\someone\\drawing.pdf")


def slow_inspection(data: bytes, ruleset: object, filename: str | None, limits: object) -> str:
    """Stands in for the real inspection job but never finishes in time."""
    time.sleep(60)
    return ""


def crash_inspection(data: bytes, ruleset: object, filename: str | None, limits: object) -> str:
    os._exit(7)


def broken_inspection(data: bytes, ruleset: object, filename: str | None, limits: object) -> str:
    raise RuntimeError("secret detail C:\\Users\\someone\\drawing.pdf")


def memory_hog_inspection(
    data: bytes, ruleset: object, filename: str | None, limits: object
) -> str:
    block = bytearray(4096 * 1024 * 1024)
    return str(len(block))


def report_parent_and_sleep(path: str, seconds: float) -> None:
    """Record this worker's pid, then sleep (used to test orphan handling)."""
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(str(os.getpid()))
    time.sleep(seconds)


def bad_report_inspection(
    data: bytes, ruleset: object, filename: str | None, limits: object
) -> str:
    return '{"schema_version": "1.0", "document": "DRAWING-SECRET"}'
