"""CAD-3: exact supporting geometry, adjacent stacked tolerances, chained dimensions.

Generated PDFs only. They exercise the situations found on one real drawing (collinear
runs that fused a dimension's extension line with another line, stacks only a few points
apart, several dimensions sharing one baseline, terminators drawn twice) with controlled
geometry. They show the rules behave as designed; they are not a measure of accuracy on
real CAD output.
"""

import pytest
from fastapi.testclient import TestClient

from blueprintiq.domain.models import FeatureAssociation, GeometryElement
from tests.api.test_feature_association import (
    arrow,
    assoc_for,
    dot,
    inspect,
    line,
    linear_dim,
    text,
)
from tests.fixtures.synthetic_pdf import Shape, TextRun, text_width

# ------------------------------------------------------------------ the helpers


@pytest.fixture(scope="module")
def api() -> TestClient:
    from tests.api.test_api import client

    return client()


def elements(f: FeatureAssociation, role: str, source: str = "feature") -> list[GeometryElement]:
    return [e for e in getattr(f, source) if e.role == role]


def near(a: tuple[float, ...], b: tuple[float, ...], tol: float = 0.05) -> bool:
    return len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b, strict=True))


# ------------------------------------------------- A1: exactly the supporting geometry


def test_an_extension_line_collinear_with_other_drawing_shows_only_itself(api: TestClient) -> None:
    shapes, runs = linear_dim(100, 190, 200, "16", ext_down=30)
    # Collinear continuations of the right extension line (x = 190), touching its end: the
    # merged straight run would reach y = 300, but only (190, 195)-(190, 230) is the extension.
    shapes += [line(190, 230, 190, 300), line(190, 300, 190, 340)]
    f = assoc_for(inspect(api, shapes, runs), "16")
    assert f.status.value == "verified"
    right = [e for e in elements(f, "extension_line") if abs(e.coords[0] - 190) < 0.1]
    assert len(right) == 1
    assert near(right[0].coords, (190, 195, 190, 230)) or near(
        right[0].coords, (190, 230, 190, 195)
    )
    ys = [y for e in elements(f, "extension_line") for y in (e.coords[1], e.coords[3])]
    assert max(ys) <= 230.05  # nothing is drawn into the continuation


def test_the_dimension_line_shown_is_the_span_between_the_terminators(api: TestClient) -> None:
    shapes, runs = linear_dim(100, 190, 200, "16")
    shapes.append(line(40, 200, 260, 200))  # the same line carries on far beyond both arrows
    f = assoc_for(inspect(api, shapes, runs), "16")
    (dim,) = elements(f, "dimension_line", "evidence")
    assert near(dim.coords, (100, 200, 190, 200)) or near(dim.coords, (190, 200, 100, 200))
    tips = sorted(round(e.coords[0]) for e in elements(f, "arrow", "evidence"))
    assert tips == [100, 190]  # the line ends exactly at the terminators it is evidence for


def test_the_reference_edge_is_the_segment_touched_not_a_merged_run(api: TestClient) -> None:
    shapes, runs = linear_dim(100, 190, 200, "16", ext_down=30)
    shapes += [line(80, 230, 150, 230), line(150, 230, 250, 230)]  # one edge, drawn in two pieces
    f = assoc_for(inspect(api, shapes, runs), "16")
    edges = elements(f, "reference_edge")
    # x = 100 touches only the first piece, x = 190 only the second: one segment each, exact.
    assert len(edges) == 2
    assert sorted(round(min(e.coords[0], e.coords[2])) for e in edges) == [80, 150]
    assert sorted(round(max(e.coords[0], e.coords[2])) for e in edges) == [150, 250]


def test_a_segment_that_merely_passes_through_is_not_this_dimensions_extension_line(
    api: TestClient,
) -> None:
    shapes, runs = linear_dim(100, 190, 200, "16", ext_down=30)
    # A neighbour's long extension line, collinear with ours and passing through our crossing
    # far from both its own ends.
    shapes.append(line(100, 20, 100, 420))
    f = assoc_for(inspect(api, shapes, runs), "16")
    left = [e for e in elements(f, "extension_line") if abs(e.coords[0] - 100) < 0.1]
    assert f.status.value == "verified"
    assert all(max(e.coords[1], e.coords[3]) <= 230.05 for e in left)


