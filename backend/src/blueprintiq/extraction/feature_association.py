# ruff: noqa: E501
"""Which vector geometry a CAD dimension refers to (CAD-2B.3).

A dimension text is tied to geometry only through drawing conventions that can be checked
in the vector data: a leader that starts at the text and ends in an arrowhead on a circle
or arc, pointing along a radius; a dimension line through a circle's centre with arrowheads
on its circumference; or a dimension line between two terminators (arrowhead or dot), each
on its own extension line, beside the text. Proximity alone never decides. Whatever is
missing, competing or outside these conventions is reported as unresolved or unsupported,
with the reason; nothing is guessed, and no number is compared with the geometry (the
drawing's scale is unknown).

Everything is in page space, the space of the text boxes. A verified association is a
statement about the drawing's graphics. It is not a measurement and no rule uses it.
"""

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from itertools import combinations

from blueprintiq.domain.models import (
    AssociationRelation,
    AssociationStatus,
    CadAnnotation,
    CadKind,
    ExtractionStatus,
    FeatureAssociation,
    GeometryElement,
    GeometryRole,
    GeometrySummary,
)
from blueprintiq.extraction.vector_geometry import (
    Arc,
    Circle,
    LineRun,
    Point,
    Scene,
    point_to_line,
    point_to_segment,
)

TOUCH = 0.2  # points: a terminator "on" a line or curve (PDF coordinates are exact to ~0.01)
EDGE_TOUCH = 0.75  # an extension line's far end "on" a geometry edge
PERPENDICULAR = math.sin(math.radians(1.0))  # |cos| of the angle between perpendicular lines
ALIGNED = math.cos(math.radians(8.0))  # |cos| for "along" a line
MAX_LEADER_RUNS = 3
MAX_RUNS = 8000  # more straight runs than this: too complex to pair reliably

Rect = tuple[float, float, float, float]
ResultFn = Callable[..., FeatureAssociation]


@dataclass(frozen=True, slots=True)
class _Terminator:
    tip: Point
    kind: str  # "arrow" or "dot"
    direction: Point | None  # arrows only

    def element(self) -> GeometryElement:
        return GeometryElement(role=self.kind, shape="point", coords=self.tip)


@dataclass(frozen=True, slots=True)
class _Structure:
    dim: LineRun
    ends: tuple[_Terminator, _Terminator]
    refs: tuple[LineRun, LineRun]


def associate_features(
    annotations: Sequence[CadAnnotation], scene: Scene
) -> tuple[tuple[FeatureAssociation, ...], GeometrySummary]:
    if len(scene.runs) > MAX_RUNS:
        scene.truncated = True
    summary = GeometrySummary(
        segments=len(scene.segments) + len(scene.dashed),
        circles=len(scene.circles),
        arcs=len(scene.arcs),
        arrows=len(scene.arrows),
        dots=len(scene.dots),
        truncated=scene.truncated,
    )
    boxes = [
        (a.id, (a.source.bbox.x0, a.source.bbox.y0, a.source.bbox.x1, a.source.bbox.y1))
        for a in annotations
        if a.status is ExtractionStatus.PARSED and a.source.bbox is not None
    ]
    builder = _Builder(scene, boxes)
    out: list[FeatureAssociation] = []
    for annotation in annotations:
        if annotation.status is not ExtractionStatus.PARSED or annotation.source.bbox is None:
            continue  # nothing reliable to associate; the annotation already says why
        out.append(builder.associate(annotation, f"A{len(out) + 1}"))
    return tuple(out), summary


