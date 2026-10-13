"""CAD-2B.2: a value with a stacked tolerance printed as two separate lines beside it.

PDFs are generated here. Layout: a 10 pt value, and 6 pt fragments about 18 pt to its right,
one 6 pt above and one 9 pt below its baseline (so that the text layer keeps them as
separate lines, as in CAD exports).
"""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from blueprintiq.domain.models import InspectionReport
from tests.api.test_api import PDF, client, post
from tests.fixtures.drawing_specs import upright_run
from tests.fixtures.synthetic_pdf import DocumentSpec, PageSpec, TextRun, build_pdf

NOTE = TextRun("All dimensions are in millimeter", 72, 780)
VX, VB = 100.0, 300.0
FX = 118.0


@pytest.fixture(scope="module")
def api() -> TestClient:
    return client()


def value(text: str = "3.7", x: float = VX, base: float = VB) -> TextRun:
    return TextRun(text, x, base, size=10)


def upper(text: str, x: float = FX, base: float = VB - 6) -> TextRun:
    return TextRun(text, x, base, size=6)


def lower(text: str, x: float = FX, base: float = VB + 9) -> TextRun:
    return TextRun(text, x, base, size=6)


def inspect(api: TestClient, *runs: TextRun, **page) -> InspectionReport:
    data = build_pdf(DocumentSpec(pages=(PageSpec(runs=runs, **page),)))
    response = post(api, data, headers=PDF)
    assert response.status_code == 200, response.text
    return InspectionReport.model_validate_json(response.text)


def texts(r: InspectionReport) -> list[str]:
    return [a.source.raw_text for a in r.cad_annotations]


def test_a_stacked_tolerance_is_reconstructed_with_exact_values(api: TestClient) -> None:
    r = inspect(api, NOTE, value(), upper("+0"), lower("-0.2"))
    (a,) = r.cad_annotations
    assert (a.dimension_kind.value, str(a.nominal)) == ("linear", "3.7")
    assert (str(a.upper_deviation), str(a.lower_deviation)) == ("0", "-0.2")
    assert (a.unit.value, a.unit_source.value, a.status.value) == ("mm", "drawing_note", "parsed")
    assert a.tolerance_source == "stacked"
    assert a.association == "none" and a.id == "C1"


def test_the_value_and_both_fragments_keep_their_text_and_boxes(api: TestClient) -> None:
    r = inspect(api, NOTE, value(), upper("+0"), lower("-0.2"))
    (a,) = r.cad_annotations
    assert a.source.raw_text == "3.7"  # verbatim value line; nothing joined
    assert [p.raw_text for p in a.tolerance_parts] == ["+0", "-0.2"]
    assert a.source.bbox and all(p.bbox for p in a.tolerance_parts)
    up, low = a.tolerance_parts
    assert abs(a.source.bbox.x0 - VX) < 1.5 and abs(up.bbox.x0 - FX) < 1.5
    assert up.bbox.y1 <= low.bbox.y0 + 4  # the upper line is above the lower one
    assert a.source.bbox.x1 < up.bbox.x0 + 1


@pytest.mark.parametrize(
    ("up", "low", "expected"),
    [("+0.1", "-0.05", ("0.1", "-0.05")), ("+0.2", "0", ("0.2", "0")), ("0", "-0.3", ("0", "-0.3")),
     ("+0", "-0.2", ("0", "-0.2")), ("+0.10", "-0.20", ("0.10", "-0.20"))],
)  # fmt: skip
def test_positive_negative_and_zero_deviations(api: TestClient, up, low, expected) -> None:
    r = inspect(api, NOTE, value(), upper(up), lower(low))
    (a,) = r.cad_annotations
    assert (str(a.upper_deviation), str(a.lower_deviation)) == expected
    assert a.tolerance_source == "stacked"


def test_diameter_and_radius_values_take_a_stack_too(api: TestClient) -> None:
    r = inspect(api, NOTE, value("Ø12"), upper("+0.1"), lower("-0.1"))
    (a,) = r.cad_annotations
    assert a.dimension_kind.value == "diameter" and str(a.upper_deviation) == "0.1"


