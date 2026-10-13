# ruff: noqa: RUF001
"""Stacked tolerances printed as separate lines beside a value (CAD-2B.2).

CAD drawings often print ``3.7`` with a smaller ``+0`` above and ``-0.2`` below it, as three
text lines. A value with no tolerance of its own takes the two fragments only when the
layout is unambiguous: exactly two fragment lines, to its right and close, one above and
one below its centre, left-aligned, and nothing else in the area. Anything else leaves the
original annotations as they were (the fragments stay ambiguous observations).

Geometry is in displayed space, so cropped and rotated pages behave alike. The value line
stays verbatim in ``source``; the two fragment lines stay verbatim in ``tolerance_parts``.
Units are never taken from the fragments: the value's own unit applies.
"""

import re
from collections.abc import Callable, Sequence
from decimal import Decimal

from blueprintiq.domain.geometry import ViewerRect, page_to_viewer
from blueprintiq.domain.models import (
    CadAnnotation,
    CadKind,
    ExtractionStatus,
    PageInfo,
    TextLine,
)

_MINUS = "-−"
_NUM = r"(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,4})?"
_UPPER = re.compile(rf"\+{_NUM}")
_LOWER = re.compile(rf"[{_MINUS}]{_NUM}")
# Reach of a tolerance, in heights of the value's line.
MAX_GAP = 1.5  # from the value's right edge to the fragments' left edge
MAX_BAND = 1.2  # a fragment's centre from the value's centre
MAX_SPREAD = 1.6  # upper centre to lower centre
SYMMETRY = 0.5  # how unequal the distances above and below may be
ALIGN = 0.6  # left edges, in fragment heights

type _Rect = Callable[[TextLine | CadAnnotation], ViewerRect | None]


def reconstruct_stacked(
    annotations: Sequence[CadAnnotation], lines: Sequence[TextLine], pages: Sequence[PageInfo]
) -> tuple[CadAnnotation, ...]:
    """The annotations with each reliable stack merged into its value; ids renumbered."""
    by_page = {p.page_number: p for p in pages}

    def rect(owner: TextLine | CadAnnotation) -> ViewerRect | None:
        box = owner.source.bbox if isinstance(owner, CadAnnotation) else owner.bbox
        number = owner.source.page_number if isinstance(owner, CadAnnotation) else owner.page_number
        if box is None or number not in by_page:
            return None
        return page_to_viewer(box, by_page[number])

    values = [a for a in annotations if _is_plain_value(a) and rect(a) is not None]
    fragments = [a for a in annotations if _fragment_kind(a) is not None and rect(a) is not None]
    if not values or len(fragments) < 2:
        return _renumber(annotations)

    found: dict[str, tuple[CadAnnotation, CadAnnotation]] = {}
    claims: dict[str, int] = {}
    for value in values:
        pair = _stack_for(value, fragments, lines, rect)
        if pair is not None:
            found[value.id] = pair
            for fragment in pair:
                claims[fragment.id] = claims.get(fragment.id, 0) + 1
    # A fragment that fits two values belongs to neither.
    found = {k: p for k, p in found.items() if all(claims[f.id] == 1 for f in p)}

    consumed = {f.id for pair in found.values() for f in pair}
    merged: list[CadAnnotation] = []
    for a in annotations:
        if a.id in consumed:
            continue
        if a.id in found:
            upper, lower = found[a.id]
            a = a.model_copy(
                update={
                    "upper_deviation": _signed(upper.source.raw_text),
                    "lower_deviation": _signed(lower.source.raw_text),
                    "tolerance_source": "stacked",
                    "tolerance_parts": (upper.source, lower.source),
                }
            )
        merged.append(a)
    return _renumber(merged)


def _is_plain_value(a: CadAnnotation) -> bool:
    return (
        a.status is ExtractionStatus.PARSED
        and a.dimension_kind in (CadKind.LINEAR, CadKind.DIAMETER, CadKind.RADIUS)
        and a.upper_deviation is None
        and a.unit is not None
    )


def _fragment_kind(a: CadAnnotation) -> str | None:
    """'upper', 'lower' or 'zero' for an unread short number line; None otherwise."""
    if a.status is not ExtractionStatus.AMBIGUOUS or a.dimension_kind is not None:
        return None
    text = a.source.raw_text.strip()
    if text == "0":
        return "zero"
    if _UPPER.fullmatch(text):
        return "upper"
    if _LOWER.fullmatch(text):
        return "lower"
    return None


def _signed(text: str) -> Decimal:
    return Decimal(text.strip().replace("−", "-"))


def _stack_for(
    value: CadAnnotation,
    fragments: Sequence[CadAnnotation],
    lines: Sequence[TextLine],
    rect: _Rect,
) -> tuple[CadAnnotation, CadAnnotation] | None:
    v = rect(value)
    assert v is not None
    height = v.bottom - v.top
    centre = (v.top + v.bottom) / 2

    near: list[tuple[CadAnnotation, ViewerRect]] = []
    for f in fragments:
        r = rect(f)
        assert r is not None
        if f.source.page_number != value.source.page_number:
            continue
        gap = r.left - v.right
        offset = abs((r.top + r.bottom) / 2 - centre)
        if -1.0 <= gap <= MAX_GAP * height and offset <= MAX_BAND * height:
            near.append((f, r))
    if len(near) != 2:
        return None
    (a, ra), (b, rb) = sorted(near, key=lambda item: item[1].top + item[1].bottom)
    ca, cb = (ra.top + ra.bottom) / 2, (rb.top + rb.bottom) / 2
    if not (ca < centre < cb):
        return None
    if cb - ca > MAX_SPREAD * height or abs((centre - ca) - (cb - centre)) > SYMMETRY * height:
        return None
    small = min(ra.bottom - ra.top, rb.bottom - rb.top)
    if abs(ra.left - rb.left) > ALIGN * small:
        return None
    kind_a, kind_b = _fragment_kind(a), _fragment_kind(b)
    if kind_a not in ("upper", "zero") or kind_b not in ("lower", "zero"):
        return None
    if kind_a == "zero" and kind_b == "zero":
        return None  # no tolerance at all: nothing to say
    if _has_competitor(value, (a, b), (v, ra, rb), lines, rect):
        return None
    return a, b


def _has_competitor(
    value: CadAnnotation,
    pair: tuple[CadAnnotation, CadAnnotation],
    rects: tuple[ViewerRect, ViewerRect, ViewerRect],
    lines: Sequence[TextLine],
    rect: _Rect,
) -> bool:
    """Any other text in the area where the stack sits."""
    v, ra, rb = rects
    height = v.bottom - v.top
    centre = (v.top + v.bottom) / 2
    left = v.right - 1.0
    right = max(ra.right, rb.right) + MAX_GAP * height
    top, bottom = centre - MAX_BAND * height, centre + MAX_BAND * height
    skip = {(x.source.page_number, x.source.bbox) for x in (value, *pair)}
    for line in lines:
        if line.bbox is None or (line.page_number, line.bbox) in skip:
            continue
        if line.page_number != value.source.page_number:
            continue
        r = rect(line)
        if (
            r is not None
            and r.left < right
            and r.right > left
            and r.top < bottom
            and r.bottom > top
        ):
            return True
    return False


def _renumber(annotations: Sequence[CadAnnotation]) -> tuple[CadAnnotation, ...]:
    return tuple(a.model_copy(update={"id": f"C{i}"}) for i, a in enumerate(annotations, start=1))
