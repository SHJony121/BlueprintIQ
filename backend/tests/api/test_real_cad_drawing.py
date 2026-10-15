"""Regression check on the one real drawing in the repository (docs/samples/real-cad-drawing.pdf).

A drawing exported from SolidWorks, included by its owner. It is the hardest input tried, so the
results are pinned: if extraction or association changes, this must be looked at on purpose.
Aggregate facts only; the drawing's own text is not asserted.
"""

from collections import Counter
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from blueprintiq.domain.models import InspectionReport
from tests.api.test_api import PDF, client, post

DRAWING = Path(__file__).resolve().parents[3] / "docs" / "samples" / "real-cad-drawing.pdf"


@pytest.fixture(scope="module")
def report() -> InspectionReport:
    api: TestClient = client()
    response = post(api, DRAWING.read_bytes(), headers=PDF)
    assert response.status_code == 200, response.text
    return InspectionReport.model_validate_json(response.text)


def test_the_rules_are_missing_or_for_review_never_guessed(report: InspectionReport) -> None:
    outcomes = {f.rule_id: f.status.value for f in report.findings}
    assert outcomes == {
        "THK-MIN-001": "missing",  # the sheet has no labelled thickness
        "DIA-MAX-001": "missing",
        "LEN-RANGE-001": "missing",
        "MAT-REQ-001": "needs_review",  # French and English material names differ
    }
    material = next(f for f in report.findings if f.rule_id == "MAT-REQ-001")
    assert material.actual is not None
    assert "different material descriptions" in material.actual


def test_all_fifteen_linear_dimensions_are_tied_to_the_drawing(report: InspectionReport) -> None:
    parsed = [a for a in report.cad_annotations if a.status.value == "parsed"]
    assert len(parsed) == 15 and all(a.dimension_kind == "linear" for a in parsed)
    assert Counter(a.tolerance_source for a in parsed) == {"stacked": 8, "inline": 2, None: 5}
    assert len(report.cad_annotations) == 16  # one line the grammar does not cover stays ambiguous
    assert len(report.feature_associations) == 15
    assert {a.status.value for a in report.feature_associations} == {"verified"}
    relations = {a.relation.value for a in report.feature_associations if a.relation is not None}
    assert relations == {"linear_between_references"}


def test_what_was_not_read_is_reported(report: InspectionReport) -> None:
    assert report.skipped_angled_lines == 2
    assert report.cad_unit_note is not None
    assert report.geometry_summary.arrows == 27 and report.geometry_summary.dots == 7
    assert report.geometry_summary.truncated is False
