"""CAD-2A: reading conventional dimensions as written, and refusing to guess the rest."""

from decimal import Decimal

import pytest

from blueprintiq.domain.models import (
    CadKind,
    CadUnit,
    ExtractionIssue,
    ExtractionStatus,
    TextLine,
    UnitSource,
)
from blueprintiq.extraction.cad_annotations import parse_cad_annotations

NOTE = "All dimensions are in millimeter"


def read(*texts: str):
    lines = [TextLine(text=t, page_number=1) for t in texts]
    annotations, unit_note = parse_cad_annotations(lines)
    return annotations, unit_note


def one(text: str, note: bool = True):
    annotations, _ = read(*([text, NOTE] if note else [text]))
    assert len(annotations) == 1, annotations
    return annotations[0]


@pytest.mark.parametrize(
    ("text", "kind", "nominal", "upper", "lower"),
    [
        ("2.7 ±0.1", CadKind.LINEAR, "2.7", "0.1", "-0.1"),
        ("2.7±0.10", CadKind.LINEAR, "2.7", "0.10", "-0.10"),
        ("3.7 +0/-0.2", CadKind.LINEAR, "3.7", "0", "-0.2"),
        ("3.7 +0.1/-0.0", CadKind.LINEAR, "3.7", "0.1", "0.0"),
        ("Ø12", CadKind.DIAMETER, "12", None, None),
        ("⌀12", CadKind.DIAMETER, "12", None, None),
        ("Ø12 ±0.05", CadKind.DIAMETER, "12", "0.05", "-0.05"),
        ("R1.5", CadKind.RADIUS, "1.5", None, None),
        ("16", CadKind.LINEAR, "16", None, None),
    ],
)
def test_supported_forms_keep_exact_decimals_and_signs(text, kind, nominal, upper, lower) -> None:
    a = one(text)
    assert a.dimension_kind is kind
    assert a.nominal == Decimal(nominal)
    assert str(a.nominal) == nominal  # exact text, no float round trip
    assert (str(a.upper_deviation) if a.upper_deviation is not None else None) == upper
    assert (str(a.lower_deviation) if a.lower_deviation is not None else None) == lower
    assert a.status is ExtractionStatus.PARSED
    assert a.association == "none"
    assert a.source.raw_text == text


def test_angle_needs_the_degree_sign_on_both_value_and_tolerance() -> None:
    a = one("75° ±0.5°", note=False)
    assert (a.dimension_kind, a.nominal, a.unit, a.unit_source) == (
        CadKind.ANGLE, Decimal("75"), CadUnit.DEG, UnitSource.SYMBOL,
    )  # fmt: skip
    assert a.upper_deviation == Decimal("0.5")
    mixed = one("75° ±0.5", note=False)
    assert mixed.status is ExtractionStatus.AMBIGUOUS
    assert mixed.nominal is None


def test_unit_comes_only_from_the_annotation_or_an_explicit_note() -> None:
    assert one(
        "2.7 mm ±0.1", note=False
    )  # unit before the tolerance: not a supported form.status is ExtractionStatus.AMBIGUOUS
    own = one("16 mm", note=False)
    assert (own.unit, own.unit_source) == (CadUnit.MM, UnitSource.ANNOTATION)
    inherited = one("16")
    assert (inherited.unit, inherited.unit_source) == (CadUnit.MM, UnitSource.DRAWING_NOTE)
    unknown = one("2.7 ±0.1", note=False)
    assert unknown.status is ExtractionStatus.AMBIGUOUS
    assert unknown.issues == (ExtractionIssue.MISSING_UNIT,)
    assert unknown.unit is None
    assert unknown.nominal == Decimal("2.7")  # kept as written, never converted


def test_the_unit_note_is_returned_as_evidence() -> None:
    _, note = read("16", NOTE)
    assert note is not None and note.raw_text == NOTE


