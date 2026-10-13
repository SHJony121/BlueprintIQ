"""Vector geometry of a page, from the PDF's own drawing operators (CAD-2B.3).

PyMuPDF reports every path as items (lines, Bezier curves, rectangles). This module turns
them into the few primitives dimension geometry is made of, all in page space (the same
space as text boxes): straight line runs, circles and arcs (also when a CAD export
approximated them by many short segments), arrowheads and dots. Everything is
deterministic and tolerance-based; nothing is classified by meaning. A circle is a circle,
not a hole.

What is deliberately not done: no arc is invented from fewer than five consecutive
segments, no dashed (centre or hidden) line becomes a dimension candidate, and a page
with more than ``MAX_PRIMITIVES`` segments is reported as truncated instead of scanned.
"""

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

import pymupdf

MAX_PATHS = 20_000
MAX_SEGMENTS = 30_000
JOIN_TOL = 0.05  # points: path items that meet this closely are one chain
RUN_ANGLE_TOL = math.radians(0.1)  # collinear runs
RUN_OFFSET_TOL = 0.06
MIN_ARC_TURNS = 4  # consecutive turning vertices needed to call a chain piece an arc
MAX_ARC_TURN = 0.6  # radians per vertex: coarser polygons are not read as round
DOT_MAX_RADIUS = 3.0
ARROW_MAX_SIDE = 40.0
ARROW_MIN_SIDE = 1.0

Point = tuple[float, float]


@dataclass(frozen=True, slots=True)
class Segment:
    p0: Point
    p1: Point
    path: int
    dashed: bool = False

    @property
    def length(self) -> float:
        return math.dist(self.p0, self.p1)


@dataclass(frozen=True, slots=True)
class Circle:
    cx: float
    cy: float
    r: float
    path: int

    @property
    def centre(self) -> Point:
        return (self.cx, self.cy)


@dataclass(frozen=True, slots=True)
class Arc:
    cx: float
    cy: float
    r: float
    start: float  # radians, atan2(y, x) in page space (y down)
    sweep: float  # radians, signed, |sweep| < 2*pi
    p0: Point
    p1: Point
    path: int

    @property
    def centre(self) -> Point:
        return (self.cx, self.cy)

    def contains_angle(self, angle: float, tol: float = 0.0) -> bool:
        """Is the direction ``angle`` (radians) within the arc's span, plus ``tol``?"""
        sweep = self.sweep
        offset = (angle - self.start) * (1 if sweep >= 0 else -1)
        offset = offset % (2 * math.pi)
        span = abs(sweep)
        return offset <= span + tol or offset >= 2 * math.pi - tol


@dataclass(frozen=True, slots=True)
class Arrow:
    tip: Point
    base: Point  # midpoint of the open side
    direction: Point  # unit vector from base to tip: the way the arrow points
    length: float
    kind: str  # "triangle" or "v"
    path: int


@dataclass(frozen=True, slots=True)
class Dot:
    cx: float
    cy: float
    r: float
    path: int

    @property
    def centre(self) -> Point:
        return (self.cx, self.cy)


@dataclass(frozen=True, slots=True)
class LineRun:
    """Collinear, touching segments merged into one straight line."""

    p0: Point  # start along the run's direction
    p1: Point
    direction: Point  # unit vector p0 -> p1
    members: int
    # The drawn segments the run was merged from, so evidence can name exactly the ones
    # that support an association instead of the whole merged line.
    segments: tuple[Segment, ...] = ()

    @property
    def length(self) -> float:
        return math.dist(self.p0, self.p1)


@dataclass(slots=True)
class Scene:
    segments: list[Segment] = field(default_factory=list)  # solid, not part of any round shape
    dashed: list[Segment] = field(default_factory=list)
    circles: list[Circle] = field(default_factory=list)
    arcs: list[Arc] = field(default_factory=list)
    arrows: list[Arrow] = field(default_factory=list)
    dots: list[Dot] = field(default_factory=list)
    truncated: bool = False
    _runs: list[LineRun] | None = None

    @property
    def runs(self) -> list[LineRun]:
        if self._runs is None:
            self._runs = merge_runs(self.segments)
        return self._runs


