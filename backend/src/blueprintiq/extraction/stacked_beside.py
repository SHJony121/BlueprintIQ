"""A stacked tolerance whose lower deviation shares the value's line (CAD-2B.2, layout 2).

Some CAD exports print ``3.7 -0.2`` as one text line, with the upper deviation on a
separate line raised above the lower one and aligned with its digits::

        0
    3.7 -0.2

The text layer reads the first row as a single line, so the three-line rule never sees a
candidate. Here the words of that line come from the PDF's own glyph boxes (never from
string widths), and positions are compared in the line's writing direction, so vertical
text works the same way and page rotation and cropping do not matter.

A value is read only when all of this holds: the line is exactly two words, a plain value
and a lower deviation (``-N`` or ``0``); exactly one separate line of the same writing
direction (``0`` or ``+N``) sits above the lower deviation with its digits starting where
the lower deviation's digits start; nothing else lies in the area; and no other line could
claim the same upper line. Otherwise nothing is merged. A two-word line with a negative
second number that cannot be paired is kept as an ambiguous observation, never as a
parsed dimension.
"""

import re
from collections.abc import Sequence
from decimal import Decimal
from typing import NamedTuple

from blueprintiq.domain.geometry import page_to_viewer
from blueprintiq.domain.models import (
    BBox,
    CadAnnotation,
    CadKind,
    CadUnit,
    ExtractionIssue,
    ExtractionMethod,
    ExtractionStatus,
    PageInfo,
    SourceEvidence,
    TextLine,
    TextWord,
    UnitSource,
)

_MINUS = "-" + chr(0x2212)
_NUM = r"(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,4})?"
_VALUE = re.compile(rf"(?P<sym>[{chr(0xD8)}{chr(0x2300)}R])?(?P<n>{_NUM})")
_LOWER = re.compile(rf"(?:0|[{_MINUS}]{_NUM})")
_UPPER = re.compile(rf"(?:0|\+{_NUM})")
# In heights of the lower deviation's line.
RAISE_MIN = 0.5  # how far above the lower deviation the upper line's centre lies
RAISE_MAX = 1.3
NEARBY = 2.5  # candidates this close are counted, so a second one makes it ambiguous
ALIGN = 0.3  # digit starts, in line heights
MARGIN = 0.3  # free space around the stack
SIDE = 0.5  # free space beyond the line's ends, along the text


class _Frame(NamedTuple):
    """A box in the writing frame: ``along`` the text, ``up`` towards the top of glyphs."""

    a0: float
    a1: float
    u0: float
    u1: float

    @property
    def height(self) -> float:
        return self.u1 - self.u0

    @property
    def centre(self) -> float:
        return (self.u0 + self.u1) / 2


def _frame(box: BBox, writing: tuple[float, float]) -> _Frame:
    dx, dy = writing
    corners = ((box.x0, box.y0), (box.x1, box.y0), (box.x0, box.y1), (box.x1, box.y1))
    along = [dx * x + dy * y for x, y in corners]
    up = [dy * x - dx * y for x, y in corners]  # up = (dy, -dx): left of the reading direction
    return _Frame(min(along), max(along), min(up), max(up))


def reconstruct_stacked_beside(
    annotations: Sequence[CadAnnotation],
    lines: Sequence[TextLine],
    pages: Sequence[PageInfo],
    unit_note: SourceEvidence | None,
) -> tuple[CadAnnotation, ...]:
    """The annotations plus each value found in this layout; ids renumbered in reading order."""
    by_page = {p.page_number: p for p in pages}
    candidates = [
        (line, words)
        for line in lines
        if line.bbox is not None
        and line.page_number in by_page
        and (words := _two_words(line)) is not None
    ]
    if not candidates:
        return tuple(annotations)

    # The upper line each candidate could use, and how many candidates want each upper line.
    chosen: dict[int, TextLine] = {}
    wanted: dict[int, int] = {}
    for index, (line, words) in enumerate(candidates):
        upper = _upper_for(line, words, lines)
        if upper is not None:
            chosen[index] = upper
            wanted[id(upper)] = wanted.get(id(upper), 0) + 1

    added: list[CadAnnotation] = []
    consumed: set[tuple[int, BBox | None]] = set()
    for index, (line, words) in enumerate(candidates):
        upper = chosen.get(index)
        if upper is not None and wanted[id(upper)] == 1 and unit_note is not None:
            made = _build(line, words, upper)
            if made is not None:
                added.append(made)
                consumed.add((upper.page_number, upper.bbox))
                continue
        if _LOWER_NEGATIVE.fullmatch(words[1].text):
            added.append(_suspected(line))

    kept = [a for a in annotations if (a.source.page_number, a.source.bbox) not in consumed]
    merged = sorted(
        [*kept, *added], key=lambda a: _reading_key(a, by_page)
    )  # stable: ties keep their order
    return tuple(a.model_copy(update={"id": f"C{i}"}) for i, a in enumerate(merged, start=1))


_LOWER_NEGATIVE = re.compile(rf"[{_MINUS}]{_NUM}")


