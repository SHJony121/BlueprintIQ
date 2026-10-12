"""The inspection pipeline (layer F): PDF bytes + ruleset -> validated report.

Orchestration only: reading is ``extraction.reader``, judging is ``rules.engine``.
The returned ``InspectionReport`` has been through every model validator, so its
findings, evidence references and summary are mutually consistent.
"""

import time

from blueprintiq.domain.models import FindingSummary, InspectionReport, RulesetInfo
from blueprintiq.extraction.reader import read_drawing
from blueprintiq.ingestion.limits import DEFAULT_LIMITS, IngestionLimits
from blueprintiq.rules.config import Ruleset
from blueprintiq.rules.engine import evaluate


def inspect_drawing(
    data: bytes,
    ruleset: Ruleset,
    *,
    filename: str | None = None,
    limits: IngestionLimits = DEFAULT_LIMITS,
) -> InspectionReport:
    """Read one drawing and evaluate the ruleset. Raises ``DocumentRejectedError``."""
    started = time.perf_counter()
    drawing = read_drawing(data, filename=filename, limits=limits)
    findings = evaluate(drawing.measurements, ruleset)
    return InspectionReport(
        document=drawing.document,
        ruleset=RulesetInfo(id=ruleset.ruleset.id, version=ruleset.ruleset.version),
        measurements=drawing.measurements,
        unrecognized_annotations=drawing.unrecognized_annotations,
        findings=findings,
        summary=FindingSummary.from_findings(findings),
        processing_time_ms=(time.perf_counter() - started) * 1000.0,
    )
