"""Hand-written expected rule outcomes for every valid fixture.

Ruleset: tests/fixtures/rules/test_rules.toml, i.e. THK-MIN-001 (thickness >= 3 mm),
DIA-MAX-001 (diameter <= 50 mm), LEN-RANGE-001 (length 10..500 mm), MAT-REQ-001
(material present). Each entry is (rule id, outcome, measurement ids), in report
order: rules in file order, then measurements in id order.

These were worked out by reading each fixture's annotations (drawing_specs.py)
and applying the policy in docs/design/phase1-mvp-spec.md sections 7 and 12.B. They
are NOT produced by running the rule engine.
"""

Expected = tuple[tuple[str, str, tuple[str, ...]], ...]

T, D, L, MAT = "THK-MIN-001", "DIA-MAX-001", "LEN-RANGE-001", "MAT-REQ-001"

# Thickness 4, diameter 20, length 120, material SS400: all comfortably inside.
BASIC: Expected = (
    (T, "pass", ("M1",)),
    (D, "pass", ("M2",)),
    (L, "pass", ("M3",)),
    (MAT, "pass", ("M4",)),
)

EXPECTED_FINDINGS: dict[str, Expected] = {
    "valid_basic": BASIC,
    "violations": (  # 2 mm < 3; 65 mm > 50; 600 mm > 500; material present
        (T, "fail", ("M1",)),
        (D, "fail", ("M2",)),
        (L, "fail", ("M3",)),
        (MAT, "pass", ("M4",)),
    ),
    "missing_material": (
        (T, "pass", ("M1",)),
        (D, "pass", ("M2",)),
        (L, "pass", ("M3",)),
        (MAT, "missing", ()),
    ),
    "boundary_values": (  # 3 = min; 50 = max; 50.01 > max; 10 = min; 500 = max
        (T, "pass", ("M1",)),
        (D, "pass", ("M2",)),
        (D, "fail", ("M3",)),
        (L, "pass", ("M4",)),
        (L, "pass", ("M5",)),
        (MAT, "pass", ("M6",)),
    ),
    "unit_conversion": (  # 0.3 cm = 3 mm; 2 in = 50.8 mm; 0.12 m = 120 mm; 0.12 in = 3.048 mm;
        (T, "pass", ("M1",)),  # 4.50 mm < 10 mm
        (D, "fail", ("M2",)),
        (D, "pass", ("M4",)),
        (L, "pass", ("M3",)),
        (L, "fail", ("M5",)),
        (MAT, "pass", ("M6",)),
    ),
    "ambiguous": (  # everything unreadable; single-valued thickness grouped
        (T, "needs_review", ("M1", "M4")),
        (D, "needs_review", ("M2",)),
        (L, "needs_review", ("M3",)),
        (MAT, "needs_review", ("M5",)),
    ),
    "conflicting": (  # 4 mm vs 6 mm; two holes; no length; SS400 vs S45C
        (T, "needs_review", ("M1", "M2")),
        (D, "pass", ("M3",)),
        (D, "pass", ("M4",)),
        (L, "missing", ()),
        (MAT, "needs_review", ("M5", "M6")),
    ),
    "no_annotations": (
        (T, "missing", ()),
        (D, "missing", ()),
        (L, "missing", ()),
        (MAT, "missing", ()),
    ),
    "split_spans": BASIC,
    "merged_adjacent": (  # one merged line: both labels ambiguous
        (T, "needs_review", ("M1",)),
        (D, "missing", ()),
        (L, "missing", ()),
        (MAT, "needs_review", ("M2",)),
    ),
    "rotated_90": BASIC,
    "rotated_180": BASIC,
    "rotated_270": BASIC,
    "rotated_90_sideways": (  # reading order: material, length, diameter, thickness
        (T, "pass", ("M4",)),
        (D, "pass", ("M3",)),
        (L, "pass", ("M2",)),
        (MAT, "pass", ("M1",)),
    ),
    "cropped": BASIC,  # the hidden 9 mm line outside the CropBox is not evidence
    "cropped_rotated_90": BASIC,
    "inherited_crop_rotated_270": BASIC,
    "clipped_text": BASIC,  # the clipped S45C must not create a material conflict
    "crop_beyond_media": BASIC,
    "invisible_text": BASIC,  # invisible 9 mm thickness and 0.5 pt 99 mm diameter ignored
    "merged_title_block": (
        (T, "pass", ("M1",)),
        (D, "pass", ("M2",)),
        (L, "pass", ("M3",)),
        (MAT, "needs_review", ("M4",)),
    ),
    "wide_gaps": (  # AISI 304 read whole; '4 m m', merged length+diameter ambiguous
        (T, "needs_review", ("M2",)),
        (D, "needs_review", ("M4",)),
        (D, "pass", ("M5",)),
        (L, "needs_review", ("M3",)),
        (MAT, "pass", ("M1",)),
    ),
}
