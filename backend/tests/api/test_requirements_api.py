"""Custom requirements through the real endpoint, worker and engine, on committed fixtures."""

import json
from typing import Any
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from blueprintiq.domain.models import InspectionReport
from tests.api.test_api import PDF, assert_error, client, post
from tests.fixtures.expected_findings import EXPECTED_FINDINGS
from tests.integration.fixture_data import pdf_bytes

HEADER = "X-Inspection-Requirements"


@pytest.fixture(scope="module")
def api() -> TestClient:
    return client()


def inspect(api: TestClient, name: str, requirements: dict[str, Any] | None) -> InspectionReport:
    headers = dict(PDF)
    if requirements is not None:
        headers[HEADER] = quote(json.dumps({"version": 1, **requirements}), safe="")
    response = post(api, pdf_bytes(name), headers=headers)
    assert response.status_code == 200, response.text
    return InspectionReport.model_validate_json(response.text)


def statuses(report: InspectionReport) -> list[tuple[str, str]]:
    return [(f.rule_id, f.status.value) for f in report.findings]


def test_without_the_header_the_server_ruleset_is_used_unchanged(api: TestClient) -> None:
    report = inspect(api, "violations", None)
    assert report.ruleset.id == "test-rules"
    got = tuple((f.rule_id, f.status.value, f.measurement_ids) for f in report.findings)
    assert got == EXPECTED_FINDINGS["violations"]


def test_the_same_drawing_gets_different_outcomes_from_different_requirements(
    api: TestClient,
) -> None:
    # valid_basic: thickness 4 mm, diameter 20 mm, length 120 mm, material SS400
    strict = inspect(
        api,
        "valid_basic",
        {"min_thickness_mm": "5", "max_diameter_mm": "10", "max_length_mm": "100"},
    )
    lenient = inspect(
        api,
        "valid_basic",
        {"min_thickness_mm": "3", "max_diameter_mm": "50", "max_length_mm": "500"},
    )
    assert statuses(strict) == [
        ("THK-MIN-001", "fail"),
        ("DIA-MAX-001", "fail"),
        ("LEN-RANGE-001", "fail"),
    ]
    assert statuses(lenient) == [
        ("THK-MIN-001", "pass"),
        ("DIA-MAX-001", "pass"),
        ("LEN-RANGE-001", "pass"),
    ]
    assert strict.ruleset.id == lenient.ruleset.id == "custom-requirements"
    assert strict.findings[0].expected == ">= 5 mm"
    assert "5 mm (your requirement)" in strict.findings[0].rule_description


def test_only_the_requested_requirements_are_evaluated(api: TestClient) -> None:
    report = inspect(api, "violations", {"min_thickness_mm": "1"})
    assert statuses(report) == [("THK-MIN-001", "pass")]  # violations.pdf has 2 mm: now fine


def test_a_threshold_at_the_exact_value_is_inclusive(api: TestClient) -> None:
    assert statuses(inspect(api, "valid_basic", {"min_thickness_mm": "4"})) == [
        ("THK-MIN-001", "pass")
    ]
    assert statuses(inspect(api, "valid_basic", {"min_thickness_mm": "4.000001"})) == [
        ("THK-MIN-001", "fail")
    ]


def test_missing_and_ambiguous_measurements_keep_their_own_outcomes(api: TestClient) -> None:
    missing = inspect(api, "missing_material", {"material": {"required": True}})
    assert statuses(missing) == [("MAT-REQ-001", "missing")]
    ambiguous = inspect(api, "ambiguous", {"min_thickness_mm": "0", "max_diameter_mm": "1000"})
    assert {s for _, s in statuses(ambiguous)} == {
        "needs_review"
    }  # no threshold turns uncertainty into a verdict


def test_exact_material_code(api: TestClient) -> None:
    same = inspect(api, "valid_basic", {"material": {"required": True, "code": "ss400"}})
    other = inspect(api, "valid_basic", {"material": {"required": True, "code": "SUS304"}})
    assert statuses(same) == [("MAT-REQ-001", "pass")]
    assert statuses(other) == [("MAT-REQ-001", "fail")]
    assert other.findings[0].actual == "SS400"
    assert other.findings[0].evidence[0].bbox is not None  # still traceable to the drawing text


def test_evidence_is_unchanged_by_the_requirements(api: TestClient) -> None:
    default = inspect(api, "cropped_rotated_90", None)
    custom = inspect(api, "cropped_rotated_90", {"min_thickness_mm": "1"})
    assert default.document == custom.document.model_copy(
        update={"filename": default.document.filename}
    )
    assert custom.measurements == default.measurements


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        quote(json.dumps({"version": 1}), safe=""),
        quote(json.dumps({"version": 1, "min_thickness_mm": "-3"}), safe=""),
        quote(json.dumps({"version": 1, "min_thickness_mm": 3}), safe=""),
        quote(json.dumps({"version": 1, "material": {"required": True, "code": "X;Y"}}), safe=""),
        "x" * 2049,
    ],
)
def test_invalid_requirements_are_refused_with_a_clear_code(api: TestClient, raw: str) -> None:
    response = post(api, pdf_bytes("valid_basic"), headers=PDF | {HEADER: raw})
    error = assert_error(response, 422, "INVALID_REQUIREMENTS")
    assert raw not in error["message"]  # what was submitted is not echoed back


def test_requirements_are_checked_before_the_inspection_runs(api: TestClient) -> None:
    # Bad requirements are reported as such, not as a problem with the (unreadable) file.
    response = post(api, b"not a pdf", headers=PDF | {HEADER: "not json"})
    assert_error(response, 422, "INVALID_REQUIREMENTS")


def test_the_header_is_documented_in_the_api_contract(api: TestClient) -> None:
    spec = api.get("/openapi.json").json()
    params = spec["paths"]["/api/v1/inspections"]["post"]["parameters"]
    assert [p["name"] for p in params] == [HEADER]
    assert params[0]["required"] is False
