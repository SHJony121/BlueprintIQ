"""Deterministic parser for explicitly labeled drawing annotations (Phase 1 grammar).

Input is engine-neutral :class:`TextLine` objects. This module never touches a PDF.
Output is typed measurements carrying the untouched raw text and the line's
evidence; nothing is inferred, rounded, or given a confidence score.

Grammar (documented in docs/design/phase1-mvp-spec.md, section 8.1 and section 14)::

    line       := LABEL sp* ":" rest              (the line must START with the label)
    LABEL      := THICKNESS | DIAMETER | LENGTH | MATERIAL   (ASCII, case-insensitive)
    dimension  := NUMBER sp* UNIT                 NUMBER := [0-9]+ ("." [0-9]+)?
    UNIT       := mm | MM | cm | CM | m | in | IN   (strict; "M", "Mm" are ambiguous)
    material   := token (" " token)*              token  := [A-Za-z0-9][A-Za-z0-9.-]*

Classification of a line:

* Supported label, value fits the grammar          -> parsed measurement.
* Supported label, value does not fit              -> ambiguous measurement + issue code.
* Supported label behind a prefix with no letters  -> ambiguous (``unsupported_syntax``),
  e.g. ``- THICKNESS: 4 mm`` or a full-width colon, so it is flagged, never dropped.
* Supported label whose value contains another    -> every label on the line becomes
  supported ``LABEL:``                               ambiguous (``unsupported_syntax``).
* Any line: each further supported ``LABEL:`` after the first label also becomes an
  ambiguous measurement (annotations merged onto one line never disappear).
* Any other ``LABEL:`` line (``MIN THICKNESS:``)   -> unrecognized annotation, so
  specification limits are never mistaken for measured values.
* No leading label, but a supported ``LABEL:`` later -> ambiguous (``2X DIAMETER: 10 mm``).
* Anything else                                    -> ignored.
* Overlong lines or invalid Unicode text           -> counted in ``skipped_lines``.

Duplicate or conflicting annotations are all returned as separate measurements;
deciding what they mean is the rule engine's job.
"""

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal

from blueprintiq.domain.models import (
    DimensionMeasurement,
    DimensionType,
    ExtractionIssue,
    ExtractionMethod,
    ExtractionStatus,
    MaterialAnnotation,
    Measurement,
    SourceEvidence,
    TextLine,
    UnrecognizedAnnotation,
)
from blueprintiq.domain.units import (
    AmbiguousUnitCaseError,
    LengthUnit,
    UnsupportedUnitError,
    parse_unit,
    to_mm,
)

# Same limit as SourceEvidence.raw_text. Longer lines are counted, never truncated.
MAX_LINE_LENGTH = 500
# Longest written number accepted. Leaves headroom for unit conversion within the
# model's 30-digit limit for normalized values.
MAX_NUMBER_DIGITS = 20
MAX_MATERIAL_LENGTH = 64

_DIMENSION_LABELS = {
    "THICKNESS": DimensionType.THICKNESS,
    "DIAMETER": DimensionType.DIAMETER,
    "LENGTH": DimensionType.LENGTH,
}
_MATERIAL_LABEL = "MATERIAL"

# Strict form: the line starts with an ASCII label directly followed by ":".
_LABEL = re.compile(r"[ \t]*(?P<label>[A-Za-z][A-Za-z0-9 ()./_-]{0,39}?)[ \t]*:")
# The material label as a title block may print it: English, French, or both on one line.
# Same line only; the value must follow the colon. It is read exactly as "MATERIAL:".
_MATERIAL_ALIAS = re.compile(
    r"[ 	]*(?:MATERIAL[ 	]*/[ 	]*MATI[EÈè]RE"
    r"|MATI[EÈè]RE(?:[ 	]*/[ 	]*MATERIAL)?|MAT[EÉé]RIAL)[ 	]*:",
    re.IGNORECASE | re.ASCII,  # ASCII-only folding, as for the labels above
)
# Near miss: a supported label preceded only by non-letters (bullets, numbering,
# brackets) and/or followed by a colon look-alike. Matched on NFKC-normalized text
# with all invisible format characters removed. ASCII-only case folding.
_NEAR_MISS = re.compile(
    r"(?P<prefix>.*?)\b(?P<label>THICKNESS|DIAMETER|LENGTH|MATERIAL)\s*[:\u2236\ua789]",
    re.IGNORECASE | re.ASCII | re.DOTALL,
)
# A second supported label inside the value of a supported label: two annotations
# that sit too close together to be separated geometrically (see text_layer).
_EMBEDDED_LABEL = re.compile(
    # Word-bounded, so WAVELENGTH: or SHEETTHICKNESS: are not labels. A label may
    # still directly follow a value: with gaps under ~0.15 em MuPDF inserts no
    # space ("4 mmLENGTH:"), so a preceding digit or unit is allowed.
    r"(?:(?<![A-Za-z])|(?<=[0-9]m)|(?<=mm)|(?<=cm)|(?<=in)|(?<=MM)|(?<=CM)|(?<=IN))"
    r"(?P<label>THICKNESS|DIAMETER|LENGTH|MATERIAL)[ \t]*:",
    re.IGNORECASE | re.ASCII,
)