def extract_scene(page: pymupdf.Page) -> Scene:
    """Primitives of one page. Coordinates are PyMuPDF page space, like the text boxes."""
    scene = Scene()
    drawings = page.get_drawings()
    if len(drawings) > MAX_PATHS:
        scene.truncated = True
        return scene
    total = 0
    for index, path in enumerate(drawings):
        kind = path.get("type")
        filled = kind in ("f", "fs")
        stroked = kind in ("s", "fs")
        if not (filled or stroked):
            continue
        dashed = _is_dashed(path.get("dashes"))
        for chain in _chains(path):
            total += max(len(chain) - 1, 0)
            if total > MAX_SEGMENTS:
                scene.truncated = True
                return scene
            _read_chain(scene, chain, index, filled=filled, stroked=stroked, dashed=dashed)
    return scene


def _is_dashed(dashes: object) -> bool:
    if not isinstance(dashes, str):
        return False
    inner = dashes.split("]")[0].lstrip("[ ").strip()
    return inner != ""


def _chains(path: dict[str, Any]) -> list[list[Point]]:
    """The path's items as chains of points; items that meet continue the same chain."""
    chains: list[list[Point]] = []
    current: list[Point] = []

    def push(points: Sequence[Point]) -> None:
        nonlocal current
        if current and math.dist(current[-1], points[0]) <= JOIN_TOL:
            current.extend(points[1:])
        else:
            if len(current) >= 2:
                chains.append(current)
            current = list(points)

    for item in path["items"]:
        op = item[0]
        if op == "l":
            push([(item[1].x, item[1].y), (item[2].x, item[2].y)])
        elif op == "c":
            push(_bezier(item[1], item[2], item[3], item[4]))
        elif op == "re":
            r = item[1]
            push([(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1), (r.x0, r.y0)])
        elif op == "qu":
            q = item[1]
            pts = [(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y), (q.ll.x, q.ll.y)]
            push([*pts, pts[0]])
    if len(current) >= 2:
        chains.append(current)
    if path.get("closePath") and chains and chains[-1][0] != chains[-1][-1]:
        chains[-1].append(chains[-1][0])
    return chains


def _bezier(p0: Any, c0: Any, c1: Any, p1: Any, steps: int = 12) -> list[Point]:
    out: list[Point] = []
    for i in range(steps + 1):
        t = i / steps
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t**2, t**3
        out.append(
            (
                a * p0.x + b * c0.x + c * c1.x + d * p1.x,
                a * p0.y + b * c0.y + c * c1.y + d * p1.y,
            )
        )
    return out