@pytest.mark.parametrize(
    "runs",
    [
        (value(), lower("-0.2")),  # the upper fragment is missing
        (value(), upper("+0")),  # the lower fragment is missing
        (value(), upper("-0.2"), lower("+0")),  # lower above upper
        (value(), upper("0.1"), lower("0.2")),  # unsigned non-zero: sign unknown
        (value(), upper("0"), lower("0")),  # no tolerance at all
        (value(), upper("+0"), lower("-0.2"), TextRun("+0.1", FX, VB + 18, size=6)),  # extra
        (value(), upper("+0", x=FX + 100), lower("-0.2", x=FX + 100)),  # far away
        (value(), upper("+0", x=FX + 30), lower("-0.2", x=FX + 30)),  # too far to the right
        (value(), upper("+0"), lower("-0.2", x=FX + 12)),  # not aligned
    ],
)
def test_unreliable_layouts_leave_everything_as_it_was(api: TestClient, runs) -> None:
    r = inspect(api, NOTE, *runs)
    assert all(a.tolerance_source is None for a in r.cad_annotations)
    assert all(not a.tolerance_parts for a in r.cad_annotations)
    nominal = next(a for a in r.cad_annotations if a.source.raw_text == "3.7")
    assert nominal.upper_deviation is None
    # Fragments that were not used stay visible, never merged into the value.
    assert all(a.source.raw_text != "3.7" or not a.tolerance_parts for a in r.cad_annotations)


def test_a_competing_value_next_to_the_stack_blocks_it(api: TestClient) -> None:
    r = inspect(api, NOTE, value(), upper("+0"), lower("-0.2"), value("5", x=FX + 25))
    assert all(a.tolerance_source is None for a in r.cad_annotations)
    assert "3.7" in texts(r) and "5" in texts(r)


def test_the_value_needs_its_own_unit_the_fragments_never_supply_one(api: TestClient) -> None:
    r = inspect(api, value(), upper("+0"), lower("-0.2"))  # no unit note, no unit on the value
    assert r.cad_annotations and all(a.tolerance_source is None for a in r.cad_annotations)
    assert all(a.unit is None for a in r.cad_annotations)


def test_a_lone_zero_stays_ambiguous(api: TestClient) -> None:
    r = inspect(api, NOTE, TextRun("0", 300, 500, size=6))
    (a,) = r.cad_annotations
    assert (a.status.value, a.nominal) == ("ambiguous", None)


def test_inline_tolerances_are_unchanged(api: TestClient) -> None:
    r = inspect(api, NOTE, TextRun("2.7 ±0.1", 72, 100), TextRun("3.7 +0/-0.2", 72, 140))
    assert [
        (a.source.raw_text, a.tolerance_source, a.tolerance_parts) for a in r.cad_annotations
    ] == [
        ("2.7 ±0.1", "inline", ()),
        ("3.7 +0/-0.2", "inline", ()),
    ]


def test_ids_are_renumbered_without_gaps(api: TestClient) -> None:
    r = inspect(
        api,
        NOTE,
        TextRun("R1.5", 72, 100),
        value(),
        upper("+0"),
        lower("-0.2"),
        TextRun("16", 72, 500),
    )
    assert [a.id for a in r.cad_annotations] == [
        f"C{i}" for i in range(1, len(r.cad_annotations) + 1)
    ]
    assert sorted(texts(r)) == ["16", "3.7", "R1.5"]


@pytest.mark.parametrize("rotate", [90, 180, 270])
def test_rotated_pages_give_the_same_result(api: TestClient, rotate: int) -> None:
    w, h = 595.0, 842.0

    def at(text: str, vx: float, vy: float, size: float) -> TextRun:
        return replace(upright_run(text, vx, vy, rotate, w, h), size=size)

    r = inspect(
        api,
        at("All dimensions are in millimeter", 72, 60, 10),
        at("3.7", VX, VB, 10),
        at("+0", FX, VB - 6, 6),
        at("-0.2", FX, VB + 9, 6),
        rotate=rotate,
    )
    (a,) = r.cad_annotations
    assert (str(a.upper_deviation), str(a.lower_deviation), a.tolerance_source) == (
        "0",
        "-0.2",
        "stacked",
    )
    assert [p.raw_text for p in a.tolerance_parts] == ["+0", "-0.2"]
    assert a.source.bbox and all(p.bbox for p in a.tolerance_parts)


def test_a_cropped_page_gives_the_same_result(api: TestClient) -> None:
    page = {"media_box": (0.0, 0.0, 700.0, 900.0), "crop_box": (50.0, 50.0, 650.0, 850.0)}
    r = inspect(api, NOTE, value(), upper("+0"), lower("-0.2"), **page)
    (a,) = r.cad_annotations
    assert (str(a.upper_deviation), str(a.lower_deviation), a.tolerance_source) == (
        "0",
        "-0.2",
        "stacked",
    )


def test_a_reconstructed_tolerance_never_produces_a_rule_outcome(api: TestClient) -> None:
    r = inspect(api, NOTE, value(), upper("+0"), lower("-0.2"))
    assert r.measurements == ()
    statuses = {f.rule_id: f.status.value for f in r.findings}
    assert statuses["THK-MIN-001"] == "missing" and statuses["DIA-MAX-001"] == "missing"
    assert r.summary.passed == 0 and r.summary.failed == 0
