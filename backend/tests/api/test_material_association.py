"""CAD-2B.1: a material value on the same row, to the right of a label-only line.

PDFs are generated here; the layout (label about 26 pt wide at 5.5 pt type, value 10 pt
type starting about 10 pt to its right, bilingual rows 7 pt apart) follows measurements of
a real title block, which is not part of this repository.
"""

import pytest
from fastapi.testclient import TestClient

from blueprintiq.domain.models import InspectionReport, MaterialAnnotation
from tests.api.test_api import PDF, client, post
from tests.fixtures.synthetic_pdf import DocumentSpec, PageSpec, TextRun, build_pdf

LABEL_X, VALUE_X, ROW = 276.6, 311.7, 7.1


@pytest.fixture(scope="module")
def api() -> TestClient:
    return client()


def label(text: str, row: float, x: float = LABEL_X, size: float = 5.5) -> TextRun:
    return TextRun(text, x, 300 + ROW * row - 0.76, size=size)


def value(text: str, row: float, x: float = VALUE_X, size: float = 10.0) -> TextRun:
    return TextRun(text, x, 300 + ROW * row, size=size)


def inspect(api: TestClient, *runs: TextRun) -> InspectionReport:
    data = build_pdf(DocumentSpec(pages=(PageSpec(runs=runs),)))
    response = post(api, data, headers=PDF)
    assert response.status_code == 200, response.text
    return InspectionReport.model_validate_json(response.text)


def materials(r: InspectionReport) -> list[MaterialAnnotation]:
    return [m for m in r.measurements if isinstance(m, MaterialAnnotation)]


def material_status(r: InspectionReport) -> str:
    return next(f.status.value for f in r.findings if f.rule_id == "MAT-REQ-001")


@pytest.mark.parametrize("name", ["Matière :", "Material :", "Matérial :"])
def test_a_value_on_the_label_row_is_associated(api: TestClient, name: str) -> None:
    r = inspect(api, label(name, 0), value("POM C noir", 0))
    (m,) = materials(r)
    assert (m.value, m.status.value) == ("POM C NOIR", "parsed")
    assert m.source.raw_text == "POM C noir"  # verbatim value line, nothing joined
    assert m.source.extraction_method.value == "pdf_text_layer_row_association"
    assert m.label_source is not None and m.label_source.raw_text == name
    assert material_status(r) == "pass"


def test_evidence_boxes_are_the_drawn_lines(api: TestClient) -> None:
    r = inspect(api, label("Matière :", 0), value("POM C noir", 0))
    (m,) = materials(r)
    assert m.source.bbox is not None and m.label_source is not None and m.label_source.bbox
    assert abs(m.source.bbox.x0 - VALUE_X) < 1.5
    assert abs(m.label_source.bbox.x0 - LABEL_X) < 1.5
    assert m.label_source.bbox.x1 < m.source.bbox.x0  # the label is left of the value
    finding = next(f for f in r.findings if f.rule_id == "MAT-REQ-001")
    assert finding.evidence[0].bbox == m.source.bbox  # a finding points at the value read


def test_closely_spaced_bilingual_rows_are_not_crossed(api: TestClient) -> None:
    r = inspect(
        api,
        label("Matière :", 0), value("POM C noir", 0),
        label("Matérial :", 1), value("black polyoxymethylene", 1),
    )  # fmt: skip
    pairs = {m.label_source.raw_text: m.source.raw_text for m in materials(r) if m.label_source}
    assert pairs == {"Matière :": "POM C noir", "Matérial :": "black polyoxymethylene"}
    # Two different material texts are a conflict to review, never a pass.
    assert material_status(r) == "needs_review"


def test_the_same_material_in_both_languages_is_still_two_readings_to_review(
    api: TestClient,
) -> None:
    r = inspect(
        api,
        label("Matière :", 0), value("POM", 0),
        label("Material :", 1), value("POM", 1),
    )  # fmt: skip
    assert len(materials(r)) == 2
    assert material_status(r) in {"pass", "needs_review"}


def test_an_empty_cell_is_not_filled_from_the_next_field(api: TestClient) -> None:
    r = inspect(api, label("Matière :", 0), label("Poids :", 0, x=330), value("12", 0, x=360))
    (m,) = materials(r)
    assert (m.value, m.status.value) == (None, "ambiguous")
    assert material_status(r) == "needs_review"


@pytest.mark.parametrize(
    "runs",
    [
        (value("POM", 0, x=305, size=6), value("C noir", 0, x=333, size=6)),  # two candidates
        (value("12345", 0),),  # numeric only
        (value("2024-01-15", 0),),  # a date
        (value("N/A", 0),),  # placeholder
        (value("TBD", 0),),
        (value("Poids : 3", 0),),  # another field
        (value("see note 2", 0),),  # indirect wording
    ],
)
def test_unreliable_candidates_leave_the_material_unread(api: TestClient, runs) -> None:
    r = inspect(api, label("Matière :", 0), *runs)
    (m,) = materials(r)
    assert (m.value, m.status.value) == (None, "ambiguous")
    assert material_status(r) == "needs_review"  # never a false pass


def test_a_value_below_the_label_is_not_associated(api: TestClient) -> None:
    r = inspect(api, label("Matière :", 0), value("POM C noir", 2, x=LABEL_X))
    (m,) = materials(r)
    assert m.value is None and material_status(r) == "needs_review"


def test_a_far_away_value_on_the_same_row_is_not_associated(api: TestClient) -> None:
    r = inspect(api, label("Matière :", 0), value("POM C noir", 0, x=LABEL_X + 200))
    assert materials(r)[0].value is None


def test_a_vertically_overlapping_value_from_the_next_row_is_not_used(api: TestClient) -> None:
    # Only the English row has a value; the French label's box overlaps it in height.
    r = inspect(
        api, label("Matière :", 0), label("Matérial :", 1), value("black polyoxymethylene", 1)
    )
    by_label = {m.source.raw_text: m for m in materials(r) if m.label_source is None}
    assert by_label["Matière :"].value is None
    assert any(m.label_source and m.label_source.raw_text == "Matérial :" for m in materials(r))


def test_same_line_materials_are_unchanged(api: TestClient) -> None:
    r = inspect(api, TextRun("MATERIAL: SS400", 72, 560))
    (m,) = materials(r)
    assert (m.value, m.label_source, m.source.extraction_method.value) == (
        "SS400",
        None,
        "pdf_text_layer",
    )


def test_a_row_associated_value_that_conflicts_with_a_labeled_one_is_reviewed(
    api: TestClient,
) -> None:
    r = inspect(
        api, TextRun("MATERIAL: SS400", 72, 560), label("Matière :", 0), value("POM C noir", 0)
    )
    assert {m.value for m in materials(r)} == {"SS400", "POM C NOIR"}
    assert material_status(r) == "needs_review"
