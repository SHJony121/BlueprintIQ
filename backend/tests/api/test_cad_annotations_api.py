"""CAD-2A through the real endpoint: CAD annotations are reported apart from findings.

PDFs are generated here, in the style of a CAD export (no third-party drawing).
"""

import json

import pytest
from fastapi.testclient import TestClient

from blueprintiq.domain.models import InspectionReport
from tests.api.test_api import PDF, client, post
from tests.fixtures.synthetic_pdf import DocumentSpec, PageSpec, TextRun, build_pdf
from tests.integration.fixture_data import pdf_bytes

NOTE = TextRun("All dimensions are in millimeter", 72, 780)
CAD_TEXTS = ("2.7 ±0.1", "3.7 +0/-0.2", "Ø12", "R1.5", "75° ±0.5°", "16")
CAD_RUNS = tuple(
    TextRun(t, 72 + 90 * (i % 5), 100 + 40 * (i // 5)) for i, t in enumerate(CAD_TEXTS)
)
TITLE = (
    TextRun("MATERIAL: POM C noir", 72, 700),
    TextRun("ABC-12345", 72, 720),
    TextRun("2024-01-15", 200, 720),
    TextRun("REV 3", 300, 720),
)


@pytest.fixture(scope="module")
def api() -> TestClient:
    return client()


def make(*runs: TextRun) -> bytes:
    return build_pdf(DocumentSpec(pages=(PageSpec(runs=runs),)))


def report(api: TestClient, data: bytes) -> InspectionReport:
    response = post(api, data, headers=PDF)
    assert response.status_code == 200, response.text
    return InspectionReport.model_validate_json(response.text)


def test_cad_dimensions_are_extracted_with_exact_values_and_evidence(api: TestClient) -> None:
    r = report(api, make(NOTE, *CAD_RUNS, *TITLE))
    assert [a.source.raw_text for a in r.cad_annotations] == list(CAD_TEXTS)
    assert r.cad_unit_note is not None and r.cad_unit_note.raw_text == NOTE.text
    by_text = {a.source.raw_text: a for a in r.cad_annotations}
    assert str(by_text["2.7 ±0.1"].upper_deviation) == "0.1"
    assert str(by_text["3.7 +0/-0.2"].lower_deviation) == "-0.2"
    assert by_text["Ø12"].dimension_kind.value == "diameter"
    assert by_text["R1.5"].dimension_kind.value == "radius"
    assert by_text["75° ±0.5°"].unit.value == "deg"
    assert by_text["16"].dimension_kind.value == "linear"
    assert {a.association for a in r.cad_annotations} == {"none"}
    # Evidence: each box surrounds the text that was drawn, within the backend's contract.
    for run in (r for r in CAD_RUNS if r.text.isascii()):  # the font table has ASCII metrics only
        box = by_text[run.text].source.bbox
        assert box is not None
        x0, y0, x1, y1 = run.ink_box()
        assert box.x0 <= x0 + 3 and box.y0 <= y0 + 3 and box.x1 >= x1 - 3 and box.y1 >= y1 - 3
        assert box.x1 - box.x0 < (x1 - x0) + 8 and box.y1 - box.y0 < (y1 - y0) + 8


def test_part_numbers_dates_and_revisions_are_not_dimensions(api: TestClient) -> None:
    r = report(api, make(NOTE, *TITLE))
    assert r.cad_annotations == ()


def test_unclassified_dimensions_never_become_findings(api: TestClient) -> None:
    r = report(api, make(NOTE, *CAD_RUNS, *TITLE))
    # Only the labeled material is a measurement; thickness, diameter and length stay
    # missing although "2.7", "Ø12" and "16" are on the page.
    assert [m.source.raw_text for m in r.measurements] == ["MATERIAL: POM C noir"]
    statuses = {f.rule_id: f.status.value for f in r.findings}
    assert statuses["THK-MIN-001"] == "missing"
    assert statuses["DIA-MAX-001"] == "missing"
    assert statuses["LEN-RANGE-001"] == "missing"
    assert statuses["MAT-REQ-001"] == "pass"
    assert not any(
        a.source.raw_text in f.actual for f in r.findings for a in r.cad_annotations if f.actual
    )


def test_without_a_unit_note_values_are_kept_but_uncertain(api: TestClient) -> None:
    r = report(api, make(*CAD_RUNS[:2], CAD_RUNS[3], TextRun("16", 72, 300)))
    assert r.cad_unit_note is None
    tolerance = next(a for a in r.cad_annotations if a.source.raw_text == "2.7 ±0.1")
    assert tolerance.status.value == "ambiguous" and tolerance.unit is None
    assert str(tolerance.nominal) == "2.7"
    assert "16" not in [a.source.raw_text for a in r.cad_annotations]  # no unit evidence


def test_a_tolerance_on_other_lines_is_not_joined(api: TestClient) -> None:
    r = report(
        api, make(NOTE, TextRun("3.7", 72, 100), TextRun("+0", 140, 92), TextRun("-0.2", 140, 108))
    )
    by_text = {a.source.raw_text: a for a in r.cad_annotations}
    assert by_text["3.7"].upper_deviation is None
    for fragment in ("+0", "-0.2"):
        assert by_text[fragment].status.value == "ambiguous"
        assert by_text[fragment].nominal is None


def test_labeled_measurements_and_fixtures_are_unchanged(api: TestClient) -> None:
    r = report(api, pdf_bytes("valid_basic"))
    assert r.cad_annotations == ()
    assert r.cad_unit_note is None
    assert [f.status.value for f in r.findings] == ["pass"] * 4


def test_quantities_are_exact_strings_in_json(api: TestClient) -> None:
    response = post(api, make(NOTE, TextRun("2.70 ±0.10", 72, 100)), headers=PDF)
    annotation = json.loads(response.text)["cad_annotations"][0]
    assert annotation["nominal"] == "2.70"
    assert (annotation["upper_deviation"], annotation["lower_deviation"]) == ("0.10", "-0.10")


def test_real_style_title_block_unit_note_and_bilingual_material(api: TestClient) -> None:
    r = report(
        api,
        make(
            TextRun("-All dimensions are in millimeter.", 72, 780),
            TextRun("Toutes les dimensions sont en millimètres", 72, 800),
            TextRun("2.7 ±0.1", 72, 100),
            TextRun("3 ±0.1", 200, 100),
            TextRun("Matière / Material: POM C noir", 72, 700),
        ),
    )
    assert r.cad_unit_note is not None
    assert [
        (a.source.raw_text, a.status.value, a.unit_source.value) for a in r.cad_annotations
    ] == [
        ("2.7 ±0.1", "parsed", "drawing_note"),
        ("3 ±0.1", "parsed", "drawing_note"),
    ]
    assert [m.value for m in r.measurements] == ["POM C NOIR"]
    assert {f.rule_id: f.status.value for f in r.findings}["MAT-REQ-001"] == "pass"
    assert {f.status.value for f in r.findings if f.rule_id != "MAT-REQ-001"} == {"missing"}


def test_a_conflicting_french_note_keeps_dimensions_uncertain(api: TestClient) -> None:
    r = report(
        api,
        make(
            TextRun("-All dimensions are in millimeter.", 72, 780),
            TextRun("Toutes les dimensions sont en pouces", 72, 800),
            TextRun("2.7 ±0.1", 72, 100),
        ),
    )
    assert r.cad_unit_note is None
    assert [a.status.value for a in r.cad_annotations] == ["ambiguous"]