def test_terminators_drawn_twice_give_one_structure_and_no_duplicate_evidence(
    api: TestClient,
) -> None:
    shapes, runs = linear_dim(100, 190, 200, "16")
    shapes += [arrow((100, 200), (-1, 0)), arrow((190, 200), (1, 0)), line(100, 195, 100, 230)]
    shapes += [dot(100, 200), dot(100.1, 200)]
    f = assoc_for(inspect(api, shapes, runs), "16")
    assert f.status.value == "verified"
    assert f.candidates == 1
    refs = elements(f, "extension_line")
    assert len(refs) == len({tuple(round(v, 1) for v in e.coords) for e in refs})
    assert sum(e.role in ("arrow", "dot") for e in f.evidence) == 2


# ------------------------------------------------------ A2: adjacent stacked tolerances

SIZE = 13.2
X0 = 98.0


def stack_at(
    base: float, nominal: str = "3.7", lower: str = "-0.2", upper: str = "0"
) -> list[TextRun]:
    lower_x = X0 + text_width(nominal, "Helvetica", SIZE) + 5.3
    digits = lower_x + (text_width(lower[0], "Helvetica", SIZE) if lower[0] in "+-" else 0.0)
    return [
        TextRun(nominal, X0, base, size=SIZE),
        TextRun(lower, lower_x, base, size=SIZE),
        TextRun(
            upper,
            digits - (text_width(upper[0], "Helvetica", SIZE) if upper[0] in "+-" else 0.0),
            base - 15.6,
            size=SIZE,
        ),
    ]


def annotation_texts(report) -> list[str]:
    return [a.source.raw_text for a in report.cad_annotations]


def stacked(report) -> dict[str, tuple[str, str]]:
    return {
        a.source.raw_text: (str(a.upper_deviation), str(a.lower_deviation))
        for a in report.cad_annotations
        if a.tolerance_source == "stacked"
    }


def test_two_stacks_only_a_few_points_apart_are_both_reconstructed(api: TestClient) -> None:
    # The second stack's raised line sits about 5 pt below the first stack's lower line.
    one, two = stack_at(141.0, "3.7"), stack_at(141.0 + 39.0, "6.5")
    r = inspect(api, [], [*one, *two])
    assert stacked(r) == {"3.7": ("0", "-0.2"), "6.5": ("0", "-0.2")}


def test_neighbouring_stacks_with_different_signs_keep_their_own_fragments(api: TestClient) -> None:
    one = stack_at(141.0, "7", "0", "+0.1")
    two = stack_at(141.0 + 39.0, "10", "-0.3", "0")
    got = stacked(inspect(api, [], [*one, *two]))
    assert got == {"7": ("0.1", "0"), "10": ("0", "-0.3")}


def test_unrelated_text_next_to_a_stack_still_blocks_it(api: TestClient) -> None:
    one = stack_at(141.0, "3.7")
    note = TextRun("NOTE", 126.0, 141.0 + 39.0 - 15.6, size=SIZE)  # where a neighbour's upper was
    r = inspect(api, [], [*one, note])
    assert stacked(r) == {}


def test_a_second_upper_fragment_near_the_stack_blocks_it(api: TestClient) -> None:
    one = stack_at(141.0, "3.7")
    rival = TextRun("+0.1", 126.0 - 4.4, 141.0 - 30.0, size=SIZE)  # also an upper-shaped line
    assert stacked(inspect(api, [], [*one, rival])) == {}


def test_a_fragment_cannot_serve_two_values(api: TestClient) -> None:
    # Two values on one raised line's reach: neither is reconstructed.
    one = stack_at(141.0, "3.7")
    other = stack_at(141.0 + 8.0, "5")
    assert "3.7" not in stacked(inspect(api, [], [*one, *other]))


# ------------------------------------------------ A3 / B1: dimensions sharing a baseline


