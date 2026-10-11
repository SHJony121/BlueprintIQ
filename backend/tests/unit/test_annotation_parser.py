"""Annotation parser: text lines in, typed measurements out. No PDF involved."""

import subprocess
import sys
from decimal import Decimal

import pytest

from blueprintiq.domain.models import (
    BBox,
    DimensionMeasurement,
    DimensionType,
    ExtractionIssue,
    ExtractionMethod,
    ExtractionStatus,
    MaterialAnnotation,
    TextLine,
)
from blueprintiq.domain.units import LengthUnit
from blueprintiq.extraction.annotation_parser import (
    MAX_LINE_LENGTH,
    ParsedAnnotations,
    parse_lines,
)

BOX = BBox(x0=72, y0=100, x1=180, y1=112)
METHOD = ExtractionMethod.PDF_TEXT_LAYER


def parse_one(text: str, bbox: BBox | None = BOX, page: int = 1) -> ParsedAnnotations:
    return parse_lines([TextLine(text=text, page_number=page, bbox=bbox)], method=METHOD)


def only_dimension(text: str) -> DimensionMeasurement:
    result = parse_one(text)
    assert result.unrecognized == ()
    assert len(result.measurements) == 1, f"expected one measurement from {text!r}"
    m = result.measurements[0]
    assert isinstance(m, DimensionMeasurement)
    return m


def only_material(text: str) -> MaterialAnnotation:
    result = parse_one(text)
    assert result.unrecognized == ()
    assert len(result.measurements) == 1, f"expected one measurement from {text!r}"
    m = result.measurements[0]
    assert isinstance(m, MaterialAnnotation)
    return m


# ------------------------------------------------------------------ supported


@pytest.mark.parametrize(
    ("text", "dim_type", "value", "unit", "normalized_mm"),
    [
        ("THICKNESS: 4 mm", DimensionType.THICKNESS, "4", LengthUnit.MM, "4"),
        ("thickness:4MM", DimensionType.THICKNESS, "4", LengthUnit.MM, "4"),
        ("Thickness : 4 MM", DimensionType.THICKNESS, "4", LengthUnit.MM, "4"),
        ("  THICKNESS:   4    mm  ", DimensionType.THICKNESS, "4", LengthUnit.MM, "4"),
        ("THICKNESS: 0.5 cm", DimensionType.THICKNESS, "0.5", LengthUnit.CM, "5"),
        ("DIAMETER: 20 mm", DimensionType.DIAMETER, "20", LengthUnit.MM, "20"),
        ("DIAMETER: 2 in", DimensionType.DIAMETER, "2", LengthUnit.IN, "50.8"),
        ("DIAMETER: 20.5mm", DimensionType.DIAMETER, "20.5", LengthUnit.MM, "20.5"),
        ("LENGTH: 0.12 m", DimensionType.LENGTH, "0.12", LengthUnit.M, "120"),
        ("LENGTH: 120 mm", DimensionType.LENGTH, "120", LengthUnit.MM, "120"),
        ("THICKNESS: 0 mm", DimensionType.THICKNESS, "0", LengthUnit.MM, "0"),
        ("THICKNESS:\u00a04\u00a0mm", DimensionType.THICKNESS, "4", LengthUnit.MM, "4"),
    ],
)
def test_supported_dimensions_are_parsed(
    text: str, dim_type: DimensionType, value: str, unit: LengthUnit, normalized_mm: str
) -> None:
    m = only_dimension(text)
    assert m.status is ExtractionStatus.PARSED
    assert m.issues == ()
    assert m.dimension_type is dim_type
    assert m.value == Decimal(value)
    assert m.unit is unit
    assert m.normalized_value_mm == Decimal(normalized_mm)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("MATERIAL: SS400", "SS400"),
        ("material: ss400", "SS400"),
        ("MATERIAL:S45C", "S45C"),
        ("MATERIAL: A5052-H34", "A5052-H34"),
        ("MATERIAL: AISI 304", "AISI 304"),
        ("MATERIAL: JIS G3101 SS400", "JIS G3101 SS400"),
        ("MATERIAL: 6061-T6", "6061-T6"),
        ("MATERIAL:   sus304  ", "SUS304"),
    ],
)
def test_supported_materials_are_parsed(text: str, expected: str) -> None:
    m = only_material(text)
    assert m.status is ExtractionStatus.PARSED
    assert m.value == expected
    assert m.issues == ()