@pytest.mark.parametrize(
    "notes",
    [("All dimensions are in millimeter", "All dimensions are in inches"),
     ("DIMENSIONS ARE IN CENTIMETERS",), ("Dimensions in mm if not stated otherwise",)],
)  # fmt: skip
def test_conflicting_or_unclear_unit_notes_give_no_inheritance(notes) -> None:
    annotations, note = read("16", *notes)
    assert note is None
    assert annotations == ()  # a bare number without unit evidence is not a dimension


@pytest.mark.parametrize(
    "text",
    ["16", "ABC-12345", "12345", "2024-01-15", "REV 3", "P/N 0045-12", "SCALE 1:2", "A", "1200",
     "0016", "1,5", "3 pieces", "SHEET 1 OF 1"],
)  # fmt: skip
def test_bare_numbers_and_codes_are_not_read_without_evidence(text: str) -> None:
    annotations, _ = read(text)  # no unit note at all
    assert annotations == ()


@pytest.mark.parametrize(
    "text", ["ABC-12345", "12345", "2024-01-15", "REV 3", "P/N 0045-12", "0016", "1200"]
)
def test_part_numbers_dates_and_codes_stay_unread_even_with_a_unit_note(text: str) -> None:
    annotations, _ = read(text, NOTE)
    assert annotations == ()


@pytest.mark.parametrize(
    "text", ["+0", "-0.2", "2.7 ±", "Ø12 ±", "GENERAL TOLERANCE ±0.1", "5 ° ±1 ° °"]
)
def test_split_or_incomplete_annotations_are_uncertain_and_carry_no_values(text: str) -> None:
    a = one(text)
    assert a.status is ExtractionStatus.AMBIGUOUS
    assert (a.nominal, a.upper_deviation, a.lower_deviation, a.dimension_kind) == (None,) * 4
    assert a.issues == (ExtractionIssue.UNSUPPORTED_SYNTAX,)
    assert a.source.raw_text == text


def test_labeled_lines_are_left_to_the_existing_parser() -> None:
    annotations, _ = read("THICKNESS: 4 mm", "MATERIAL: POM C noir", "NOTE: ±0.5", NOTE)
    assert annotations == ()


def test_ids_follow_reading_order() -> None:
    annotations, _ = read("R1.5", "ignored text", "Ø12", NOTE)
    assert [a.id for a in annotations] == ["C1", "C2"]


@pytest.mark.parametrize(
    "note",
    [
        "-All dimensions are in millimeter.",
        "• All dimensions are in millimeter",
        "– ALL DIMENSIONS ARE IN MM.",  # noqa: RUF001
        "Toutes les dimensions sont en millimètres",
        "All dimensions are in millimeter / Toutes les dimensions sont en millimètres",
    ],
)
def test_a_unit_note_with_punctuation_or_a_french_twin_is_inherited(note: str) -> None:
    a = one("2.7 ±0.1", note=False)
    assert a.status is ExtractionStatus.AMBIGUOUS
    annotations, unit_note = read("2.7 ±0.1", note)
    assert unit_note is not None and unit_note.raw_text == note
    assert annotations[0].status is ExtractionStatus.PARSED
    assert annotations[0].unit_source is UnitSource.DRAWING_NOTE


@pytest.mark.parametrize(
    "notes",
    [
        ("-All dimensions are in millimeter.", "Toutes les dimensions sont en pouces"),
        ("All dimensions are in millimeter", "Toutes les dimensions sont en centimètres"),
        ("All dimensions are in millimeter / All dimensions are in inches",),
        ("-All dimensions are in millimeter.", "All dimensions are in inches."),
    ],
)
def test_conflicting_declarations_give_no_unit(notes: tuple[str, ...]) -> None:
    annotations, unit_note = read("2.7 ±0.1", *notes)
    assert unit_note is None
    assert annotations[0].status is ExtractionStatus.AMBIGUOUS
    assert annotations[0].unit is None
