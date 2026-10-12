"""Jobs executed inside the isolated worker process (see api.worker)."""

from blueprintiq.ingestion.limits import IngestionLimits
from blueprintiq.inspection import inspect_drawing
from blueprintiq.rules.config import Ruleset


def inspection_job(
    data: bytes, ruleset: Ruleset, filename: str | None, limits: IngestionLimits
) -> str:
    """Inspect one PDF and return the validated report as JSON text."""
    return inspect_drawing(data, ruleset, filename=filename, limits=limits).model_dump_json()