def _read_chain(
    scene: Scene, chain: list[Point], path: int, *, filled: bool, stroked: bool, dashed: bool
) -> None:
    if (
        filled
        and len(chain) >= 3
        and chain[0] != chain[-1]
        and math.dist(chain[0], chain[-1]) > JOIN_TOL
    ):
        chain = [*chain, chain[0]]  # a fill closes its outline
    consumed = [False] * (len(chain) - 1)  # segment i joins chain[i] and chain[i+1]
    closed = len(chain) > 3 and math.dist(chain[0], chain[-1]) <= JOIN_TOL

    # Whole-chain circle: many short segments around one centre. A fill may end with an
    # extra point or two (the centre, the start); those are tried without.
    if (closed or filled) and len(chain) >= 9:
        for end in (len(chain) - 1, len(chain) - 2):
            pts = chain[:end]
            fit = _fit_circle(pts)
            if (
                fit is not None
                and _all_turn_same_way(pts)
                and _total_turn(pts) >= 2 * math.pi - 0.6
            ):
                cx, cy, r = fit
                if filled and r <= DOT_MAX_RADIUS:
                    scene.dots.append(Dot(cx, cy, r, path))
                elif stroked:
                    scene.circles.append(Circle(cx, cy, r, path))
                return

    # Arrowheads: a small closed triangle, alone or inside a longer chain.
    for k in range(len(chain) - 3):
        if math.dist(chain[k], chain[k + 3]) <= JOIN_TOL and not any(consumed[k : k + 3]):
            arrow = _triangle_arrow(chain[k], chain[k + 1], chain[k + 2], path)
            if arrow is not None:
                scene.arrows.append(arrow)
                for i in range(k, k + 3):
                    consumed[i] = True

    # Arcs approximated by short segments.
    for i0, i1, fit in _arc_runs(chain, consumed):
        cx, cy, r = fit
        a0 = math.atan2(chain[i0][1] - cy, chain[i0][0] - cx)
        a1 = math.atan2(chain[i1][1] - cy, chain[i1][0] - cx)
        sign = _turn_sign(chain, i0, i1)
        sweep = (a1 - a0) * sign
        sweep %= 2 * math.pi
        sweep *= sign
        if abs(sweep) < 1e-6:
            continue
        if abs(sweep) >= 2 * math.pi - 0.15 and stroked:  # an almost closed round stroke
            scene.circles.append(Circle(cx, cy, r, path))
            for i in range(i0, i1):
                consumed[i] = True
            continue
        scene.arcs.append(Arc(cx, cy, r, a0, sweep, chain[i0], chain[i1], path))
        for i in range(i0, i1):
            consumed[i] = True

    # Open V arrows (two short, equal, sharply joined strokes).
    for k in range(len(chain) - 2):
        if consumed[k] or consumed[k + 1]:
            continue
        arrow = _v_arrow(chain[k], chain[k + 1], chain[k + 2], path)
        if arrow is not None:
            scene.arrows.append(arrow)

    if not stroked:
        return
    for i, used in enumerate(consumed):
        if not used and math.dist(chain[i], chain[i + 1]) > JOIN_TOL:
            segment = Segment(chain[i], chain[i + 1], path, dashed)
            (scene.dashed if dashed else scene.segments).append(segment)


def _all_turn_same_way(chain: Sequence[Point]) -> bool:
    signs = set()
    for i in range(1, len(chain) - 1):
        t = _turn(chain[i - 1], chain[i], chain[i + 1])
        if abs(t) > MAX_ARC_TURN:
            return False
        if abs(t) > 1e-6:  # rounding can make one vertex look straight
            signs.add(t > 0)
    return len(signs) == 1


def _total_turn(chain: Sequence[Point]) -> float:
    """Direction change along an open chain, plus one step for the segment count."""
    turns = [abs(_turn(chain[i - 1], chain[i], chain[i + 1])) for i in range(1, len(chain) - 1)]
    return sum(turns) + (sum(turns) / len(turns) if turns else 0.0)


def _turn(a: Point, b: Point, c: Point) -> float:
    a1 = math.atan2(b[1] - a[1], b[0] - a[0])
    a2 = math.atan2(c[1] - b[1], c[0] - b[0])
    return (a2 - a1 + math.pi) % (2 * math.pi) - math.pi


def _turn_sign(chain: Sequence[Point], i0: int, i1: int) -> int:
    total = sum(_turn(chain[i - 1], chain[i], chain[i + 1]) for i in range(i0 + 1, i1))
    return 1 if total >= 0 else -1


