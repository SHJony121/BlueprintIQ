"""Structured (JSON lines) logging. Never log drawing text, filenames or upload bytes."""

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

_FIELDS = (
    "request_id", "event", "status", "duration_ms", "size_bytes", "sha256_prefix",
    "result", "code", "passed", "failed", "missing", "needs_review", "detail",
)  # fmt: skip


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info and record.exc_info[0] is not None:
            # The exception type only: its message or traceback could quote a drawing.
            entry["exc_type"] = record.exc_info[0].__name__
        for field in _FIELDS:
            if hasattr(record, field):
                entry[field] = getattr(record, field)
        return json.dumps(entry, default=str)


def configure_logging(level: str) -> logging.Logger:
    logger = logging.getLogger("blueprintiq")
    logger.setLevel(level.upper())
    if not any(isinstance(h.formatter, JsonFormatter) for h in logger.handlers):
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
    logger.propagate = False
    return logger
