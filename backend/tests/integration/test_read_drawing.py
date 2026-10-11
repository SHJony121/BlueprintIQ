"""Real PDF bytes -> text lines -> parser -> validated measurements, vs ground truth."""

from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from hashlib import sha256
from typing import Any

import pytest

from blueprintiq.domain.models import (
    DimensionMeasurement,
    DrawingExtraction,
    ExtractionStatus,
    MaterialAnnotation,
)
from blueprintiq.extraction.reader import extract_text, read_drawing
from blueprintiq.ingestion.errors import DocumentRejectedError
from tests.integration.fixture_data import (
    box_mismatch,
    fixture_names,
    load_expected,
    pdf_bytes,
)

VALID = fixture_names(valid=True)
INVALID = fixture_names(valid=False)


def test_fixture_inventory_is_what_we_expect() -> None:
    assert len(VALID) == 22
    assert len(INVALID) == 10


# ----------------------------------------------------------------- text layer


@pytest.mark.parametrize("name", VALID)
def test_extracted_lines_match_ground_truth_text_and_order(name: str) -> None:
    expected = load_expected(name)
    extracted = extract_text(pdf_bytes(name))
    assert [line.text for line in extracted.lines] == [e["text"] for e in expected["lines"]]


@pytest.mark.parametrize("name", VALID)
def test_every_line_box_matches_the_independent_ink_box(name: str) -> None:
    expected = load_expected(name)
    extracted = extract_text(pdf_bytes(name))
    for line, truth in zip(extracted.lines, expected["lines"], strict=True):
        assert line.bbox is not None, f"{name}: {line.text!r} has no box"
        problem = box_mismatch(line.bbox, truth)
        assert problem is None, f"{name}: {line.text!r}: {problem}"


@pytest.mark.parametrize("name", VALID)
def test_page_geometry_matches_ground_truth(name: str) -> None:
    expected = load_expected(name)["page"]
    page = extract_text(pdf_bytes(name)).pages[0]
    assert page.page_number == 1
    assert page.width_pt == pytest.approx(expected["width_pt"])
    assert page.height_pt == pytest.approx(expected["height_pt"])
    assert page.rotation == expected["rotation"]
    assert page.pdf_crop_box == pytest.approx(tuple(expected["pdf_crop_box"]))


@pytest.mark.parametrize("name", VALID)
def test_hidden_text_is_counted_and_never_returned(name: str) -> None:
    expected = load_expected(name)
    extracted = extract_text(pdf_bytes(name))
    assert extracted.hidden_lines == expected["hidden_lines"]
    # Hidden text never appears among the lines: the exact-match line test above
    # compares every returned line with the hand-written list of visible lines.


@pytest.mark.parametrize("name", VALID)
def test_every_line_lies_on_its_page(name: str) -> None:
    extracted = extract_text(pdf_bytes(name))
    page = extracted.pages[0]
    for line in extracted.lines:
        assert line.bbox is not None
        assert -1.0 <= line.bbox.x0 <= line.bbox.x1 <= page.width_pt + 1.0
        assert -1.0 <= line.bbox.y0 <= line.bbox.y1 <= page.height_pt + 1.0


# ---------------------------------------------------------- full read_drawing


def _assert_measurement(actual: Any, truth: dict[str, Any], name: str) -> None:
    where = f"{name} {truth['id']}"
    assert actual.id == truth["id"], where
    assert actual.kind == truth["kind"], where
    assert actual.source.raw_text == truth["raw_text"], where
    assert actual.status.value == truth["status"], where
    assert [i.value for i in actual.issues] == truth["issues"], where
    if truth["kind"] == "dimension":
        assert isinstance(actual, DimensionMeasurement)
        assert actual.dimension_type.value == truth["dimension_type"], where
        for field in ("value", "normalized_value_mm"):
            want = truth[field]
            got = getattr(actual, field)
            assert got == (Decimal(want) if want is not None else None), f"{where} {field}"
        assert (actual.unit.value if actual.unit else None) == truth["unit"], where
    else:
        assert isinstance(actual, MaterialAnnotation)
        assert actual.value == truth["value"], where


@pytest.mark.parametrize("name", VALID)
def test_measurements_match_ground_truth(name: str) -> None:
    expected = load_expected(name)
    result = read_drawing(pdf_bytes(name), filename=f"{name}.pdf")
    assert len(result.measurements) == len(expected["measurements"]), name
    for actual, truth in zip(result.measurements, expected["measurements"], strict=True):
        _assert_measurement(actual, truth, name)
    assert [u.label for u in result.unrecognized_annotations] == expected["unrecognized"]


@pytest.mark.parametrize("name", VALID)
def test_measurement_evidence_points_at_its_source_line(name: str) -> None:
    extracted = extract_text(pdf_bytes(name))
    result = read_drawing(pdf_bytes(name))
    boxes = {line.text: line.bbox for line in extracted.lines}
    for m in result.measurements:
        assert m.source.page_number == 1
        assert m.source.extraction_method.value == "pdf_text_layer"
        assert m.source.bbox == boxes[m.source.raw_text]


def test_document_info_identifies_the_exact_file() -> None:
    data = pdf_bytes("valid_basic")
    result = read_drawing(data, filename="C:\\drawings\\valid_basic.pdf")
    assert isinstance(result, DrawingExtraction)
    assert result.document.sha256 == sha256(data).hexdigest()
    assert result.document.size_bytes == len(data)
    assert result.document.filename == "valid_basic.pdf"  # path stripped
    assert result.document.page_count == 1


def test_result_round_trips_through_json() -> None:
    result = read_drawing(pdf_bytes("unit_conversion"))
    assert DrawingExtraction.model_validate_json(result.model_dump_json()) == result


def test_ambiguous_annotations_stay_visible_downstream() -> None:
    result = read_drawing(pdf_bytes("ambiguous"))
    statuses = {m.status for m in result.measurements}
    assert statuses == {ExtractionStatus.AMBIGUOUS}
    assert len(result.measurements) == 5


def test_specification_limit_is_not_a_measurement() -> None:
    result = read_drawing(pdf_bytes("ambiguous"))
    assert "MIN THICKNESS" in [u.label for u in result.unrecognized_annotations]
    assert all("MIN THICKNESS" not in m.source.raw_text for m in result.measurements)


# ------------------------------------------------------------------ rejection


@pytest.mark.parametrize("name", INVALID)
def test_invalid_fixtures_are_rejected_with_their_code(name: str) -> None:
    expected = load_expected(name)
    with pytest.raises(DocumentRejectedError) as excinfo:
        read_drawing(pdf_bytes(name))
    assert excinfo.value.code == expected["error"]


# ----------------------------------------------------------------- concurrency


def test_concurrent_calls_return_correct_independent_results() -> None:
    names = ["valid_basic", "rotated_90", "cropped", "conflicting"] * 4
    expected = {n: len(load_expected(n)["measurements"]) for n in set(names)}
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda n: (n, read_drawing(pdf_bytes(n))), names))
    for name, result in results:
        assert len(result.measurements) == expected[name]