class _Builder:
    def __init__(self, scene: Scene, boxes: list[tuple[str, Rect]]) -> None:
        self.scene = scene
        self.boxes = boxes
        self.runs = [r for r in scene.runs if r.length >= 3.0]
        self.terminators = [
            *(_Terminator(a.tip, "arrow", a.direction) for a in scene.arrows),
            *(_Terminator(d.centre, "dot", None) for d in scene.dots),
        ]
        self.circles = _dedupe_circles(scene.circles)
        self.feature_ids: dict[tuple[object, ...], str] = {}
        self._structures: list[_Structure] | None = None

    # ------------------------------------------------------------------ dispatch

    def associate(self, a: CadAnnotation, association_id: str) -> FeatureAssociation:
        box = a.source.bbox
        assert box is not None
        base = {"id": association_id, "annotation_id": a.id, "page_number": a.source.page_number}

        def result(
            status: AssociationStatus,
            relation: AssociationRelation | None,
            explanation: str,
            *,
            feature: tuple[GeometryElement, ...] = (),
            evidence: tuple[GeometryElement, ...] = (),
            candidates: int = 0,
            feature_key: tuple[object, ...] | None = None,
        ) -> FeatureAssociation:
            feature_id = None
            if status is AssociationStatus.VERIFIED:
                assert feature_key is not None
                feature_id = self.feature_ids.setdefault(
                    feature_key, f"G{len(self.feature_ids) + 1}"
                )
            return FeatureAssociation(
                **base,
                relation=relation,
                status=status,
                feature_id=feature_id,
                feature=feature,
                evidence=evidence,
                candidates=candidates,
                explanation=explanation,
            )

        if self.scene.truncated:
            return result(
                AssociationStatus.UNSUPPORTED,
                None,
                "The drawing has more vector paths than are scanned, so nothing is associated.",
            )
        if a.dimension_kind is CadKind.ANGLE:
            return result(
                AssociationStatus.UNSUPPORTED,
                None,
                "Angle dimensions are not associated with geometry.",
            )
        rect = (box.x0, box.y0, box.x1, box.y1)
        if a.dimension_kind in (CadKind.DIAMETER, CadKind.RADIUS):
            return self._round(a, rect, result)
        return self._linear(a, rect, result)

    # --------------------------------------------------- diameters and radii

    def _round(self, a: CadAnnotation, rect: Rect, result: ResultFn) -> FeatureAssociation:
        diameter = a.dimension_kind is CadKind.DIAMETER
        relation = (
            AssociationRelation.DIAMETER_OF_CIRCLE
            if diameter
            else AssociationRelation.RADIUS_OF_ARC
        )
        targets: list[tuple[Circle | Arc, list[GeometryElement]]] = []
        notes: list[str] = []

        leaders = self._leaders(rect)
        if not leaders:
            notes.append("no leader line starts at the text")
        for leader in leaders:
            found = self._leader_target(leader, diameter)
            if isinstance(found, str):
                notes.append(found)
            else:
                targets.append(found)
        if diameter:
            across = self._across_circle(rect)
            if isinstance(across, str):
                notes.append(across)
            else:
                targets.extend(across)

        distinct = _distinct_targets(targets)
        shape = "circle" if diameter else "arc"
        if len(distinct) == 1:
            target, evidence = distinct[0]
            element = _target_element(target)
            how = "a leader from the text ends in an arrowhead on it, pointing along a radius"
            if any(e.role == "dimension_line" for e in evidence) and not any(
                e.role == "leader" for e in evidence
            ):
                how = "a dimension line through its centre ends in arrowheads on its circumference"
            kind = "circle" if isinstance(target, Circle) else "arc"
            return result(
                AssociationStatus.VERIFIED,
                relation,
                f"Verified: {how}. The {kind} is a drawn shape only; it is not classified as a hole or any "
                "other part feature.",
                feature=(element,),
                evidence=(_box_element(rect), *evidence),
                candidates=len(distinct),
                feature_key=(kind, *(round(v, 2) for v in element.coords)),
            )
        if len(distinct) > 1:
            return result(
                AssociationStatus.UNRESOLVED,
                relation,
                f"Association unresolved: {len(distinct)} different {shape}s satisfy the same leader "
                "evidence, so none is chosen.",
                candidates=len(distinct),
            )
        reason = "; ".join(dict.fromkeys(notes)) or "no matching geometry"
        return result(
            AssociationStatus.UNRESOLVED,
            relation,
            f"Association unresolved: {reason}.",
            candidates=0,
        )

    def _leaders(self, rect: Rect) -> list[list[LineRun]]:
        """Chains of runs, from an end near the text outward, up to ``MAX_LEADER_RUNS``."""
        gap = max(2.0, 0.3 * min(rect[2] - rect[0], rect[3] - rect[1]))
        chains: list[list[LineRun]] = []
        for run in self.runs:
            for start, other in ((run.p0, run.p1), (run.p1, run.p0)):
                if (
                    _point_rect_distance(start, rect) <= gap
                    and _point_rect_distance(other, rect) > gap
                ):
                    chains.append(self._extend([_oriented(run, start)]))
        return chains

    def _extend(self, chain: list[LineRun]) -> list[LineRun]:
        while len(chain) < MAX_LEADER_RUNS:
            end = chain[-1].p1
            nxt = [
                r
                for r in self.runs
                if not any(_same_run(r, c) for c in chain)
                and (math.dist(r.p0, end) <= 0.3 or math.dist(r.p1, end) <= 0.3)
            ]
            if len(nxt) != 1:
                break
            chain.append(_oriented(nxt[0], end))
        return chain

    def _leader_target(
        self, chain: list[LineRun], diameter: bool
    ) -> tuple[Circle | Arc, list[GeometryElement]] | str:
        last = chain[-1]
        far = last.p1
        term = self._terminator_at(far, last)
        if term is None:
            return "the leader has no arrowhead or dot at its far end"
        candidates: list[Circle | Arc] = [*self.circles, *([] if diameter else self.scene.arcs)]
        hits: list[Circle | Arc] = []
        for shape in candidates:
            centre = shape.centre
            if abs(math.dist(far, centre) - shape.r) > _circ_tol(shape.r):
                continue
            if point_to_line(centre, last.p0, last.p1) > _centre_tol(shape.r):
                continue
            if isinstance(shape, Arc) and not shape.contains_angle(
                math.atan2(far[1] - shape.cy, far[0] - shape.cx), 0.05
            ):
                continue
            hits.append(shape)
        if not hits:
            where = "circle" if diameter else "circle or arc"
            return f"the leader's arrowhead is not on a {where} along a radius"
        if len(hits) > 1 and len(_distinct_targets([(h, []) for h in hits])) > 1:
            return "more than one shape lies under the leader's arrowhead"
        evidence = [*(_line_element("leader", r) for r in chain), term.element()]
        return hits[0], evidence

    def _terminator_at(self, point: Point, run: LineRun) -> _Terminator | None:
        for t in self.terminators:
            if math.dist(t.tip, point) > TOUCH:
                continue
            if t.kind == "dot":
                return t
            assert t.direction is not None
            if (
                abs(t.direction[0] * run.direction[0] + t.direction[1] * run.direction[1])
                >= ALIGNED
            ):
                return t
        return None

    def _across_circle(self, rect: Rect) -> list[tuple[Circle | Arc, list[GeometryElement]]] | str:
        """A dimension line through a circle's centre, arrowheads on opposite sides of it."""
        gap = max(1.5, 0.25 * min(rect[2] - rect[0], rect[3] - rect[1]))
        found: list[tuple[Circle | Arc, list[GeometryElement]]] = []
        adjacent = [r for r in self.runs if _run_rect_distance(r, rect) <= gap]
        if not adjacent:
            return "no dimension line passes the text"
        for run in adjacent:
            for circle in self.circles:
                if point_to_line(circle.centre, run.p0, run.p1) > _centre_tol(circle.r):
                    continue
                ons = [
                    t
                    for t in self.terminators
                    if abs(math.dist(t.tip, circle.centre) - circle.r) <= _circ_tol(circle.r)
                    and point_to_segment(t.tip, run.p0, run.p1) <= TOUCH
                ]
                sides = [
                    (t.tip[0] - circle.cx) * run.direction[0]
                    + (t.tip[1] - circle.cy) * run.direction[1]
                    for t in ons
                ]
                if any(s > 0 for s in sides) and any(s < 0 for s in sides):
                    found.append(
                        (
                            circle,
                            [_line_element("dimension_line", run), *(t.element() for t in ons)],
                        )
                    )
        if not found:
            return "no dimension line through a circle's centre ends in arrowheads on its circumference"
        return found

    # ------------------------------------------------------ linear dimensions

    def structures(self) -> list[_Structure]:
        if self._structures is None:
            self._structures = self._find_structures()
        return self._structures

    def _find_structures(self) -> list[_Structure]:
        found: list[_Structure] = []
        for dim in self.runs:
            ons = [t for t in self.terminators if self._on_dimension_line(t, dim)]
            for t1, t2 in combinations(ons, 2):
                if math.dist(t1.tip, t2.tip) <= 1.0:
                    continue
                refs1 = self._reference_lines(t1, dim)
                refs2 = self._reference_lines(t2, dim)
                for e1 in refs1:
                    for e2 in refs2:
                        if e1 is not e2:
                            found.append(_Structure(dim, (t1, t2), (e1, e2)))
        return found

    @staticmethod
    def _on_dimension_line(t: _Terminator, dim: LineRun) -> bool:
        if point_to_segment(t.tip, dim.p0, dim.p1) > TOUCH:
            return False
        if t.kind == "arrow":
            assert t.direction is not None
            return (
                abs(t.direction[0] * dim.direction[0] + t.direction[1] * dim.direction[1])
                >= ALIGNED
            )
        return True

    def _reference_lines(self, t: _Terminator, dim: LineRun) -> list[LineRun]:
        return [
            r
            for r in self.runs
            if r is not dim
            and r.length >= 3.0
            and abs(r.direction[0] * dim.direction[0] + r.direction[1] * dim.direction[1])
            <= PERPENDICULAR
            and point_to_segment(t.tip, r.p0, r.p1) <= TOUCH
        ]

    def _linear(self, a: CadAnnotation, rect: Rect, result: ResultFn) -> FeatureAssociation:
        relation = AssociationRelation.LINEAR_BETWEEN_REFERENCES
        gap = max(1.5, 0.25 * min(rect[2] - rect[0], rect[3] - rect[1]))
        near_dims = [r for r in self.runs if _run_rect_distance(r, rect) <= gap]
        if not near_dims:
            return result(
                AssociationStatus.UNRESOLVED,
                relation,
                "Association unresolved: no dimension line passes the text.",
            )
        mine = [s for s in self.structures() if any(s.dim is d for d in near_dims)]
        if not mine:
            return result(
                AssociationStatus.UNRESOLVED,
                relation,
                "Association unresolved: a line passes the text, but it does not end in arrowheads or dots "
                "on two parallel extension lines.",
                candidates=len(near_dims),
            )
        chosen = _choose(mine, rect)
        if chosen is None:
            return result(
                AssociationStatus.UNRESOLVED,
                relation,
                f"Association unresolved: {len(mine)} dimension structures fit the text equally, so none "
                "is chosen.",
                candidates=len(mine),
            )
        if self._text_shared(chosen, a):
            return result(
                AssociationStatus.UNRESOLVED,
                relation,
                "Association unresolved: another dimension text lies on the same dimension line.",
                candidates=len(mine),
            )
        refs = [_line_element("extension_line", r) for r in chosen.refs]
        edges = [e for r in chosen.refs if (e := self._touching_edge(r, chosen)) is not None]
        evidence = (
            _box_element(rect),
            _line_element("dimension_line", chosen.dim),
            *(t.element() for t in chosen.ends),
        )
        span = math.dist(chosen.ends[0].tip, chosen.ends[1].tip)
        note = (
            "its extension lines end on drawn edges"
            if len(edges) == 2
            else "its extension lines end in free space or on more than one edge, so no edge is named"
        )
        return result(
            AssociationStatus.VERIFIED,
            relation,
            "Verified: the dimension line beside the text ends in two terminators, each on its own "
            f"extension line, {span:.1f} pt apart on the page; {note}.",
            feature=(*refs, *edges),
            evidence=evidence,
            candidates=len(mine),
            feature_key=("references", *(round(v, 2) for e in refs for v in e.coords)),
        )

    def _text_shared(self, chosen: _Structure, a: CadAnnotation) -> bool:
        """Another dimension text beside the same dimension line makes the pairing ambiguous."""
        return any(
            other != a.id
            and _run_rect_distance(chosen.dim, rect)
            <= max(1.5, 0.25 * min(rect[2] - rect[0], rect[3] - rect[1]))
            for other, rect in self.boxes
        )

    def _touching_edge(self, ref: LineRun, chosen: _Structure) -> GeometryElement | None:
        near_end = min(
            (ref.p0, ref.p1), key=lambda p: point_to_segment(p, chosen.dim.p0, chosen.dim.p1)
        )
        far = ref.p1 if near_end is ref.p0 else ref.p0
        hits = [
            r
            for r in self.runs
            if r is not ref
            and r is not chosen.dim
            and r not in chosen.refs
            and abs(r.direction[0] * ref.direction[0] + r.direction[1] * ref.direction[1]) < ALIGNED
            and point_to_segment(far, r.p0, r.p1) <= EDGE_TOUCH
        ]
        return _line_element("reference_edge", hits[0]) if len(hits) == 1 else None