def _arc_runs(
    chain: Sequence[Point], consumed: Sequence[bool]
) -> Iterable[tuple[int, int, tuple[float, float, float]]]:
    """Maximal runs of vertices turning the same, modest, steady amount, fitted to a circle."""
    n = len(chain)
    i = 1
    while i < n - 1:
        start = i
        sign = 0
        steps: list[float] = []
        while i < n - 1:
            t = _turn(chain[i - 1], chain[i], chain[i + 1])
            seg_ratio = _ratio(chain[i - 1], chain[i], chain[i + 1])
            ok = (
                0.01 < abs(t) <= MAX_ARC_TURN
                and (sign == 0 or (t > 0) == (sign > 0))
                and 0.5 <= seg_ratio <= 2.0
                and not consumed[i - 1]
                and not consumed[i]
                and (not steps or 0.4 <= abs(t) / (sum(map(abs, steps)) / len(steps)) <= 2.5)
            )
            if not ok:
                break
            sign = 1 if t > 0 else -1
            steps.append(t)
            i += 1
        if len(steps) >= MIN_ARC_TURNS:
            i0, i1 = start - 1, i + 1 - 1
            fit = _fit_circle(list(chain[i0 : i1 + 1]))
            if fit is not None:
                yield i0, i1, fit
        if i == start:
            i += 1


def _ratio(a: Point, b: Point, c: Point) -> float:
    d1, d2 = math.dist(a, b), math.dist(b, c)
    return d2 / d1 if d1 > 0 else math.inf


def _fit_circle(points: Sequence[Point]) -> tuple[float, float, float] | None:
    """Least-squares circle (Kasa fit), accepted only if every point is on it."""
    n = len(points)
    if n < 4:
        return None
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    suu = svv = suv = suuu = svvv = suvv = svuu = 0.0
    for x, y in points:
        u, v = x - mx, y - my
        suu += u * u
        svv += v * v
        suv += u * v
        suuu += u**3
        svvv += v**3
        suvv += u * v * v
        svuu += v * u * u
    det = suu * svv - suv * suv
    if abs(det) < 1e-12:
        return None
    uc = (svv * (suuu + suvv) - suv * (svvv + svuu)) / (2 * det)
    vc = (suu * (svvv + svuu) - suv * (suuu + suvv)) / (2 * det)
    cx, cy = mx + uc, my + vc
    radii = [math.hypot(x - cx, y - cy) for x, y in points]
    r = sum(radii) / n
    if r < 0.4 or r > 5000:
        return None
    tol = max(0.05, 0.01 * r)
    if max(abs(x - r) for x in radii) > tol:
        return None
    return cx, cy, r


def _triangle_arrow(a: Point, b: Point, c: Point, path: int) -> Arrow | None:
    sides = {"ab": math.dist(a, b), "bc": math.dist(b, c), "ca": math.dist(c, a)}
    if max(sides.values()) > ARROW_MAX_SIDE or min(sides.values()) < ARROW_MIN_SIDE:
        return None
    # The tip is the vertex where the two (nearly) equal long sides meet.
    for tip, p, q, s1, s2, base in (
        (a, b, c, sides["ab"], sides["ca"], sides["bc"]),
        (b, a, c, sides["ab"], sides["bc"], sides["ca"]),
        (c, a, b, sides["ca"], sides["bc"], sides["ab"]),
    ):
        if abs(s1 - s2) <= 0.15 * max(s1, s2) and base <= 0.8 * min(s1, s2):
            mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
            length = math.dist(mid, tip)
            if length < ARROW_MIN_SIDE:
                return None
            direction = ((tip[0] - mid[0]) / length, (tip[1] - mid[1]) / length)
            return Arrow(tip, mid, direction, length, "triangle", path)
    return None


