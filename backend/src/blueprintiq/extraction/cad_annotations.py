# ruff: noqa: RUF001
"""Conventional CAD dimensions and tolerances, read as written (CAD-2A).

Extraction only. A ``CadAnnotation`` is never attached to a physical feature and never
reaches a rule: ``2.7 ±0.1`` is not a thickness, ``16`` is not a length. Only a whole
line that matches a supported form is read; a line with a strong dimension signal that
does not match is kept as an uncertain observation with no values; everything else
(part numbers, dates, revision codes, notes) is left alone. A tolerance on another line
is never joined to a value.
"""

import re
from collections.abc import Iterable
from decimal import Decimal

from blueprintiq.domain.models import (
    CadAnnotation,
    CadKind,
    CadUnit,
    ExtractionIssue,
    ExtractionMethod,
    ExtractionStatus,
    SourceEvidence,
    TextLine,
    UnitSource,
)

_NUM = r"(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,4})?"
_SPACES = "[  ]*"
_MINUS = "[-−]"
_CAD = re.compile(
    rf"(?P<sym>[Ø⌀R])?{_SPACES}(?P<n>{_NUM})(?P<deg>°)?"
    rf"(?:{_SPACES}(?:±{_SPACES}(?P<t>{_NUM})"
    rf"|\+{_SPACES}(?P<up>{_NUM}){_SPACES}/{_SPACES}{_MINUS}{_SPACES}(?P<lo>{_NUM}))"
    rf"{_SPACES}(?P<tdeg>°)?)?{_SPACES}(?P<unit>mm)?"
)
# Strong signals of a CAD annotation that was not read: kept as uncertain, never guessed.
_SIGNAL = re.compile(rf"±|[Ø⌀]{_SPACES}[0-9]|[0-9]{_SPACES}°|^[+−-]{_SPACES}{_NUM}")
_LABEL = re.compile(r"[ \t]*[A-Za-z][A-Za-z0-9 ()./_-]{0,39}?[ \t]*:")
# A drawing-wide unit note, in English or French. Millimetres vs anything else is decided
# per part, so a line that prints both languages ("... / Toutes les dimensions ...") counts
# only when every part says the same thing.
_NOTE = re.compile(
    r"(?:ALL DIMENSIONS (?:ARE )?IN|DIMENSIONS (?:ARE )?IN"
    r"|TOUTES LES (?:DIMENSIONS|COTES) SONT EN|TOUTES LES (?:DIMENSIONS|COTES) EN"
    r"|DIMENSIONS EN|COTES EN) (?P<unit>[A-ZÀ-Ý]+)\.?",
    re.IGNORECASE,
)
_MM_WORDS = frozenset({"MM", "MILLIMETER", "MILLIMETERS", "MILLIMETRE", "MILLIMETRES",
                       "MILLIMÈTRE", "MILLIMÈTRES"})  # fmt: skip
_NOTE_EDGE = " 	•*-–—.:;"
_NOTE_SEPARATORS = re.compile(r"\s*[/|]\s*")
MAX_CAD_ANNOTATIONS = 500


def parse_cad_annotations(
    lines: Iterable[TextLine], *, method: ExtractionMethod = ExtractionMethod.PDF_TEXT_LAYER
) -> tuple[tuple[CadAnnotation, ...], SourceEvidence | None]:
    """The CAD annotations on a page and the drawing-wide millimetre note, if unambiguous."""
    texts = [(line, " ".join(line.text.replace(" ", " ").split())) for line in lines]
    unit_note = _unit_note(texts, method)
    mm_known = unit_note is not None
    found: list[CadAnnotation] = []
    for line, text in texts:
        if not text or _LABEL.match(text) or len(text) > 60:
            continue
        annotation = _read(f"C{len(found) + 1}", line, text, mm_known, method)
        if annotation is not None:
            found.append(annotation)
            if len(found) >= MAX_CAD_ANNOTATIONS:
                break
    return tuple(found), unit_note


def _unit_note(
    texts: list[tuple[TextLine, str]], method: ExtractionMethod
) -> SourceEvidence | None:
    """The drawing-wide "all dimensions are in millimetres" note, if nothing contradicts it.

    Leading bullets or dashes are ignored. Several notes (for example one per language)
    agree only if each of them says millimetres; any other unit, anywhere, means none.
    """
    first: TextLine | None = None
    for line, text in texts:
        verdicts = _note_verdicts(text)
        if verdicts is None:
            continue
        if not all(verdicts):
            return None
        first = first or line
    return _evidence(first, method) if first is not None else None


