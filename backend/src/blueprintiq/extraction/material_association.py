"""Material labels whose value is a separate text line on the same row (CAD-2B.1).

A title block often prints ``Matière :`` and ``POM C noir`` as two lines. The label
alone parses as a material with no value. Here the value is attached to it only when
exactly one line sits on the label's row, to its right and close by, and the line reads
as a material. Everything else keeps the label's own "no value" result, which the rule
engine reports as needs review. Same row, to the right, only: nothing below the label,
no stacked fragments, and no joined line is invented. The value stays verbatim in
``source``; the label stays verbatim in ``label_source``.
"""

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass

from blueprintiq.domain.geometry import ViewerRect, page_to_viewer
from blueprintiq.domain.models import (
    ExtractionMethod,
    ExtractionStatus,
    MaterialAnnotation,
    Measurement,
    PageInfo,
    SourceEvidence,
    TextLine,
)
from blueprintiq.extraction.annotation_parser import parse_lines

_NAMES = "MATERIAL|MATIERE"
_LABEL_ONLY = re.compile(rf"(?:{_NAMES})(?:\s*/\s*(?:{_NAMES}))?\s*[:：]", re.ASCII)  # noqa: RUF001
# A candidate row-mate must be near the label: at most this many label heights away.
MAX_GAP_HEIGHTS = 5.0
# Row alignment: centres within this fraction of the smaller of the two heights, and each
# centre inside the other line's vertical extent. Rows of a bilingual block overlap in
# height, so overlap alone never decides.
ROW_TOLERANCE = 0.4
MAX_VALUE_CHARS = 64


@dataclass(frozen=True, slots=True)
class _Item:
    line: TextLine
    rect: ViewerRect

    @property
    def centre(self) -> float:
        return (self.rect.top + self.rect.bottom) / 2

    @property
    def height(self) -> float:
        return self.rect.bottom - self.rect.top


def associate_materials(
    lines: Sequence[TextLine], measurements: tuple[Measurement, ...], pages: Sequence[PageInfo]
) -> tuple[Measurement, ...]:
    """The measurements, with each label-only material given its value when it is clear."""
    by_page = {p.page_number: p for p in pages}
    items = [
        _Item(line, page_to_viewer(line.bbox, by_page[line.page_number]))
        for line in lines
        if line.bbox is not None and line.page_number in by_page
    ]
    labels = [i for i in items if _is_label_only(i.line.text)]
    if not labels:
        return measurements

    # Which labels could each value belong to? A value that fits two labels is nobody's.
    chosen: dict[int, _Item] = {}
    claimed: dict[int, int] = {}
    for index, label in enumerate(labels):
        value = _row_mate(label, items)
        if value is not None:
            chosen[index] = value
            claimed[id(value)] = claimed.get(id(value), 0) + 1

    replacements: dict[int, MaterialAnnotation] = {}
    for index, value in chosen.items():
        if claimed[id(value)] != 1 or _competes(labels, labels[index], value):
            continue
        material = _read_value(value.line)
        if material is None:
            continue
        label_line = labels[index].line
        for position, measurement in enumerate(measurements):
            if _is_empty_label(measurement, label_line):
                replacements[position] = MaterialAnnotation(
                    id=measurement.id,
                    value=material,
                    status=ExtractionStatus.PARSED,
                    source=_evidence(value.line),
                    label_source=measurement.source.model_copy(),
                )
    return tuple(replacements.get(i, m) for i, m in enumerate(measurements))


def _is_label_only(text: str) -> bool:
    folded = unicodedata.normalize("NFKD", text)
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch)).strip().upper()
    return _LABEL_ONLY.fullmatch(folded) is not None


def _is_empty_label(measurement: Measurement, label: TextLine) -> bool:
    return (
        isinstance(measurement, MaterialAnnotation)
        and measurement.status is ExtractionStatus.AMBIGUOUS
        and measurement.source.raw_text == label.text
        and measurement.source.bbox == label.bbox
        and measurement.source.page_number == label.page_number
    )


def _same_row(label: _Item, other: _Item) -> bool:
    """Centres line up closely and each lies inside the other's height."""
    reach = ROW_TOLERANCE * min(label.height, other.height)
    return (
        abs(label.centre - other.centre) <= reach
        and other.rect.top <= label.centre <= other.rect.bottom
        and label.rect.top <= other.centre <= label.rect.bottom
    )


def _right_of(label: _Item, other: _Item) -> bool:
    gap = other.rect.left - label.rect.right
    return -1.0 <= gap <= MAX_GAP_HEIGHTS * label.height


def _row_mate(label: _Item, items: list[_Item]) -> _Item | None:
    """The one line on the label's row, to its right and near. ``None`` if none or several.

    Any second line near on the row (a competing value, or the next field's label) makes
    the answer ambiguous, so it is never picked between.
    """
    mates = [
        i
        for i in items
        if i is not label
        and i.line.page_number == label.line.page_number
        and _same_row(label, i)
        and _right_of(label, i)
    ]
    if len(mates) != 1:
        return None
    return mates[0]


def _competes(labels: list[_Item], label: _Item, value: _Item) -> bool:
    """Another material label that is as good a home for this value."""
    return any(
        other is not label and _same_row(other, value) and _right_of(other, value)
        for other in labels
    )


def _read_value(line: TextLine) -> str | None:
    """The material text if the line reads as one, by the same rules as a labeled line."""
    text = " ".join(line.text.split())
    if (
        not text
        or len(text) > MAX_VALUE_CHARS
        or ":" in text
        or not any(ch.isalpha() for ch in text)
    ):
        return None
    probe = TextLine(text=f"MATERIAL: {text}", page_number=line.page_number, bbox=line.bbox)
    parsed = parse_lines([probe], method=ExtractionMethod.PDF_TEXT_LAYER).measurements
    if len(parsed) != 1:
        return None
    (only,) = parsed
    if not isinstance(only, MaterialAnnotation) or only.status is not ExtractionStatus.PARSED:
        return None
    return only.value


def _evidence(line: TextLine) -> SourceEvidence:
    return SourceEvidence(
        page_number=line.page_number,
        bbox=line.bbox,
        raw_text=line.text,
        extraction_method=ExtractionMethod.PDF_TEXT_LAYER_ROW_ASSOCIATION,
    )