def _v_arrow(a: Point, tip: Point, c: Point, path: int) -> Arrow | None:
    d1, d2 = math.dist(a, tip), math.dist(c, tip)
    if not (3.0 <= d1 <= 25.0 and 3.0 <= d2 <= 25.0) or abs(d1 - d2) > 0.25 * max(d1, d2):
        return None
    v1 = ((a[0] - tip[0]) / d1, (a[1] - tip[1]) / d1)
    v2 = ((c[0] - tip[0]) / d2, (c[1] - tip[1]) / d2)
    angle = math.acos(max(-1.0, min(1.0, v1[0] * v2[0] + v1[1] * v2[1])))
    if not math.radians(8) <= angle <= math.radians(60):
        return None
    mid = ((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)
    length = math.dist(mid, tip)
    if length < ARROW_MIN_SIDE:
        return None
    return Arrow(
        tip, mid, ((tip[0] - mid[0]) / length, (tip[1] - mid[1]) / length), length, "v", path
    )


def merge_runs(segments: Sequence[Segment]) -> list[LineRun]:
    """Merge collinear segments that touch or overlap into straight runs."""
    items = []
    for s in segments:
        if s.length <= JOIN_TOL:
            continue
        dx, dy = s.p1[0] - s.p0[0], s.p1[1] - s.p0[1]
        angle = math.atan2(dy, dx) % math.pi
        if angle > math.pi - 1e-9:
            angle = 0.0
        items.append((angle, s))
    items.sort(key=lambda it: it[0])
    runs: list[LineRun] = []
    group: list[tuple[float, Segment]] = []
    for item in items:
        if group and item[0] - group[0][0] > RUN_ANGLE_TOL:
            runs.extend(_merge_angle_group(group))
            group = []
        group.append(item)
    if group:
        runs.extend(_merge_angle_group(group))
    return runs


_Row = tuple[float, float, float, Segment]  # offset, start and end along the run, segment


def _merge_angle_group(group: Sequence[tuple[float, Segment]]) -> list[LineRun]:
    angle = group[0][0]
    ux, uy = math.cos(angle), math.sin(angle)
    nx, ny = -uy, ux
    rows = []
    for _, s in group:
        offset = s.p0[0] * nx + s.p0[1] * ny
        a0 = s.p0[0] * ux + s.p0[1] * uy
        a1 = s.p1[0] * ux + s.p1[1] * uy
        rows.append((offset, min(a0, a1), max(a0, a1), s))
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    runs: list[LineRun] = []
    batch: list[_Row] = []
    for row in rows:
        if batch and row[0] - batch[0][0] > RUN_OFFSET_TOL:
            runs.extend(_merge_intervals(batch, ux, uy, nx, ny))
            batch = []
        batch.append(row)
    if batch:
        runs.extend(_merge_intervals(batch, ux, uy, nx, ny))
    return runs


def _merge_intervals(
    batch: list[_Row], ux: float, uy: float, nx: float, ny: float
) -> list[LineRun]:
    offset = sum(b[0] for b in batch) / len(batch)
    batch = sorted(batch, key=lambda b: b[1])
    runs: list[LineRun] = []
    lo, hi, members = batch[0][1], batch[0][2], [batch[0][3]]
    for _, a0, a1, seg in batch[1:]:
        if a0 <= hi + JOIN_TOL:
            hi = max(hi, a1)
            members.append(seg)
        else:
            runs.append(_run(lo, hi, offset, ux, uy, nx, ny, members))
            lo, hi, members = a0, a1, [seg]
    runs.append(_run(lo, hi, offset, ux, uy, nx, ny, members))
    return runs


def _run(
    lo: float,
    hi: float,
    offset: float,
    ux: float,
    uy: float,
    nx: float,
    ny: float,
    members: list[Segment],
) -> LineRun:
    p0 = (lo * ux + offset * nx, lo * uy + offset * ny)
    p1 = (hi * ux + offset * nx, hi * uy + offset * ny)
    return LineRun(p0, p1, (ux, uy), len(members), tuple(members))


def point_to_segment(p: Point, a: Point, b: Point) -> float:
    """Distance from a point to the finite segment ``a``-``b``."""
    abx, aby = b[0] - a[0], b[1] - a[1]
    length2 = abx * abx + aby * aby
    if length2 == 0:
        return math.dist(p, a)
    t = max(0.0, min(1.0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / length2))
    return math.dist(p, (a[0] + t * abx, a[1] + t * aby))


def point_to_line(p: Point, a: Point, b: Point) -> float:
    """Distance from a point to the infinite line through ``a`` and ``b``."""
    abx, aby = b[0] - a[0], b[1] - a[1]
    length = math.hypot(abx, aby)
    if length == 0:
        return math.dist(p, a)
    return abs((p[0] - a[0]) * aby - (p[1] - a[1]) * abx) / length