def _note_verdicts(text: str) -> list[bool] | None:
    """For each part of a line that is a unit note, whether it says millimetres."""
    parts = [p.strip(_NOTE_EDGE).upper() for p in _NOTE_SEPARATORS.split(text)]
    verdicts: list[bool] = []
    for part in parts:
        if not part:
            continue
        match = _NOTE.fullmatch(part)
        if match is None:
            return None  # an ordinary line, not a unit note
        verdicts.append(match["unit"] in _MM_WORDS)
    return verdicts or None


def _read(
    cad_id: str, line: TextLine, text: str, mm_known: bool, method: ExtractionMethod
) -> CadAnnotation | None:
    source = _evidence(line, method)
    match = _CAD.fullmatch(text)
    if match is None:
        if _SIGNAL.search(text):
            return CadAnnotation(
                id=cad_id,
                dimension_kind=None,
                nominal=None,
                status=ExtractionStatus.AMBIGUOUS,
                issues=(ExtractionIssue.UNSUPPORTED_SYNTAX,),
                source=source,
            )
        return None

    symbol, degree, unit_text = match["sym"], match["deg"], match["unit"]
    has_tolerance = match["t"] is not None or match["up"] is not None
    if degree is not None:
        kind = CadKind.ANGLE
        invalid = symbol is not None or unit_text is not None
        invalid = invalid or (has_tolerance and match["tdeg"] is None)
    else:
        kind = {None: CadKind.LINEAR, "R": CadKind.RADIUS}.get(symbol, CadKind.DIAMETER)
        invalid = match["tdeg"] is not None
    if invalid:
        return _uncertain(cad_id, source)

    nominal = Decimal(match["n"])
    if kind is CadKind.LINEAR and not has_tolerance and unit_text is None and nominal == 0:
        # A lone zero is most often a fragment of a stacked tolerance ("+0" over "-0.2"),
        # not a 0 mm dimension. Kept as evidence, with no value.
        return _uncertain(cad_id, source)
    if kind is CadKind.LINEAR and not has_tolerance and not _plausible_bare(match["n"]):
        return None

    if kind is CadKind.ANGLE:
        unit, unit_source = CadUnit.DEG, UnitSource.SYMBOL
    elif unit_text is not None:
        unit, unit_source = CadUnit.MM, UnitSource.ANNOTATION
    elif mm_known:
        unit, unit_source = CadUnit.MM, UnitSource.DRAWING_NOTE
    else:
        unit, unit_source = None, UnitSource.NONE

    if kind is CadKind.LINEAR and not has_tolerance and unit is None:
        return None  # a bare number with no unit evidence is not evidence of a dimension

    upper = lower = None
    if match["t"] is not None:
        upper, lower = Decimal(match["t"]), -Decimal(match["t"])
    elif match["up"] is not None:
        upper, lower = Decimal(match["up"]), -Decimal(match["lo"])
    return CadAnnotation(
        id=cad_id,
        dimension_kind=kind,
        nominal=nominal,
        upper_deviation=upper,
        lower_deviation=lower,
        tolerance_source="inline" if upper is not None else None,
        unit=unit,
        unit_source=unit_source,
        status=ExtractionStatus.PARSED if unit is not None else ExtractionStatus.AMBIGUOUS,
        issues=() if unit is not None else (ExtractionIssue.MISSING_UNIT,),
        source=source,
    )


def _plausible_bare(number: str) -> bool:
    """A bare number is only a dimension candidate if it is short: not a year or part number."""
    whole = number.split(".")[0]
    return len(whole) <= 3


def _uncertain(cad_id: str, source: SourceEvidence) -> CadAnnotation:
    return CadAnnotation(
        id=cad_id,
        dimension_kind=None,
        nominal=None,
        status=ExtractionStatus.AMBIGUOUS,
        issues=(ExtractionIssue.UNSUPPORTED_SYNTAX,),
        source=source,
    )


def _evidence(line: TextLine, method: ExtractionMethod) -> SourceEvidence:
    return SourceEvidence(
        page_number=line.page_number,
        bbox=line.bbox,
        raw_text=line.text,
        extraction_method=method,
    )