_VALUE_SPACES = " \u00a0"  # the only whitespace allowed inside a value
_SPACE = "[ \u00a0]*"
_UNIT_TEXT = r"(?P<unit>[^\s0-9.,+\-\u00b1]+)"
_DIMENSION = re.compile(rf"(?P<number>[0-9]+(?:\.[0-9]+)?){_SPACE}{_UNIT_TEXT}?")
_DECIMAL_COMMA = re.compile(rf"[0-9]+(?:,[0-9]+)+{_SPACE}{_UNIT_TEXT}?")
_TOLERANCE_MARKERS = ("\u00b1", "+/-", "+-")
# Text that looks like a unit symbol. Anything else after a number is a syntax problem.
_UNIT_LIKE = re.compile("[A-Za-z\u00b5\u03bc\"']{1,6}")
_QUALIFIERS = frozenset(
    {
        "MIN", "MAX", "MINIMUM", "MAXIMUM", "NOM", "NOMINAL", "TYP", "TYPICAL",
        "REF", "REFERENCE", "APPROX", "THK", "THICK", "DIA",
    }
)  # fmt: skip

_MATERIAL = re.compile(r"[A-Za-z0-9][A-Za-z0-9.\-]*(?: [A-Za-z0-9][A-Za-z0-9.\-]*)*")
_WORD_SPLIT = re.compile(r"[ .\-]+")
# Whole values (compared with ".", "-" and spaces removed) meaning "no material given".
_MATERIAL_PLACEHOLDERS = frozenset({"", "?", "N/A", "NA", "NS", "NONE", "TBD", "TBA", "TBC"})
# Words that mean "no material given", wherever they appear in the value.
_PLACEHOLDER_WORDS = frozenset(
    {"TBD", "TBA", "TBC", "UNKNOWN", "UNK", "NIL", "NONE", "ANY", "UNSPECIFIED",
     "SPECIFIED", "DETERMINED", "CONFIRMED", "ADVISED", "APPLICABLE", "PENDING",
     "VARIOUS"}
)  # fmt: skip
# Words that make the value a reference, a choice, or an approximation.
_INDIRECT_WORDS = frozenset(
    {
        "SEE", "PER", "NOTE", "NOTES", "REF", "REFER",
        "OR", "AND", "EITHER", "ALT", "ALTERNATIVE", "OPTION", "OPTIONAL",
        "EQ", "EQUIV", "EQUIVALENT", "EQUIVALENTS", "SIM", "SIMILAR", "TYP", "TYPICAL",
        "SAME", "AS", "BY", "SUPPLIED", "APPROX", "APPROXIMATE", "SUBSTITUTE",
        "ALTERNATE", "PREFERRED", "VS", "MIN", "MAX", "BETTER",
    }
)  # fmt: skip


@dataclass(frozen=True, slots=True)
class ParsedAnnotations:
    measurements: tuple[Measurement, ...]
    unrecognized: tuple[UnrecognizedAnnotation, ...]
    skipped_lines: int  # overlong or not valid Unicode text; never truncated or repaired


