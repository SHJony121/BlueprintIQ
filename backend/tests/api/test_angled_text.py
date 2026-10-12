"""CAD-1: angled text is skipped and reported, never read, and never hides a measurement.

PDFs are generated here (nothing third-party). Horizontal annotations are the same ones
valid_basic uses, so their results can be compared with the committed fixture.
"""

import pytest
from fastapi.testclient import TestClient

from blueprintiq.domain.models import InspectionReport
from tests.api.test_api import PDF, assert_error, client, post
from tests.fixtures.drawing_specs import BASIC_TEXTS, annotation_runs
from tests.fixtures.synthetic_pdf import DocumentSpec, PageSpec, TextRun, build_pdf
from tests.integration.fixture_data import pdf_bytes

HORIZONTAL = annotation_runs(BASIC_TEXTS)
NOTE_50 = TextRun("75 DEG +/-0.5 DEG", 300, 300, angle=50)
NOTE_39 = TextRun("4R1", 400, 400, angle=-39)


@pytest.fixture(scope="module")
def api() -> TestClient:
    return client()


def make(*runs: TextRun, **page: object) -> bytes:
    return build_pdf(DocumentSpec(pages=(PageSpec(runs=runs, **page),)))  # type: ignore[arg-type]


def report(api: TestClient, data: bytes) -> InspectionReport:
    response = post(api, data, headers=PDF)
    assert response.status_code == 200, response.text
    return InspectionReport.model_validate_json(response.text)


def statuses(r: InspectionReport) -> list[tuple[str, str]]:
    return [(f.rule_id, f.status.value) for f in r.findings]


def test_horizontal_measurements_are_read_beside_angled_text(api: TestClient) -> None:
    mixed = report(api, make(*HORIZONTAL, NOTE_50, NOTE_39))
    plain = report(api, pdf_bytes("valid_basic"))
    assert mixed.skipped_angled_lines == 2
    assert statuses(mixed) == statuses(plain)
    assert [m.source.raw_text for m in mixed.measurements] == [
        m.source.raw_text for m in plain.measurements
    ]
    assert all(m.source.bbox is not None for m in mixed.measurements)
    assert all(
        "DEG" not in m.source.raw_text and "R1" not in m.source.raw_text for m in mixed.measurements
    )


def test_a_drawing_without_angled_text_reports_zero(api: TestClient) -> None:
    assert report(api, pdf_bytes("valid_basic")).skipped_angled_lines == 0


@pytest.mark.parametrize(
    "label",
    [
        "THICKNESS: 4 mm",
        "MATERIAL: SS400",
        "DIAMETER: 20 mm",
        "NOTE: THICKNESS: 4 mm",
        "THICKNESS 4 mm: LENGTH: 9",
    ],
)
def test_a_supported_label_at_an_angle_refuses_the_drawing(api: TestClient, label: str) -> None:
    # Even when a horizontal annotation of the same kind passes, an unread angled one
    # could contradict it, so no report is produced at all.
    data = make(*HORIZONTAL, TextRun(label, 300, 300, angle=50))
    assert_error(post(api, data, headers=PDF), 422, "UNSUPPORTED_GEOMETRY")


def test_only_angled_text_is_refused_not_reported_as_empty(api: TestClient) -> None:
    assert_error(post(api, make(NOTE_50, NOTE_39), headers=PDF), 422, "UNSUPPORTED_GEOMETRY")


def test_no_measurements_beside_angled_text_never_looks_successful(api: TestClient) -> None:
    r = report(api, make(TextRun("NOTE: SEE SHEET 2", 72, 560), NOTE_50))
    assert r.skipped_angled_lines == 1
    assert r.measurements == ()
    assert r.summary.passed == 0
    assert {f.status.value for f in r.findings} == {"missing"}


def test_invalid_page_rotation_is_still_refused_with_angled_text(api: TestClient) -> None:
    data = make(*HORIZONTAL, NOTE_50, rotate=135)
    assert_error(post(api, data, headers=PDF), 422, "UNSUPPORTED_GEOMETRY")


def test_angled_text_cut_off_by_the_page_edge_is_still_refused(api: TestClient) -> None:
    edge = TextRun("SEE DETAIL A ON THE NEXT SHEET", 560, 300, angle=50)
    response = post(api, make(*HORIZONTAL, edge), headers=PDF)
    assert response.status_code == 422
    assert response.json()["error"]["code"] in {"PARTIALLY_VISIBLE_TEXT", "UNSUPPORTED_GEOMETRY"}
