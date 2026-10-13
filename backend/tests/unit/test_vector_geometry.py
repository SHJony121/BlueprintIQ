"""Primitives read from a page's vector drawing: lines, circles, arcs, arrows, dots."""

import math

import pymupdf
import pytest

from blueprintiq.extraction import vector_geometry as vg
from tests.fixtures.synthetic_pdf import DocumentSpec, PageSpec, Shape, build_pdf


def scene(*shapes: Shape, **page) -> vg.Scene:
    data = build_pdf(DocumentSpec(pages=(PageSpec(shapes=shapes, **page),)))
    return vg.extract_scene(pymupdf.open(stream=data, filetype="pdf")[0])


def test_a_bezier_circle_is_a_circle() -> None:
    sc = scene(Shape("circle", (200, 300, 25)))
    (c,) = sc.circles
    assert (round(c.cx, 1), round(c.cy, 1), round(c.r, 1)) == (200.0, 300.0, 25.0)
    assert not sc.segments


@pytest.mark.parametrize("n", [24, 36, 120])
def test_a_polygon_circle_is_a_circle(n: int) -> None:
    (c,) = scene(Shape("polycircle", (150, 200, 18, n))).circles
    assert abs(c.r - 18) < 0.05


def test_a_coarse_polygon_is_not_called_round() -> None:
    sc = scene(Shape("polycircle", (150, 200, 18, 8)))  # an octagon turns 45 degrees a vertex
    assert not sc.circles and len(sc.segments) == 8


def test_an_arc_made_of_short_segments_is_an_arc_with_its_sweep() -> None:
    (a,) = scene(Shape("polyarc", (300, 300, 30, 200, 340, 28))).arcs
    assert abs(a.r - 30) < 0.05
    assert abs(math.degrees(abs(a.sweep)) - 140) < 1.0
    assert a.contains_angle(math.radians(270)) and not a.contains_angle(math.radians(90))


def test_a_few_segments_are_not_an_arc() -> None:
    sc = scene(Shape("polyarc", (300, 300, 30, 200, 260, 3)))
    assert not sc.arcs and len(sc.segments) == 3


def test_a_filled_triangle_is_an_arrow_with_its_tip_and_direction() -> None:
    (a,) = scene(Shape("fillpoly", (100, 100, 110, 97.5, 110, 102.5))).arrows
    assert a.kind == "triangle" and a.tip == pytest.approx((100, 100), abs=0.01)
    assert a.direction == pytest.approx((-1, 0), abs=0.01)


def test_an_open_triangle_inside_a_polyline_is_an_arrow_too() -> None:
    sc = scene(Shape("polyline", (200, 100, 100, 100, 110, 97.5, 110, 102.5, 100, 100)))
    assert [a.kind for a in sc.arrows] == ["triangle"]
    assert len(sc.segments) == 1  # only the shaft remains a line


def test_two_short_equal_strokes_make_a_v_arrow() -> None:
    sc = scene(Shape("polyline", (110, 96, 100, 100, 110, 104)))
    assert [a.kind for a in sc.arrows] == ["v"]


def test_a_small_filled_circle_is_a_dot_and_a_small_stroked_one_is_not() -> None:
    sc = scene(Shape("dot", (100, 100, 1.7, 24)), Shape("polycircle", (200, 100, 2.0, 24)))
    assert len(sc.dots) == 1 and len(sc.circles) == 1


def test_dashed_lines_are_kept_apart_from_solid_ones() -> None:
    sc = scene(Shape("dashed", (10, 10, 100, 10)), Shape("line", (10, 20, 100, 20)))
    assert len(sc.dashed) == 1 and len(sc.segments) == 1


def test_collinear_touching_segments_merge_into_one_run() -> None:
    sc = scene(
        Shape("line", (10, 50, 40, 50)),
        Shape("line", (40, 50, 90, 50)),
        Shape("line", (90.5, 50, 120, 50)),
    )
    lengths = sorted(round(r.length) for r in sc.runs)
    assert lengths == [30, 80]  # the last one is 0.5 pt away: a gap, not a join


def test_lines_a_fraction_of_a_point_apart_stay_separate() -> None:
    sc = scene(Shape("line", (10, 50, 100, 50)), Shape("line", (10, 50.3, 100, 50.3)))
    assert len(sc.runs) == 2


def test_a_page_with_too_many_paths_is_reported_as_truncated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(vg, "MAX_PATHS", 2)
    sc = scene(*(Shape("line", (10, 10 + i, 50, 10 + i)) for i in range(5)))
    assert sc.truncated and not sc.segments


def test_coordinates_are_page_space_on_a_rotated_page() -> None:
    sc = scene(Shape("line", (100, 50, 300, 50)), rotate=90)
    (run,) = sc.runs
    assert run.length == pytest.approx(200, abs=0.01)
    assert {round(run.p0[1]), round(run.p1[1])} == {50}  # unrotated page space, as for text
