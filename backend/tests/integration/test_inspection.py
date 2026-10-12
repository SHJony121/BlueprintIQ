"""PDF bytes -> full inspection report, against hand-written expected rule outcomes."""

from pathlib import Path

import pytest

from blueprintiq.domain.models import (
    DISCLAIMER,
    ExtractionStatus,
    FindingStatus,
    FindingSummary,
    InspectionReport,
)
from blueprintiq.inspection import inspect_drawing
from blueprintiq.rules.config import load_ruleset
from tests.fixtures.expected_findings import EXPECTED_FINDINGS
from tests.integration.fixture_data import fixture_names, pdf_bytes

RULES = load_ruleset(Path(__file__).resolve().parents[1] / "fixtures" / "rules" / "test_rules.toml")
VALID = fixture_names(valid=True)


def test_every_valid_fixture_has_hand_written_expectations() -> None:
    assert sorted(EXPECTED_FINDINGS) == sorted(VALID)


@pytest.mark.parametrize("name", VALID)
def test_rule_outcomes_match_expectations(name: str) -> None:
    report = inspect_drawing(pdf_bytes(name), RULES, filename=f"{name}.pdf")
    got = tuple((f.rule_id, f.status.value, f.measurement_ids) for f in report.findings)
    assert got == EXPECTED_FINDINGS[name]
    assert [f.id for f in report.findings] == [f"F{i}" for i in range(1, len(got) + 1)]


@pytest.mark.parametrize("name", VALID)
def test_reports_are_valid_and_round_trip_through_json(name: str) -> None:
    report = inspect_drawing(pdf_bytes(name), RULES)
    assert InspectionReport.model_validate_json(report.model_dump_json()) == report
    assert report.summary == FindingSummary.from_findings(report.findings)
    assert report.ruleset.id == "test-rules"
    assert report.disclaimer == DISCLAIMER


@pytest.mark.parametrize("name", VALID)
def test_no_confirmed_outcome_rests_on_uncertain_data(name: str) -> None:
    report = inspect_drawing(pdf_bytes(name), RULES)
    by_id = {m.id: m for m in report.measurements}
    for f in report.findings:
        if f.status in (FindingStatus.PASS, FindingStatus.FAIL):
            assert all(by_id[i].status is ExtractionStatus.PARSED for i in f.measurement_ids)


@pytest.mark.parametrize("name", VALID)
def test_finding_evidence_points_at_the_source_text(name: str) -> None:
    report = inspect_drawing(pdf_bytes(name), RULES)
    by_id = {m.id: m for m in report.measurements}
    for f in report.findings:
        for ref in f.evidence:
            source = by_id[ref.measurement_id].source
            assert (ref.page_number, ref.bbox) == (source.page_number, source.bbox)
            assert ref.bbox is not None  # every PDF annotation here has a location


def test_report_identifies_the_inspected_file_and_timing() -> None:
    data = pdf_bytes("violations")
    report = inspect_drawing(data, RULES, filename="violations.pdf")
    assert report.document.filename == "violations.pdf"
    assert report.document.size_bytes == len(data)
    assert report.processing_time_ms >= 0
    assert report.summary == FindingSummary(passed=1, failed=3, missing=0, needs_review=0)
