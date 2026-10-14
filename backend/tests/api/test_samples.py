"""The two sample drawings the website offers: committed bytes are current, they are original
synthetic files, and the real inspection pipeline gives the results the website describes."""

import importlib.util
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from blueprintiq.domain.models import InspectionReport
from tests.api.test_api import PDF, client, post

GENERATOR = Path(__file__).resolve().parents[2] / "scripts" / "generate_samples.py"


def _generator():  # type: ignore[no-untyped-def]
    spec = importlib.util.spec_from_file_location("generate_samples", GENERATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GEN = _generator()


@pytest.fixture(scope="module")
def api() -> TestClient:
    return client()


def inspect(api: TestClient, name: str) -> InspectionReport:
    response = post(api, (GEN.SAMPLES / name).read_bytes(), headers=PDF)
    assert response.status_code == 200, response.text
    return InspectionReport.model_validate_json(response.text)


def test_committed_samples_match_the_generator_byte_for_byte() -> None:
    rendered = GEN.render()
    assert len(rendered) == 2
    stale = [p.name for p, data in rendered.items() if not p.exists() or p.read_bytes() != data]
    assert stale == [], f"run scripts/generate_samples.py; stale: {stale}"


def test_samples_are_small_single_page_files() -> None:
    for path in GEN.render():
        data = path.read_bytes()
        assert data.startswith(b"%PDF-") and len(data) < 20_000


def test_the_basic_sample_gives_one_fail_and_three_passes(api: TestClient) -> None:
    report = inspect(api, GEN.BASIC)
    outcomes = {f.rule_id: f.status.value for f in report.findings}
    assert outcomes == {
        "THK-MIN-001": "fail",
        "DIA-MAX-001": "pass",
        "LEN-RANGE-001": "pass",
        "MAT-REQ-001": "pass",
    }


def test_the_cad_sample_shows_verified_stacked_and_unresolved_dimensions(api: TestClient) -> None:
    report = inspect(api, GEN.CAD)
    assert report.summary.passed == 4 and report.summary.failed == 0
    texts = {a.id: a.source.raw_text for a in report.cad_annotations}
    assert set(texts.values()) == {"120", "88 ±0.1", "60", "Ø20", "30"}
    stacked = [a for a in report.cad_annotations if a.tolerance_source == "stacked"]
    assert [a.source.raw_text for a in stacked] == ["60"]
    status = {texts[a.annotation_id]: a.status.value for a in report.feature_associations}
    assert status == {
        "120": "verified",
        "88 ±0.1": "verified",
        "60": "verified",
        "Ø20": "verified",
        "30": "unresolved",
    }
    assert any(a.relation.value == "diameter_of_circle" for a in report.feature_associations)