def _reading_key(a: CadAnnotation, by_page: dict[int, PageInfo]) -> tuple[int, float, float]:
    box = a.source.bbox
    if box is None or a.source.page_number not in by_page:
        return (a.source.page_number, 0.0, 0.0)
    rect = page_to_viewer(box, by_page[a.source.page_number])
    return (a.source.page_number, round(rect.top, 1), rect.left)


def _two_words(line: TextLine) -> tuple[TextWord, TextWord] | None:
    """The line's two words if they read as a plain value and a lower deviation."""
    if len(line.words) != 2:
        return None
    first, second = line.words
    match = _VALUE.fullmatch(first.text)
    if match is None or not _LOWER.fullmatch(second.text):
        return None
    if match["sym"] is None and len(match["n"].split(".")[0]) > 3:
        return None  # a long bare number is not offered as a dimension (as for lone values)
    return first, second


def _upper_for(
    line: TextLine, words: tuple[TextWord, TextWord], lines: Sequence[TextLine]
) -> TextLine | None:
    """The one line above the lower deviation that fits, or ``None`` if none or not exactly one."""
    assert line.bbox is not None
    low = words[1]
    whole = _frame(line.bbox, line.writing)
    low_digits = _frame(low.number_bbox, line.writing)
    height = whole.height
    near: list[tuple[TextLine, _Frame]] = []
    for other in lines:
        if other is line or other.bbox is None or other.page_number != line.page_number:
            continue
        if other.writing != line.writing:
            continue
        frame = _frame(other.bbox, line.writing)
        lift = frame.centre - whole.centre
        away = abs(frame.a0 - low_digits.a0)
        if 0 < lift <= NEARBY * height and away <= NEARBY * height:
            near.append((other, frame))
    if len(near) != 1:
        return None
    upper, frame = near[0]
    if len(upper.words) != 1 or not _UPPER.fullmatch(upper.words[0].text):
        return None
    lift = (frame.centre - whole.centre) / height
    digits = _frame(upper.words[0].number_bbox, line.writing)
    if not (RAISE_MIN <= lift <= RAISE_MAX):
        return None
    if abs(digits.a0 - low_digits.a0) > ALIGN * height:
        return None
    if upper.words[0].text == "0" and low.text == "0":
        return None  # no tolerance at all
    if _crowded(line, whole, upper, frame, lines):
        return None
    return upper


def _crowded(
    line: TextLine, whole: _Frame, upper: TextLine, frame: _Frame, lines: Sequence[TextLine]
) -> bool:
    """Any other text in the area around the value, the lower deviation and the upper line."""
    height = whole.height
    a0 = min(whole.a0, frame.a0) - SIDE * height
    a1 = max(whole.a1, frame.a1) + SIDE * height
    u0 = min(whole.u0, frame.u0) - MARGIN * height
    u1 = max(whole.u1, frame.u1) + MARGIN * height
    for other in lines:
        if other is line or other is upper or other.bbox is None:
            continue
        if other.page_number != line.page_number:
            continue
        f = _frame(other.bbox, line.writing)
        if f.a0 < a1 and f.a1 > a0 and f.u0 < u1 and f.u1 > u0:
            return True
    return False


def _build(
    line: TextLine, words: tuple[TextWord, TextWord], upper: TextLine
) -> CadAnnotation | None:
    first, second = words
    match = _VALUE.fullmatch(first.text)
    assert match is not None and line.bbox is not None and upper.bbox is not None
    symbol = match["sym"]
    kind = (
        CadKind.LINEAR if symbol is None else CadKind.RADIUS if symbol == "R" else CadKind.DIAMETER
    )
    evidence = ExtractionMethod.PDF_TEXT_LAYER
    return CadAnnotation(
        id="C999999",
        dimension_kind=kind,
        nominal=Decimal(match["n"]),
        upper_deviation=Decimal(upper.text.replace("+", "")),
        lower_deviation=Decimal(second.text.replace(chr(0x2212), "-")),
        unit=CadUnit.MM,
        unit_source=UnitSource.DRAWING_NOTE,
        tolerance_source="stacked",
        tolerance_parts=(
            SourceEvidence(
                page_number=upper.page_number,
                bbox=upper.bbox,
                raw_text=upper.text,
                extraction_method=evidence,
            ),
            SourceEvidence(
                page_number=line.page_number,
                bbox=second.bbox,
                raw_text=second.text,
                extraction_method=evidence,
            ),
        ),
        status=ExtractionStatus.PARSED,
        source=SourceEvidence(
            page_number=line.page_number,
            bbox=first.bbox,
            raw_text=first.text,
            extraction_method=evidence,
        ),
    )


def _suspected(line: TextLine) -> CadAnnotation:
    """A value followed by a negative number that could not be paired: kept, never parsed."""
    return CadAnnotation(
        id="C999999",
        dimension_kind=None,
        nominal=None,
        status=ExtractionStatus.AMBIGUOUS,
        issues=(ExtractionIssue.UNSUPPORTED_SYNTAX,),
        source=SourceEvidence(
            page_number=line.page_number,
            bbox=line.bbox,
            raw_text=line.text,
            extraction_method=ExtractionMethod.PDF_TEXT_LAYER,
        ),
    )