def chain(
    texts: tuple[str, str, str], right_outside: bool = True
) -> tuple[list[Shape], list[TextRun]]:
    """Three dimensions on one baseline y = 200: x 100-160, 160-220 and 220-230."""
    xs = (100, 160, 220, 230)
    shapes = [line(x, 195, x, 240) for x in xs]
    shapes.append(line(60, 200, 290, 200))  # one long line, as CAD often draws it
    for x in xs[:3]:
        shapes.append(arrow((x, 200), (-1, 0) if x == 100 else (1, 0)))
    shapes.append(dot(160, 200))
    shapes.append(arrow((230, 200), (1, 0)))
    shapes.append(arrow((220, 200), (-1, 0)))
    runs = [
        text(texts[0], 120.0, 198.0),
        text(texts[1], 180.0, 198.0),
        text(texts[2], 250.0, 198.0),
    ]
    return shapes, runs


def spans(f: FeatureAssociation) -> tuple[int, int]:
    xs = sorted(round(e.coords[0]) for e in elements(f, "extension_line"))
    return xs[0], xs[-1]


def test_texts_inside_the_pairs_of_a_shared_baseline_are_each_tied_to_their_own_pair(
    api: TestClient,
) -> None:
    shapes, runs = chain(("10", "20", "3"))
    r = inspect(api, shapes, runs)
    assert spans(assoc_for(r, "10")) == (100, 160)
    assert spans(assoc_for(r, "20")) == (160, 220)


def test_a_text_beyond_the_last_terminator_on_the_same_line_belongs_to_the_end_pair(
    api: TestClient,
) -> None:
    shapes, runs = chain(("10", "20", "3"))
    f = assoc_for(inspect(api, shapes, runs), "3")
    assert f.status.value == "verified" and spans(f) == (220, 230)


def test_a_text_beyond_the_first_terminator_on_the_same_line_belongs_to_the_first_pair(
    api: TestClient,
) -> None:
    shapes, runs = chain(("10", "20", "3"))
    runs[0] = text("10", 70.0, 198.0)  # now outside, left of the first extension line
    f = assoc_for(inspect(api, shapes, runs), "10")
    assert f.status.value == "verified" and spans(f) == (100, 160)


def test_two_texts_for_one_pair_of_a_shared_baseline_leave_both_unresolved(api: TestClient) -> None:
    shapes, runs = chain(("10", "20", "3"))
    runs[0] = text("10", 105.0, 198.0)
    runs.append(text("11", 140.0, 198.0))  # a second text inside the same pair
    r = inspect(api, shapes, runs)
    assert assoc_for(r, "10").status.value == "unresolved"
    assert assoc_for(r, "11").status.value == "unresolved"
    assert assoc_for(r, "20").status.value == "verified"  # the other pairs are unaffected


def test_a_far_away_text_on_a_merged_line_does_not_block_a_different_pair(api: TestClient) -> None:
    # The old check flagged any other text beside the same merged line, however far away.
    shapes, runs = chain(("10", "20", "3"))
    runs.append(text("99", 270.0, 198.0))  # far beyond the last pair, on the same long line
    r = inspect(api, shapes, runs)
    assert assoc_for(r, "10").status.value == "verified"
    assert assoc_for(r, "20").status.value == "verified"


def test_a_text_that_is_on_no_dimension_line_gets_no_pair(api: TestClient) -> None:
    shapes, runs = chain(("10", "20", "3"))
    runs.append(text("77", 130.0, 150.0))  # well above the baseline
    assert assoc_for(inspect(api, shapes, runs), "77").status.value == "unresolved"


@pytest.mark.parametrize(
    "page",
    [
        {"rotate": 90},
        {"rotate": 180},
        {"media_box": (0.0, 0.0, 700.0, 900.0), "crop_box": (50.0, 50.0, 650.0, 850.0)},
    ],
)
def test_a_shared_baseline_is_read_the_same_on_rotated_and_cropped_pages(
    api: TestClient, page: dict
) -> None:
    shapes, runs = chain(("10", "20", "3"))
    r = inspect(api, shapes, runs, **page)
    assert [assoc_for(r, t).status.value for t in ("10", "20", "3")] == ["verified"] * 3
    assert spans(assoc_for(r, "3")) == (220, 230)


def test_none_of_this_changes_a_rule_outcome(api: TestClient) -> None:
    shapes, runs = chain(("10", "20", "3"))
    with_geometry, without = inspect(api, shapes, runs), inspect(api, [], runs)
    assert [f.model_dump() for f in with_geometry.findings] == [
        f.model_dump() for f in without.findings
    ]
    assert with_geometry.summary.passed == 0 and with_geometry.summary.failed == 0
