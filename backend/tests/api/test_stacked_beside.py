"""CAD-2B.2, layout 2: the lower deviation shares the value's line, the upper is raised.

    0
3.7 -0.2

PDFs are generated here (Helvetica 13.2 pt, the sizes of a real CAD export). Value and
lower deviation are separate runs on one baseline, so the text layer reads them as one line.
"""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from blueprintiq.domain.models import InspectionReport
from tests.api.test_api import PDF, client, post
from tests.fixtures.drawing_specs import upright_run
from tests.fixtures.synthetic_pdf import DocumentSpec, PageSpec, TextRun, build_pdf, text_width

NOTE = TextRun("All dimensions are in millimeter", 72, 780)
X0, BASE, SIZE, LIFT = 98.0, 141.0, 13.2, 15.6


@pytest.fixture(scope="module")
def api() -> TestClient:
    return client()


def width(text: str, size: float = SIZE) -> float:
    return text_width(text, "Helvetica", size)


def stack(
    nominal: str = "3.7",
    lower: str = "-0.2",
    upper: str | None = "0",
    *,
    upper_size: float = SIZE,
    lift: float = LIFT,
    dx: float = 0.0,
) -> tuple[TextRun, ...]:
    """The value, the lower deviation (same baseline) and, optionally, the raised upper line."""
    lower_x = X0 + width(nominal) + 5.3
    sign = lower[0] if lower[0] in "+-" else ""
    digits = lower_x + width(sign)
    runs = [TextRun(nominal, X0, BASE, size=SIZE), TextRun(lower, lower_x, BASE, size=SIZE)]
    if upper is not None:
        hang = width(upper[0]) if upper[0] in "+-" else 0.0
        runs.append(TextRun(upper, digits + dx - hang, BASE - lift, size=upper_size))
    return tuple(runs)


def inspect(api: TestClient, *runs: TextRun, **page) -> InspectionReport:
    data = build_pdf(DocumentSpec(pages=(PageSpec(runs=runs, **page),)))
    response = post(api, data, headers=PDF)
    assert response.status_code == 200, response.text
    return InspectionReport.model_validate_json(response.text)


def parsed(r: InspectionReport):
    return [a for a in r.cad_annotations if a.status.value == "parsed"]


def test_the_real_layout_is_reconstructed_with_exact_values(api: TestClient) -> None:
    r = inspect(api, NOTE, *stack())
    (a,) = parsed(r)
    assert (a.dimension_kind.value, str(a.nominal)) == ("linear", "3.7")
    assert (str(a.upper_deviation), str(a.lower_deviation)) == ("0", "-0.2")
    assert (a.unit.value, a.unit_source.value, a.tolerance_source) == (
        "mm",
        "drawing_note",
        "stacked",
    )
    assert a.association == "none"
    # The raised "0" was a lone-zero observation; it is now a part, not a separate annotation.
    assert [x.source.raw_text for x in r.cad_annotations] == ["3.7"]


def test_evidence_is_the_real_glyph_boxes_and_the_original_text(api: TestClient) -> None:
    r = inspect(api, NOTE, *stack())
    (a,) = parsed(r)
    assert a.source.raw_text == "3.7"  # a word of the printed line, verbatim
    assert [p.raw_text for p in a.tolerance_parts] == ["0", "-0.2"]
    upper, lower = a.tolerance_parts
    assert a.source.bbox and upper.bbox and lower.bbox
    assert abs(a.source.bbox.x0 - X0) < 1.0 and abs(a.source.bbox.x1 - (X0 + width("3.7"))) < 1.0
    lower_x = X0 + width("3.7") + 5.3
    assert abs(lower.bbox.x0 - lower_x) < 1.0
    assert abs(lower.bbox.x1 - (lower_x + width("-0.2"))) < 1.0
    assert a.source.bbox.x1 < lower.bbox.x0  # the value ends before the deviation starts
    assert upper.bbox.y1 < lower.bbox.y1 - 5  # the upper line is higher on the page
    assert abs(upper.bbox.x0 - (lower_x + width("-"))) < 1.0  # over the digits, not the sign


@pytest.mark.parametrize(
    ("nominal", "lower", "upper", "expected"),
    [("7", "0", "+0.1", ("0.1", "0")), ("10.8", "0", "+0.2", ("0.2", "0")),
     ("6", "-0.2", "0", ("0", "-0.2")), ("3.7", "-0.05", "+0.10", ("0.10", "-0.05")),
     ("Ø12", "-0.1", "+0.1", ("0.1", "-0.1"))],
)  # fmt: skip
def test_signs_and_zeros(api: TestClient, nominal, lower, upper, expected) -> None:
    r = inspect(api, NOTE, *stack(nominal, lower, upper))
    (a,) = parsed(r)
    assert (str(a.upper_deviation), str(a.lower_deviation)) == expected
    assert a.tolerance_parts[0].raw_text == upper and a.tolerance_parts[1].raw_text == lower


def test_a_smaller_upper_line_is_accepted_when_the_digits_align(api: TestClient) -> None:
    r = inspect(api, NOTE, *stack(upper_size=8.0, lift=17.4))
    (a,) = parsed(r)
    assert a.tolerance_source == "stacked"


def not_reconstructed(r: InspectionReport) -> None:
    assert all(a.tolerance_source is None for a in r.cad_annotations)
    assert not any(
        a.status.value == "parsed" and a.source.raw_text == "3.7" for a in r.cad_annotations
    )
    assert r.measurements == ()