# ---------------------------------------------------------------------- helpers


def _choose(structures: list[_Structure], rect: Rect) -> _Structure | None:
    """The one structure the text belongs to, or ``None`` if it cannot be told."""
    unique = {(id(s.dim), id(s.refs[0]), id(s.refs[1])): s for s in structures}.values()
    candidates = list(unique)
    if len(candidates) == 1:
        return candidates[0]
    centre = ((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2)
    inside = []
    for s in candidates:
        d = s.dim.direction
        a0 = s.ends[0].tip[0] * d[0] + s.ends[0].tip[1] * d[1]
        a1 = s.ends[1].tip[0] * d[0] + s.ends[1].tip[1] * d[1]
        pos = centre[0] * d[0] + centre[1] * d[1]
        if min(a0, a1) <= pos <= max(a0, a1):
            inside.append(s)
    return inside[0] if len(inside) == 1 else None


def _dedupe_circles(circles: Sequence[Circle]) -> list[Circle]:
    out: list[Circle] = []
    for c in circles:
        if not any(math.dist(c.centre, o.centre) <= 0.1 and abs(c.r - o.r) <= 0.1 for o in out):
            out.append(c)
    return out


def _distinct_targets(
    targets: Sequence[tuple[Circle | Arc, list[GeometryElement]]],
) -> list[tuple[Circle | Arc, list[GeometryElement]]]:
    out: list[tuple[Circle | Arc, list[GeometryElement]]] = []
    for target, evidence in targets:
        if not any(
            type(target) is type(o)
            and math.dist(target.centre, o.centre) <= 0.1
            and abs(target.r - o.r) <= 0.1
            for o, _ in out
        ):
            out.append((target, evidence))
    return out


def _target_element(target: Circle | Arc) -> GeometryElement:
    if isinstance(target, Circle):
        return GeometryElement(
            role="circle", shape="circle", coords=(target.cx, target.cy, target.r)
        )
    return GeometryElement(
        role="arc",
        shape="arc",
        coords=(
            target.cx,
            target.cy,
            target.r,
            math.degrees(target.start),
            math.degrees(target.sweep),
        ),
    )


def _box_element(rect: Rect) -> GeometryElement:
    return GeometryElement(role="text", shape="box", coords=rect)


def _line_element(role: GeometryRole, run: LineRun) -> GeometryElement:
    return GeometryElement(
        role=role,
        shape="line",
        coords=(run.p0[0], run.p0[1], run.p1[0], run.p1[1]),
    )


def _same_run(a: LineRun, b: LineRun) -> bool:
    """The same straight run, whichever way round it is stored."""
    same = math.dist(a.p0, b.p0) <= 0.01 and math.dist(a.p1, b.p1) <= 0.01
    flipped = math.dist(a.p0, b.p1) <= 0.01 and math.dist(a.p1, b.p0) <= 0.01
    return same or flipped


def _oriented(run: LineRun, start: Point) -> LineRun:
    """The run with ``p0`` at ``start`` (the end nearer to it)."""
    if math.dist(run.p0, start) <= math.dist(run.p1, start):
        return run
    return LineRun(run.p1, run.p0, (-run.direction[0], -run.direction[1]), run.members)


def _circ_tol(r: float) -> float:
    return max(0.5, 0.02 * r)


def _centre_tol(r: float) -> float:
    return max(0.7, 0.03 * r)


def _point_rect_distance(p: Point, rect: Rect) -> float:
    dx = max(rect[0] - p[0], 0.0, p[0] - rect[2])
    dy = max(rect[1] - p[1], 0.0, p[1] - rect[3])
    return math.hypot(dx, dy)


def _run_rect_distance(run: LineRun, rect: Rect) -> float:
    a, b = run.p0, run.p1
    if _point_rect_distance(a, rect) == 0 or _point_rect_distance(b, rect) == 0:
        return 0.0
    corners = [(rect[0], rect[1]), (rect[2], rect[1]), (rect[2], rect[3]), (rect[0], rect[3])]
    edges = list(zip(corners, corners[1:] + corners[:1], strict=True))
    if any(_segments_cross(a, b, c, d) for c, d in edges):
        return 0.0
    return min(
        min(point_to_segment(c, a, b) for c in corners),
        _point_rect_distance(a, rect),
        _point_rect_distance(b, rect),
    )


def _segments_cross(a: Point, b: Point, c: Point, d: Point) -> bool:
    def side(p: Point, q: Point, r: Point) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    return side(a, b, c) * side(a, b, d) < 0 and side(c, d, a) * side(c, d, b) < 0