def parse_lines(lines: Iterable[TextLine], *, method: ExtractionMethod) -> ParsedAnnotations:
    """Parse text lines in the given order. Measurement ids are ``M1``, ``M2``, ... ."""
    measurements: list[Measurement] = []
    unrecognized: list[UnrecognizedAnnotation] = []
    skipped = 0

    for line in lines:
        if len(line.text) > MAX_LINE_LENGTH or not _is_valid_unicode(line.text):
            skipped += 1
            continue

        text = _strip_leading_format_chars(line.text)
        alias = _MATERIAL_ALIAS.match(text)
        if alias is not None:
            text = "MATERIAL:" + text[alias.end() :]
        measurement_id = f"M{len(measurements) + 1}"

        match = _LABEL.match(text)
        if match is not None:
            label = " ".join(match["label"].upper().split())
            rest = text[match.end() :]
            embedded = _embedded_labels(rest)
            supported = label in _DIMENSION_LABELS or label == _MATERIAL_LABEL
            if not supported:
                unrecognized.append(
                    UnrecognizedAnnotation(label=label, source=_evidence(line, method))
                )
                # A supported annotation merged onto this line stays visible.
                for each in embedded:
                    measurements.append(
                        _unsupported_form(
                            f"M{len(measurements) + 1}", each, _evidence(line, method)
                        )
                    )
            elif embedded:
                # Several annotations on one line: flag every one, guess none.
                for each in (label, *embedded):
                    measurements.append(
                        _unsupported_form(
                            f"M{len(measurements) + 1}", each, _evidence(line, method)
                        )
                    )
            elif label in _DIMENSION_LABELS:
                measurements.append(
                    _parse_dimension(
                        measurement_id, _DIMENSION_LABELS[label], rest, _evidence(line, method)
                    )
                )
            else:
                measurements.append(_parse_material(measurement_id, rest, _evidence(line, method)))
            continue

        near_miss = _near_miss_label(text)
        if near_miss is not None:
            first, after = near_miss
            labels = [first, *_embedded_labels(after)]
        else:
            # No leading label at all (e.g. "2X DIAMETER: 10 mm"): any supported
            # LABEL: on the line is still flagged, never silently dropped.
            labels = _embedded_labels(text)
        for each in labels:
            measurements.append(
                _unsupported_form(f"M{len(measurements) + 1}", each, _evidence(line, method))
            )

    return ParsedAnnotations(tuple(measurements), tuple(unrecognized), skipped)


def _embedded_labels(rest: str) -> list[str]:
    """Supported ``LABEL:`` occurrences after a line's first label, in order."""
    return [m["label"].upper() for m in _EMBEDDED_LABEL.finditer(rest)]


def _evidence(line: TextLine, method: ExtractionMethod) -> SourceEvidence:
    return SourceEvidence(
        page_number=line.page_number,
        bbox=line.bbox,
        raw_text=line.text,
        extraction_method=method,
    )


def _is_valid_unicode(text: str) -> bool:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:  # e.g. lone surrogates
        return False
    return True


def _strip_leading_format_chars(text: str) -> str:
    """Drop invisible format characters (BOM, zero-width space) at the start of a line."""
    start = 0
    while start < len(text) and unicodedata.category(text[start]) == "Cf":
        start += 1
    return text[start:]


def _near_miss_label(text: str) -> tuple[str, str] | None:
    """The supported label of a near-miss line, and the normalized text after it."""
    visible = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    normalized = unicodedata.normalize("NFKC", visible)
    match = _NEAR_MISS.match(normalized)
    if match is None or any(ch.isalpha() for ch in match["prefix"]):
        return None
    label = match["label"].upper()
    if label not in _DIMENSION_LABELS and label != _MATERIAL_LABEL:
        return None
    return label, normalized[match.end() :]


def _has_control_chars(text: str) -> bool:
    return any(not ch.isprintable() and ch not in " \u00a0" for ch in text)


def _unsupported_form(measurement_id: str, label: str, source: SourceEvidence) -> Measurement:
    if label == _MATERIAL_LABEL:
        return MaterialAnnotation(
            id=measurement_id,
            value=None,
            status=ExtractionStatus.AMBIGUOUS,
            issues=(ExtractionIssue.UNSUPPORTED_SYNTAX,),
            source=source,
        )
    return DimensionMeasurement(
        id=measurement_id,
        dimension_type=_DIMENSION_LABELS[label],
        value=None,
        unit=None,
        normalized_value_mm=None,
        status=ExtractionStatus.AMBIGUOUS,
        issues=(ExtractionIssue.UNSUPPORTED_SYNTAX,),
        source=source,
    )