@pytest.mark.parametrize(
    "runs",
    [
        stack(upper=None),  # no upper line
        stack(upper="-0.1"),  # a negative upper deviation
        stack(upper="0.1"),  # unsigned non-zero: the sign is not guessed
        stack(lower="0", upper="0"),  # no tolerance at all
        stack(dx=9.0),  # not over the digits
        stack(dx=-9.0),
        stack(lift=40.0),  # too high to belong to it
        stack(lift=3.0),  # on the line, not above it
        stack(dx=60.0),  # far to the side
        (*stack(), TextRun("+0.1", X0 + 40, BASE - LIFT, size=SIZE)),  # a second fragment
        (*stack(), TextRun("NOTE", X0 - 30, BASE - 14.0, size=SIZE)),  # unrelated text beside
        (*stack(), TextRun("12", X0 + 60, BASE, size=SIZE)),  # another value on the line
    ],
)
def test_uncertain_layouts_are_never_reconstructed(api: TestClient, runs) -> None:
    not_reconstructed(inspect(api, NOTE, *runs))


def test_an_unpaired_value_and_negative_number_is_only_an_ambiguous_observation(
    api: TestClient,
) -> None:
    r = inspect(api, NOTE, *stack(upper=None))
    (a,) = r.cad_annotations
    assert (a.source.raw_text, a.status.value) == ("3.7 -0.2", "ambiguous")
    assert (a.nominal, a.dimension_kind) == (None, None)


def test_without_a_unit_note_nothing_is_reconstructed(api: TestClient) -> None:
    r = inspect(api, *stack())
    assert all(
        a.tolerance_source is None and a.status.value == "ambiguous" for a in r.cad_annotations
    )


def test_one_upper_line_cannot_serve_two_values(api: TestClient) -> None:
    second = tuple(replace(run, baseline=run.baseline + 4.0) for run in stack("3.7", "-0.2", None))
    not_reconstructed(inspect(api, NOTE, *stack(), *second))


@pytest.mark.parametrize("rotate", [90, 180, 270])
def test_rotated_pages_give_the_same_result(api: TestClient, rotate: int) -> None:
    def at(run: TextRun) -> TextRun:
        # The layout above is read as viewer coordinates and drawn upright for the viewer.
        return replace(
            upright_run(run.text, run.x, run.baseline, rotate, 595.0, 842.0), size=run.size
        )

    r = inspect(api, at(replace(NOTE, baseline=60)), *(at(x) for x in stack()), rotate=rotate)
    (a,) = parsed(r)
    assert (str(a.upper_deviation), str(a.lower_deviation), a.tolerance_source) == (
        "0",
        "-0.2",
        "stacked",
    )
    assert a.tolerance_parts[0].bbox and a.tolerance_parts[1].bbox and a.source.bbox


def test_a_cropped_page_gives_the_same_result(api: TestClient) -> None:
    page = {"media_box": (0.0, 0.0, 700.0, 900.0), "crop_box": (50.0, 50.0, 650.0, 850.0)}
    r = inspect(api, NOTE, *stack(), **page)
    (a,) = parsed(r)
    assert a.tolerance_source == "stacked"
    assert (str(a.upper_deviation), str(a.lower_deviation)) == ("0", "-0.2")


def vertical(side: float) -> tuple[TextRun, ...]:
    """The layout read upward (writing direction 0,-1); glyph-up is towards the left."""
    top, x = 500.0, 300.0
    lower_start = top - (width("3.7") + 5.3)
    return (
        TextRun("3.7", x, top, size=SIZE, angle=90),
        TextRun("-0.2", x, lower_start, size=SIZE, angle=90),
        TextRun("0", x + side, lower_start - width("-"), size=SIZE, angle=90),
    )


def test_vertical_text_reads_the_same_way(api: TestClient) -> None:
    r = inspect(api, NOTE, *vertical(-LIFT))
    (a,) = parsed(r)
    assert (str(a.nominal), str(a.upper_deviation), str(a.lower_deviation)) == ("3.7", "0", "-0.2")
    upper = a.tolerance_parts[0].bbox
    assert upper is not None and a.source.bbox is not None
    assert upper.x1 < a.source.bbox.x1  # the raised line is on the left


def test_a_vertical_upper_line_on_the_wrong_side_is_refused(api: TestClient) -> None:
    not_reconstructed(inspect(api, NOTE, *vertical(+LIFT)))  # the right-hand side is below


def test_a_reconstructed_stack_never_produces_a_rule_outcome(api: TestClient) -> None:
    r = inspect(api, NOTE, *stack())
    statuses = {f.rule_id: f.status.value for f in r.findings}
    assert statuses["THK-MIN-001"] == "missing" and statuses["DIA-MAX-001"] == "missing"
    assert r.summary.passed == 0 and r.summary.failed == 0


def test_three_line_stacks_and_inline_tolerances_are_unchanged(api: TestClient) -> None:
    runs = (
        TextRun("3.7", 100, 300, size=10),
        TextRun("+0", 118, 294, size=6),
        TextRun("-0.2", 118, 309, size=6),
        TextRun("2.7 ±0.1", 72, 100),
    )
    r = inspect(api, NOTE, *runs)
    assert [(a.source.raw_text, a.tolerance_source) for a in r.cad_annotations] == [
        ("2.7 ±0.1", "inline"),
        ("3.7", "stacked"),
    ]