# ------------------------------------------------------------------ ambiguous


@pytest.mark.parametrize(
    ("text", "issue", "value", "unit"),
    [
        ("THICKNESS: 4", ExtractionIssue.MISSING_UNIT, "4", None),
        ("THICKNESS:", ExtractionIssue.MISSING_VALUE, None, None),
        ("THICKNESS:    ", ExtractionIssue.MISSING_VALUE, None, None),
        ("THICKNESS: 4 ft", ExtractionIssue.UNSUPPORTED_UNIT, "4", None),
        ("THICKNESS: 4ft", ExtractionIssue.UNSUPPORTED_UNIT, "4", None),
        ('DIAMETER: 2"', ExtractionIssue.UNSUPPORTED_UNIT, "2", None),
        ("THICKNESS: 4 inch", ExtractionIssue.UNSUPPORTED_UNIT, "4", None),
        ("THICKNESS: 4 \u03bcm", ExtractionIssue.UNSUPPORTED_UNIT, "4", None),
        ("DIAMETER: 2,5 mm", ExtractionIssue.DECIMAL_COMMA, None, LengthUnit.MM),
        ("LENGTH: 1,000 mm", ExtractionIssue.DECIMAL_COMMA, None, LengthUnit.MM),
        ("DIAMETER: 2,5", ExtractionIssue.DECIMAL_COMMA, None, None),
        ("LENGTH: 100 \u00b1 0.5 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("LENGTH: 100\u00b10.5mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("LENGTH: 100 +/- 0.5 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("LENGTH: 100 +0.2/-0.1 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: about four", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: -4 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: +4 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: 4-6 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: 4 to 6 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: 4 mm THK", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: 4 mm (approx)", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: .5 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: 4. mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: 4.5.6 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: 1e3 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: 4 mm 5 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: 4 m m", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("DIAMETER: \u00d820 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: \uff14 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),  # full-width 4
        ("THICKNESS: \u0664 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),  # Arabic-Indic 4
        ("THICKNESS: 4 mm MATERIAL: SS400", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: " + "9" * 21 + " mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
        ("THICKNESS: 0." + "0" * 19 + "1 mm", ExtractionIssue.UNSUPPORTED_SYNTAX, None, None),
    ],
)
def test_ambiguous_dimensions_are_flagged_not_guessed(
    text: str, issue: ExtractionIssue, value: str | None, unit: LengthUnit | None
) -> None:
    m = only_dimension(text)
    assert m.status is ExtractionStatus.AMBIGUOUS
    assert m.issues == (issue,)
    assert m.value == (Decimal(value) if value is not None else None)
    assert m.unit is unit
    assert m.normalized_value_mm is None


@pytest.mark.parametrize(
    ("text", "issue"),
    [
        ("MATERIAL:", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL:   ", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: TBD", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: tba", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: N/A", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: NA", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: none", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: -", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: ?", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: SS400 OR S45C", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 / S45C", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400, S45C", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 AND S45C", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 (OR EQUIV.)", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 EQUIVALENT", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 OR EQUIV", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400?", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400\x00", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: " + "AB" * 33, ExtractionIssue.UNSUPPORTED_SYNTAX),  # 66 chars > 64
    ],
)
def test_ambiguous_materials_are_flagged_not_guessed(text: str, issue: ExtractionIssue) -> None:
    m = only_material(text)
    assert m.status is ExtractionStatus.AMBIGUOUS
    assert m.issues == (issue,)
    assert m.value is None


# ------------------------------------------------------ false-positive prevention


@pytest.mark.parametrize(
    ("text", "label"),
    [
        ("MIN THICKNESS: 5 mm", "MIN THICKNESS"),
        ("MAX DIAMETER: 50 mm", "MAX DIAMETER"),
        ("MINIMUM THICKNESS: 5 mm", "MINIMUM THICKNESS"),
        ("THICKNESS TOLERANCE: 0.1 mm", "THICKNESS TOLERANCE"),
        ("THICKNESS (MIN): 5 mm", "THICKNESS (MIN)"),
        ("NOMINAL THICKNESS: 4 mm", "NOMINAL THICKNESS"),
        ("COATING THICKNESS: 0.02 mm", "COATING THICKNESS"),
        ("MATERIAL SPEC: JIS G3101", "MATERIAL SPEC"),
        ("NOTE: THICKNESS: 4 mm", "NOTE"),
        ("DIA: 20 mm", "DIA"),
        ("THK: 4 mm", "THK"),
        ("HARDNESS: 200 HB", "HARDNESS"),
        ("SCALE: 1:2", "SCALE"),
        ("hardness : 200 HB", "HARDNESS"),
        ("Drawn   by: QA", "DRAWN BY"),
    ],
)
def test_other_labels_are_reported_as_unrecognized_not_measured(text: str, label: str) -> None:
    result = parse_one(text)
    assert result.measurements == ()
    assert len(result.unrecognized) == 1
    assert result.unrecognized[0].label == label
    assert result.unrecognized[0].source.raw_text == text


@pytest.mark.parametrize(
    "text",
    [
        "THICKNESS 4 mm",  # no colon: not the supported format
        "THICKNESS = 4 mm",
        "THICKNESS-4mm",
        "4 mm",
        "Thickness of the coating shall be uniform.",
        "12:30",
        ": 4 mm",
        "",
        "   ",
        "\u00d820",
    ],
)
def test_lines_without_a_leading_label_are_ignored(text: str) -> None:
    result = parse_one(text)
    assert result.measurements == ()
    assert result.unrecognized == ()


# ---------------------------------------------------------------- evidence


def test_raw_text_page_bbox_and_method_are_preserved_exactly() -> None:
    box = BBox(x0=10.5, y0=20.25, x1=99.125, y1=31.0)
    m = parse_lines(
        [TextLine(text="  thickness:4MM ", page_number=1, bbox=box)], method=METHOD
    ).measurements[0]
    assert m.source.raw_text == "  thickness:4MM "
    assert m.source.page_number == 1
    assert m.source.bbox == box
    assert m.source.extraction_method is METHOD


def test_missing_bbox_stays_missing() -> None:
    result = parse_one("THICKNESS: 4 mm", bbox=None)
    assert result.measurements[0].source.bbox is None
    assert not result.measurements[0].source.has_coordinates


def test_unrecognized_annotations_keep_their_evidence() -> None:
    result = parse_one("HARDNESS: 200 HB", page=2)
    source = result.unrecognized[0].source
    assert (source.page_number, source.bbox, source.raw_text) == (2, BOX, "HARDNESS: 200 HB")


def test_parser_assigns_no_confidence_scores() -> None:
    m = only_dimension("THICKNESS: 4 mm")
    assert not any("confidence" in name for name in type(m).model_fields)


# ---------------------------------------------------------------- precision


@pytest.mark.parametrize(
    ("text", "value_str", "normalized_str"),
    [
        ("THICKNESS: 4.50 mm", "4.50", "4.50"),
        ("THICKNESS: 0.07 cm", "0.07", "0.70"),
        ("DIAMETER: 0.12 in", "0.12", "3.048"),
        ("DIAMETER: 50.01 mm", "50.01", "50.01"),
        ("LENGTH: 004 mm", "004", "4"),
        # MAX_NUMBER_DIGITS (20) is the longest accepted number, in every unit.
        ("LENGTH: 12345678901234567890 mm", "12345678901234567890", "12345678901234567890"),
        ("LENGTH: 12345678901234567890 in", "12345678901234567890", "313580244091358024406.0"),
        ("LENGTH: 0.0000000000000000001 in", "0.0000000000000000001", "2.54E-18"),
    ],
)
def test_numeric_values_keep_their_exact_decimal_form(
    text: str, value_str: str, normalized_str: str
) -> None:
    m = only_dimension(text)
    assert m.status is ExtractionStatus.PARSED
    assert m.value == Decimal(value_str)
    assert m.normalized_value_mm == Decimal(normalized_str)
    # as_tuple() compares digits and exponent, so 4.50 is not confused with 4.5.
    assert m.value is not None
    assert m.value.as_tuple() == Decimal(value_str).as_tuple()


# -------------------------------------------------------- multi-line behaviour


def test_ids_are_sequential_in_input_order_and_skip_unrecognized_lines() -> None:
    lines = [
        TextLine(text="TITLE: BRACKET", page_number=1),
        TextLine(text="THICKNESS: 4 mm", page_number=1),
        TextLine(text="random note", page_number=1),
        TextLine(text="MATERIAL: SS400", page_number=1),
        TextLine(text="DIAMETER: 2,5 mm", page_number=1),
    ]
    result = parse_lines(lines, method=METHOD)
    assert [m.id for m in result.measurements] == ["M1", "M2", "M3"]
    assert [m.source.raw_text for m in result.measurements] == [
        "THICKNESS: 4 mm",
        "MATERIAL: SS400",
        "DIAMETER: 2,5 mm",
    ]
    assert [u.label for u in result.unrecognized] == ["TITLE"]


def test_duplicates_and_conflicts_are_kept_as_separate_measurements() -> None:
    # Deciding what duplicates mean is the rule engine's job (M4), not the parser's.
    lines = [
        TextLine(text="THICKNESS: 4 mm", page_number=1),
        TextLine(text="THICKNESS: 4 mm", page_number=1),
        TextLine(text="THICKNESS: 6 mm", page_number=1),
    ]
    result = parse_lines(lines, method=METHOD)
    assert [m.id for m in result.measurements] == ["M1", "M2", "M3"]
    assert all(m.status is ExtractionStatus.PARSED for m in result.measurements)


def test_empty_input() -> None:
    result = parse_lines([], method=METHOD)
    assert result == ParsedAnnotations(measurements=(), unrecognized=(), skipped_lines=0)


def test_overlong_lines_are_counted_not_parsed_or_truncated() -> None:
    long_line = "THICKNESS: 4 mm " + "x" * MAX_LINE_LENGTH
    result = parse_one(long_line)
    assert result.measurements == ()
    assert result.unrecognized == ()
    assert result.skipped_lines == 1


# ---------------------------------------------------------------- robustness


NASTY_VALUES = [
    "",
    " ",
    "\x00",
    "\t\n",
    "\u200b",
    "\ufffd",
    "\U0001f600",
    "mm",
    "4" * 200,
    "4." + "0" * 200 + " mm",
    "NaN mm",
    "Infinity mm",
    "inf",
    "-0 mm",
    "0x10 mm",
    "4 mm\x00",
    ":::",
    "4 :mm",
    "\u00b1",
    "SS400" * 20,
    chr(0xD800),  # lone surrogate: not valid Unicode text
    "4 mm" + chr(0xDCFF),
]


@pytest.mark.parametrize("label", ["THICKNESS", "DIAMETER", "LENGTH", "MATERIAL", "OTHER"])
@pytest.mark.parametrize("value", NASTY_VALUES)
def test_parser_never_raises_on_arbitrary_input(label: str, value: str) -> None:
    result = parse_one(f"{label}: {value}")
    for m in result.measurements:
        if m.status is ExtractionStatus.PARSED and isinstance(m, DimensionMeasurement):
            assert m.normalized_value_mm is not None


def test_parser_module_does_not_import_pymupdf() -> None:
    code = (
        "import sys, blueprintiq.extraction.annotation_parser; "
        "assert 'pymupdf' not in sys.modules and 'fitz' not in sys.modules"
    )
    completed = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert completed.returncode == 0, completed.stderr


# ------------------------------------------- regressions from the M2 parser review


@pytest.mark.parametrize(
    ("text", "issue"),
    [
        # C1: placeholder variants must never count as a stated material.
        ("MATERIAL: TBD.", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: T.B.D.", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: N.A.", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: N.A", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: N-A", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: TBD TBD", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: TO BE DETERMINED", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: NOT SPECIFIED", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: UNSPECIFIED", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: UNK", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: NIL", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: ANY", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: SEE NOTE 3", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: PER SPEC", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: REFER DWG 12", ExtractionIssue.UNSUPPORTED_SYNTAX),
        # I1: alternatives and approximations, including glued suffixes.
        ("MATERIAL: SS400-EQUIV", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 EQ", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 SIM", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 SIMILAR", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 EITHER SUS304", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 TYP", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 OPTIONAL", ExtractionIssue.UNSUPPORTED_SYNTAX),
        # M1: line breaks / control characters inside the value.
        ("MATERIAL: SS400\nSUS304", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400\tSUS304", ExtractionIssue.UNSUPPORTED_SYNTAX),
    ],
)
def test_review_material_false_positives_are_ambiguous(text: str, issue: ExtractionIssue) -> None:
    m = only_material(text)
    assert m.status is ExtractionStatus.AMBIGUOUS
    assert m.issues == (issue,)


@pytest.mark.parametrize(
    "text",
    [
        "MATERIAL: A5052-H34",  # hyphenated grade stays valid after word splitting
        "MATERIAL: 6061-T6",
        "MATERIAL: S45C",
    ],
)
def test_review_legitimate_hyphenated_materials_still_parse(text: str) -> None:
    assert only_material(text).status is ExtractionStatus.PARSED


@pytest.mark.parametrize(
    ("text", "dim_type"),
    [
        # I2: a supported label behind non-letter prefixes is flagged, never dropped.
        ("- THICKNESS: 4 mm", DimensionType.THICKNESS),
        ("* THICKNESS: 4 mm", DimensionType.THICKNESS),
        ("\u2022 THICKNESS: 4 mm", DimensionType.THICKNESS),
        ("1) THICKNESS: 4 mm", DimensionType.THICKNESS),
        ("1. THICKNESS: 4 mm", DimensionType.THICKNESS),
        ("(THICKNESS: 4 mm)", DimensionType.THICKNESS),
        ("THICKNESS\uff1a 4 mm", DimensionType.THICKNESS),  # full-width colon
        ("THICKNESS\u2236 4 mm", DimensionType.THICKNESS),  # ratio colon
        ("\uff34\uff28\uff29\uff23\uff2b\uff2e\uff25\uff33\uff33: 4 mm", DimensionType.THICKNESS),
        ("2. diameter: 20 mm", DimensionType.DIAMETER),
    ],
)
def test_review_supported_label_with_unsupported_prefix_is_ambiguous(
    text: str, dim_type: DimensionType
) -> None:
    m = only_dimension(text)
    assert m.dimension_type is dim_type
    assert m.status is ExtractionStatus.AMBIGUOUS
    assert m.issues == (ExtractionIssue.UNSUPPORTED_SYNTAX,)
    assert m.value is None
    assert m.source.raw_text == text


def test_review_material_label_with_bullet_is_ambiguous() -> None:
    m = only_material("- MATERIAL: SS400")
    assert m.status is ExtractionStatus.AMBIGUOUS
    assert m.issues == (ExtractionIssue.UNSUPPORTED_SYNTAX,)


@pytest.mark.parametrize("prefix", ["\ufeff", "\u200b", "\u200b\ufeff"])
def test_review_invisible_format_characters_before_label_are_ignored(prefix: str) -> None:
    text = prefix + "THICKNESS: 4 mm"
    m = only_dimension(text)
    assert m.status is ExtractionStatus.PARSED
    assert m.normalized_value_mm == Decimal("4")
    assert m.source.raw_text == text  # raw text is still exactly what was read


def test_review_conflict_is_not_hidden_by_a_bullet() -> None:
    lines = [
        TextLine(text="THICKNESS: 4 mm", page_number=1),
        TextLine(text="\ufeffTHICKNESS: 2 mm", page_number=1),
        TextLine(text="- THICKNESS: 2 mm", page_number=1),
    ]
    result = parse_lines(lines, method=METHOD)
    statuses = [m.status for m in result.measurements]
    assert statuses == [
        ExtractionStatus.PARSED,
        ExtractionStatus.PARSED,
        ExtractionStatus.AMBIGUOUS,
    ]


@pytest.mark.parametrize(
    "text",
    [
        "MIN THICKNESS: 5 mm",  # a qualifier with letters stays an unrecognized label
        "COATING THICKNESS: 0.02 mm",
        "NOTE: THICKNESS: 2 mm",
    ],
)
def test_review_letter_prefixes_stay_unrecognized_not_ambiguous(text: str) -> None:
    result = parse_one(text)
    assert result.measurements == ()
    assert len(result.unrecognized) == 1


@pytest.mark.parametrize("text", [chr(0xD800), "THICKNESS: 4 mm" + chr(0xD800)])
def test_review_invalid_unicode_lines_are_counted_not_raised(text: str) -> None:
    result = parse_one(text)
    assert result.measurements == ()
    assert result.unrecognized == ()
    assert result.skipped_lines == 1


@pytest.mark.parametrize(
    "text",
    [
        # M1: a line break between number and unit suggests two joined text spans.
        "THICKNESS: 4\nmm",
        "LENGTH: 12\nm",
        "THICKNESS: 4\x1fmm",
        "THICKNESS: 4\x1cmm",
        "THICKNESS: 4\r\nmm",
    ],
)
def test_review_control_characters_in_value_are_ambiguous(text: str) -> None:
    m = only_dimension(text)
    assert m.status is ExtractionStatus.AMBIGUOUS
    assert m.issues == (ExtractionIssue.UNSUPPORTED_SYNTAX,)


@pytest.mark.parametrize(
    "text",
    [
        # M2: qualifiers and punctuation are syntax problems, not unknown units.
        "THICKNESS: 3 MIN",
        "THICKNESS: 4 MAX",
        "THICKNESS: 4 TYP",
        "THICKNESS: 4 REF",
        "THICKNESS: 4 NOM",
        "THICKNESS: 4 mm?",
        "THICKNESS: 4 mm~",
        "THICKNESS: 4 mm*",
        "THICKNESS: 4 mm\u200b",
        "THICKNESS: 4 mm.",
    ],
)
def test_review_qualifiers_after_number_are_unsupported_syntax(text: str) -> None:
    m = only_dimension(text)
    assert m.status is ExtractionStatus.AMBIGUOUS
    assert m.issues == (ExtractionIssue.UNSUPPORTED_SYNTAX,)
    assert m.value is None


@pytest.mark.parametrize(
    ("text", "value"),
    [
        # M3 (owner decision): strict unit matching. Uppercase "M" is never read as
        # metres, and mixed case is never guessed; the number is kept, unconverted.
        ("THICKNESS: 4 M", "4"),
        ("DIAMETER: 8M", "8"),
        ("LENGTH: 12 M", "12"),
        ("THICKNESS: 4 Mm", "4"),
        ("THICKNESS: 4 mM", "4"),
        ("DIAMETER: 2 In", "2"),
        ("LENGTH: 5 Cm", "5"),
    ],
)
def test_review_unit_case_variants_are_ambiguous_not_converted(text: str, value: str) -> None:
    m = only_dimension(text)
    assert m.status is ExtractionStatus.AMBIGUOUS
    assert m.issues == (ExtractionIssue.AMBIGUOUS_UNIT_CASE,)
    assert m.value == Decimal(value)
    assert m.unit is None
    assert m.normalized_value_mm is None


@pytest.mark.parametrize(
    ("text", "unit", "normalized"),
    [
        ("LENGTH: 12 m", LengthUnit.M, "12000"),
        ("THICKNESS: 4 MM", LengthUnit.MM, "4"),
        ("LENGTH: 5 CM", LengthUnit.CM, "50"),
        ("DIAMETER: 2 IN", LengthUnit.IN, "50.8"),
    ],
)
def test_exact_unit_spellings_still_parse(text: str, unit: LengthUnit, normalized: str) -> None:
    m = only_dimension(text)
    assert m.status is ExtractionStatus.PARSED
    assert m.unit is unit
    assert m.normalized_value_mm == Decimal(normalized)


# --------------------------------------- regressions from the second review round


@pytest.mark.parametrize(
    "text",
    [
        # Python's re.IGNORECASE lets U+0130 match "i"; this used to raise KeyError.
        "D\u0130AMETER: 20 mm",
        "TH\u0130CKNESS: 4 mm",
        "MATER\u0130AL: SS400",
        "- D\u0130AMETER: 20 mm",
    ],
)
def test_review2_non_ascii_case_folding_never_crashes(text: str) -> None:
    result = parse_one(text)  # must not raise
    for m in result.measurements:
        assert m.status is ExtractionStatus.AMBIGUOUS


@pytest.mark.parametrize(
    ("text", "dim_type"),
    [
        ("\nTHICKNESS: 4 mm", DimensionType.THICKNESS),
        ("4\nTHICKNESS: 2 mm", DimensionType.THICKNESS),
        ("THICKNESS\u200b: 4 mm", DimensionType.THICKNESS),
        ("THICK\u00adNESS: 4 mm", DimensionType.THICKNESS),  # soft hyphen
        ("T\u200bHICKNESS: 4 mm", DimensionType.THICKNESS),
        ("THICKNESS\ua789 4 mm", DimensionType.THICKNESS),  # modifier-letter colon
    ],
)
def test_review2_hidden_supported_labels_are_flagged_not_dropped(
    text: str, dim_type: DimensionType
) -> None:
    m = only_dimension(text)
    assert m.dimension_type is dim_type
    assert m.status is ExtractionStatus.AMBIGUOUS
    assert m.issues == (ExtractionIssue.UNSUPPORTED_SYNTAX,)


@pytest.mark.parametrize(
    "text",
    [
        "THICKNESS: 4 m\n",  # a trailing break after "m" may be a split "mm"
        "LENGTH: 12 m\x1f",
        "THICKNESS:\x1f4 mm",
        "THICKNESS:\n4 mm",
    ],
)
def test_review2_control_characters_at_value_edges_are_flagged(text: str) -> None:
    m = only_dimension(text)
    assert m.status is ExtractionStatus.AMBIGUOUS
    assert m.issues == (ExtractionIssue.UNSUPPORTED_SYNTAX,)


def test_review2_control_character_before_material_is_flagged() -> None:
    m = only_material("MATERIAL:\nSS400")
    assert m.status is ExtractionStatus.AMBIGUOUS
    assert m.issues == (ExtractionIssue.UNSUPPORTED_SYNTAX,)


@pytest.mark.parametrize(
    ("text", "issue"),
    [
        ("MATERIAL: TO BE CONFIRMED", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: TO BE ADVISED", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: NOT APPLICABLE", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: PENDING", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: VARIOUS", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: XXX", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: X", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: N.S.", ExtractionIssue.MISSING_VALUE),
        ("MATERIAL: SAME AS PART 2", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: AS REQUIRED", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: BY CUSTOMER", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: CUSTOMER SUPPLIED", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 E.Q.", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: APPROX SS400", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 APPROX.", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 SUBSTITUTE", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 ALTERNATE", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 EQUIVALENTS", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 PREFERRED", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 VS SUS304", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 MIN", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: SS400 OR BETTER", ExtractionIssue.UNSUPPORTED_SYNTAX),
        ("MATERIAL: A5052P-H34 PER JIS H4000", ExtractionIssue.UNSUPPORTED_SYNTAX),
    ],
)
def test_review2_more_material_false_positives_are_ambiguous(
    text: str, issue: ExtractionIssue
) -> None:
    m = only_material(text)
    assert m.status is ExtractionStatus.AMBIGUOUS
    assert m.issues == (issue,)


@pytest.mark.parametrize(
    "value",
    [
        "SS400",
        "A5052-H34",
        "AISI 304",
        "JIS G3101 SS400",
        "6061-T6",
        "S45C",
        "SUS304 2B",
        "17-4PH",
        "ASTM A36",
        "C3604BD",
        "COPPER",
        "SPCC-SD",
    ],
)
def test_review2_legitimate_materials_still_parse(value: str) -> None:
    m = only_material(f"MATERIAL: {value}")
    assert m.status is ExtractionStatus.PARSED
    assert m.value == value