def _parse_dimension(
    measurement_id: str, dimension_type: DimensionType, rest: str, source: SourceEvidence
) -> DimensionMeasurement:
    def ambiguous(
        issue: ExtractionIssue, value: Decimal | None = None, unit: LengthUnit | None = None
    ) -> DimensionMeasurement:
        return DimensionMeasurement(
            id=measurement_id,
            dimension_type=dimension_type,
            value=value,
            unit=unit,
            normalized_value_mm=None,
            status=ExtractionStatus.AMBIGUOUS,
            issues=(issue,),
            source=source,
        )

    rest = rest.strip(_VALUE_SPACES)
    if not rest:
        return ambiguous(ExtractionIssue.MISSING_VALUE)
    if _has_control_chars(rest) or any(marker in rest for marker in _TOLERANCE_MARKERS):
        return ambiguous(ExtractionIssue.UNSUPPORTED_SYNTAX)

    comma = _DECIMAL_COMMA.fullmatch(rest)
    if comma is not None:
        # "2,5" may mean 2.5 or 25 (thousands separator); refuse to choose.
        return ambiguous(ExtractionIssue.DECIMAL_COMMA, unit=_supported_unit_or_none(comma))

    match = _DIMENSION.fullmatch(rest)
    if match is None or sum(ch.isdigit() for ch in match["number"]) > MAX_NUMBER_DIGITS:
        return ambiguous(ExtractionIssue.UNSUPPORTED_SYNTAX)

    value = Decimal(match["number"])
    unit_text = match["unit"]
    if unit_text is None:
        return ambiguous(ExtractionIssue.MISSING_UNIT, value=value)
    try:
        unit = parse_unit(unit_text)
    except AmbiguousUnitCaseError:
        # e.g. "4 M" or "4 Mm": keep the number, never convert it.
        return ambiguous(ExtractionIssue.AMBIGUOUS_UNIT_CASE, value=value)
    except UnsupportedUnitError:
        if _UNIT_LIKE.fullmatch(unit_text) and unit_text.upper() not in _QUALIFIERS:
            return ambiguous(ExtractionIssue.UNSUPPORTED_UNIT, value=value)
        return ambiguous(ExtractionIssue.UNSUPPORTED_SYNTAX)

    return DimensionMeasurement(
        id=measurement_id,
        dimension_type=dimension_type,
        value=value,
        unit=unit,
        normalized_value_mm=to_mm(value, unit),
        status=ExtractionStatus.PARSED,
        source=source,
    )


def _supported_unit_or_none(match: re.Match[str]) -> LengthUnit | None:
    unit_text = match["unit"]
    if unit_text is None:
        return None
    try:
        return parse_unit(unit_text)
    except UnsupportedUnitError:
        return None


def _parse_material(measurement_id: str, rest: str, source: SourceEvidence) -> MaterialAnnotation:
    def ambiguous(issue: ExtractionIssue) -> MaterialAnnotation:
        return MaterialAnnotation(
            id=measurement_id,
            value=None,
            status=ExtractionStatus.AMBIGUOUS,
            issues=(issue,),
            source=source,
        )

    rest = rest.strip(_VALUE_SPACES)
    if _has_control_chars(rest):
        return ambiguous(ExtractionIssue.UNSUPPORTED_SYNTAX)

    text = " ".join(rest.split())
    upper = text.upper()
    words = _material_words(upper)
    compact = re.sub(r"[ .\-]", "", upper)
    if (
        compact in _MATERIAL_PLACEHOLDERS
        or re.fullmatch("X+", compact)
        or words & _PLACEHOLDER_WORDS
    ):
        return ambiguous(ExtractionIssue.MISSING_VALUE)
    if len(text) > MAX_MATERIAL_LENGTH or _MATERIAL.fullmatch(text) is None:
        return ambiguous(ExtractionIssue.UNSUPPORTED_SYNTAX)
    if words & _INDIRECT_WORDS:
        return ambiguous(ExtractionIssue.UNSUPPORTED_SYNTAX)

    return MaterialAnnotation(
        id=measurement_id,
        value=text,
        status=ExtractionStatus.PARSED,
        source=source,
    )


def _material_words(upper: str) -> set[str]:
    """Split on space, '.' and '-', joining runs of single letters ("E.Q." -> "EQ")."""
    words: list[str] = []
    run = ""
    for word in _WORD_SPLIT.split(upper):
        if len(word) == 1 and word.isalpha():
            run += word
            continue
        if run:
            words.append(run)
            run = ""
        if word:
            words.append(word)
    if run:
        words.append(run)
    return set(words)
