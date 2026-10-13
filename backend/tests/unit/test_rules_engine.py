"""Deterministic rule evaluation over measurements (no PDF, no LLM)."""

import itertools
from decimal import Decimal
from typing import Any

import pytest

from blueprintiq.domain.models import (
    BBox,
    DimensionMeasurement,
    DimensionType,
    ExtractionMethod,
    ExtractionStatus,
    Finding,
    FindingStatus,
    FindingSummary,
    InspectionReport,
    MaterialAnnotation,
    Measurement,
    RulesetInfo,
    Severity,
    SourceEvidence,
)
from blueprintiq.domain.units import LengthUnit, to_mm
from blueprintiq.rules.config import Ruleset, parse_ruleset
from blueprintiq.rules.engine import evaluate
from tests.factories import document_info

PASS, FAIL = FindingStatus.PASS, FindingStatus.FAIL
MISSING, REVIEW = FindingStatus.MISSING, FindingStatus.NEEDS_REVIEW


def ruleset(*rules: str) -> Ruleset:
    header = '[ruleset]\nid = "t"\nversion = "1"\ndescription = "test"\n'
    return parse_ruleset(header + "".join(f"\n[[rules]]\n{r}\n" for r in rules))


def range_rule(applies_to: str, *, min_mm: str | None = None, max_mm: str | None = None,
               rid: str = "R-1", severity: str = "error") -> str:  # fmt: skip
    bounds = (f"min_mm = {min_mm}\n" if min_mm else "") + (f"max_mm = {max_mm}\n" if max_mm else "")
    return (
        f'id = "{rid}"\nkind = "range"\napplies_to = "{applies_to}"\n{bounds}'
        f'severity = "{severity}"\ndescription = "Range rule for {applies_to}."'
    )


def required_rule(applies_to: str, rid: str = "Q-1") -> str:
    return (
        f'id = "{rid}"\nkind = "required"\napplies_to = "{applies_to}"\n'
        f'severity = "error"\ndescription = "A {applies_to} annotation is required."'
    )


def source(raw: str, y: float = 100.0, bbox: bool = True) -> SourceEvidence:
    box = BBox(x0=72, y0=y, x1=180, y1=y + 12) if bbox else None
    return SourceEvidence(page_number=1, bbox=box, raw_text=raw,
                          extraction_method=ExtractionMethod.PDF_TEXT_LAYER)  # fmt: skip


def dim(n: int, dtype: str, value: str, unit: str = "mm", **kw: Any) -> DimensionMeasurement:
    u = LengthUnit(unit)
    return DimensionMeasurement(
        id=f"M{n}",
        dimension_type=DimensionType(dtype),
        value=Decimal(value),
        unit=u,
        normalized_value_mm=to_mm(Decimal(value), u),
        status=ExtractionStatus.PARSED,
        source=kw.get("src", source(f"{dtype.upper()}: {value} {unit}", y=20.0 * (n % 40))),
    )


def unreadable(n: int, dtype: str, issue: str = "missing_unit") -> DimensionMeasurement:
    return DimensionMeasurement(
        id=f"M{n}",
        dimension_type=DimensionType(dtype),
        value=None,
        unit=None,
        normalized_value_mm=None,
        status=ExtractionStatus.AMBIGUOUS,
        issues=(issue,),
        source=source(f"{dtype.upper()}: ?", y=20.0 * (n % 40)),
    )


def mat(n: int, value: str | None, issue: str | None = None) -> MaterialAnnotation:
    return MaterialAnnotation(
        id=f"M{n}",
        value=value,
        status=ExtractionStatus.AMBIGUOUS if issue else ExtractionStatus.PARSED,
        issues=(issue,) if issue else (),
        source=source(f"MATERIAL: {value or ''}".strip(), y=20.0 * (n % 40)),
    )


def outcomes(findings: tuple[Finding, ...]) -> list[tuple[str, FindingStatus, tuple[str, ...]]]:
    return [(f.rule_id, f.status, f.measurement_ids) for f in findings]


def validated(measurements: list[Measurement], findings: tuple[Finding, ...]) -> InspectionReport:
    """Run the M1 report validator over the result (ids, evidence, confirmed-outcome rule)."""
    return InspectionReport(
        document=document_info(page_count=1),
        ruleset=RulesetInfo(id="t", version="1"),
        measurements=tuple(measurements),
        unrecognized_annotations=(),
        findings=findings,
        summary=FindingSummary.from_findings(findings),
        processing_time_ms=0.0,
    )


MIN3 = ruleset(range_rule("thickness", min_mm="3.0", rid="THK-MIN-001"))
MAX50 = ruleset(range_rule("diameter", max_mm="50.0", rid="DIA-MAX-001"))
LEN = ruleset(range_rule("length", min_mm="10", max_mm="500", rid="LEN-RANGE-001"))
MAT_REQ = ruleset(required_rule("material", rid="MAT-REQ-001"))


# ------------------------------------------------------------ boundaries


@pytest.mark.parametrize(
    ("value", "unit", "status"),
    [
        ("3", "mm", PASS),  # exactly the minimum
        ("3.000", "mm", PASS),
        ("2.999", "mm", FAIL),
        ("0.3", "cm", PASS),  # 3.0 mm exactly
        ("0.29", "cm", FAIL),
        ("0.003", "m", PASS),
        ("0.12", "in", PASS),  # 3.048 mm
        ("0.118", "in", FAIL),  # 2.9972 mm
        ("0", "mm", FAIL),
    ],
)
def test_minimum_boundary(value: str, unit: str, status: FindingStatus) -> None:
    findings = evaluate([dim(1, "thickness", value, unit)], MIN3)
    assert outcomes(findings) == [("THK-MIN-001", status, ("M1",))]


@pytest.mark.parametrize(
    ("value", "unit", "status"),
    [
        ("50", "mm", PASS),
        ("50.01", "mm", FAIL),
        ("5", "cm", PASS),
        ("2", "in", FAIL),
        ("49.999", "mm", PASS),
    ],
)
def test_maximum_boundary(value: str, unit: str, status: FindingStatus) -> None:
    assert evaluate([dim(1, "diameter", value, unit)], MAX50)[0].status is status


@pytest.mark.parametrize(
    ("value", "status"),
    [("10", PASS), ("9.99", FAIL), ("500", PASS), ("500.0001", FAIL), ("120", PASS)],
)
def test_bounded_range_is_inclusive_at_both_ends(value: str, status: FindingStatus) -> None:
    assert evaluate([dim(1, "length", value)], LEN)[0].status is status


def test_decimal_comparison_where_binary_float_would_be_wrong() -> None:
    # 0.07 cm * 10 is 0.7000000000000001 in float, which would exceed a 0.7 mm maximum.
    rules = ruleset(range_rule("thickness", max_mm="0.7"))
    assert float("0.07") * 10 > 0.7
    assert evaluate([dim(1, "thickness", "0.07", "cm")], rules)[0].status is PASS


@pytest.mark.parametrize(
    ("value", "status"),
    [
        # Both differ from 50 by less than float resolution: as floats they equal 50.
        ("50.0000000000000001", FAIL),
        ("49.9999999999999999", PASS),
    ],
)
def test_comparison_is_exact_even_below_float_resolution(value: str, status: FindingStatus) -> None:
    assert float(Decimal(value)) == 50.0
    assert evaluate([dim(1, "diameter", value)], MAX50)[0].status is status


# -------------------------------------------------------------- missing


def test_no_measurement_of_the_type_is_missing_not_fail() -> None:
    findings = evaluate([dim(1, "diameter", "20")], MIN3)
    assert outcomes(findings) == [("THK-MIN-001", MISSING, ())]
    assert findings[0].actual is None
    assert findings[0].evidence == ()


def test_required_rule_without_annotation_is_missing() -> None:
    assert outcomes(evaluate([dim(1, "thickness", "4")], MAT_REQ)) == [("MAT-REQ-001", MISSING, ())]


def test_empty_drawing_gives_one_missing_finding_per_rule() -> None:
    rules = ruleset(
        range_rule("thickness", min_mm="3", rid="A-1"), required_rule("material", rid="B-1")
    )
    assert outcomes(evaluate([], rules)) == [("A-1", MISSING, ()), ("B-1", MISSING, ())]


# ------------------------------------- single-valued: thickness and material


def test_identical_thickness_duplicates_are_one_effective_value() -> None:
    m = [dim(1, "thickness", "4"), dim(2, "thickness", "0.4", "cm")]  # both exactly 4 mm
    assert outcomes(evaluate(m, MIN3)) == [("THK-MIN-001", PASS, ("M1", "M2"))]


def test_identical_failing_duplicates_give_one_failure() -> None:
    m = [dim(1, "thickness", "2"), dim(2, "thickness", "2.0")]
    assert outcomes(evaluate(m, MIN3)) == [("THK-MIN-001", FAIL, ("M1", "M2"))]


@pytest.mark.parametrize(("a", "b"), [("4", "6"), ("2", "4"), ("1", "2"), ("4", "4.01")])
def test_conflicting_thickness_is_needs_review_never_pass_or_fail(a: str, b: str) -> None:
    m = [dim(1, "thickness", a), dim(2, "thickness", b)]
    findings = evaluate(m, MIN3)
    assert outcomes(findings) == [("THK-MIN-001", REVIEW, ("M1", "M2"))]
    assert "conflict" in findings[0].message.lower()


def test_parsed_plus_ambiguous_thickness_is_needs_review() -> None:
    m = [dim(1, "thickness", "4"), unreadable(2, "thickness")]
    assert outcomes(evaluate(m, MIN3)) == [("THK-MIN-001", REVIEW, ("M1", "M2"))]


def test_only_ambiguous_thickness_is_one_needs_review_finding() -> None:
    m = [unreadable(1, "thickness"), unreadable(2, "thickness", "decimal_comma")]
    findings = evaluate(m, MIN3)
    assert outcomes(findings) == [("THK-MIN-001", REVIEW, ("M1", "M2"))]
    assert "missing_unit" in (findings[0].actual or "")


def test_material_present_passes_presence_only() -> None:
    findings = evaluate([mat(1, "SS400")], MAT_REQ)
    assert outcomes(findings) == [("MAT-REQ-001", PASS, ("M1",))]
    message = findings[0].message.lower()
    assert "presence" in message and "not" in message  # says the grade is not checked


def test_identical_material_duplicates_pass_once() -> None:
    assert outcomes(evaluate([mat(1, "SS400"), mat(2, "SS400")], MAT_REQ)) == [
        ("MAT-REQ-001", PASS, ("M1", "M2"))
    ]


def test_conflicting_materials_are_needs_review() -> None:
    findings = evaluate([mat(1, "SS400"), mat(2, "S45C")], MAT_REQ)
    assert outcomes(findings) == [("MAT-REQ-001", REVIEW, ("M1", "M2"))]
    assert "SS400" in (findings[0].actual or "") and "S45C" in (findings[0].actual or "")
    # Different wording is not claimed to be a contradiction: equivalence is unverified.
    assert (findings[0].actual or "").startswith("different material descriptions:")
    assert "conflict" not in findings[0].message.lower()
    assert "not verified" in findings[0].message and "review" in findings[0].message


def test_parsed_plus_ambiguous_material_is_needs_review() -> None:
    m = [mat(1, "SS400"), mat(2, None, "missing_value")]
    assert outcomes(evaluate(m, MAT_REQ)) == [("MAT-REQ-001", REVIEW, ("M1", "M2"))]


def test_only_ambiguous_material_is_needs_review_not_missing() -> None:
    assert outcomes(evaluate([mat(1, None, "missing_value")], MAT_REQ)) == [
        ("MAT-REQ-001", REVIEW, ("M1",))
    ]


def test_required_thickness_with_conflict_is_needs_review() -> None:
    rules = ruleset(required_rule("thickness"))
    m = [dim(1, "thickness", "4"), dim(2, "thickness", "6")]
    assert outcomes(evaluate(m, rules)) == [("Q-1", REVIEW, ("M1", "M2"))]


# ------------------------------------------ multi-valued: diameter and length


def test_each_diameter_is_evaluated_on_its_own() -> None:
    m = [dim(1, "diameter", "20"), dim(2, "diameter", "65"), dim(3, "diameter", "50")]
    assert outcomes(evaluate(m, MAX50)) == [
        ("DIA-MAX-001", PASS, ("M1",)),
        ("DIA-MAX-001", FAIL, ("M2",)),
        ("DIA-MAX-001", PASS, ("M3",)),
    ]


def test_ambiguous_diameter_is_its_own_needs_review_finding() -> None:
    m = [dim(1, "diameter", "20"), unreadable(2, "diameter"), dim(3, "diameter", "65")]
    assert outcomes(evaluate(m, MAX50)) == [
        ("DIA-MAX-001", PASS, ("M1",)),
        ("DIA-MAX-001", REVIEW, ("M2",)),
        ("DIA-MAX-001", FAIL, ("M3",)),
    ]


def test_repeated_identical_diameters_are_separate_holes() -> None:
    m = [dim(1, "diameter", "20"), dim(2, "diameter", "20")]
    assert outcomes(evaluate(m, MAX50)) == [
        ("DIA-MAX-001", PASS, ("M1",)),
        ("DIA-MAX-001", PASS, ("M2",)),
    ]


def test_required_multi_valued_passes_on_any_readable_instance() -> None:
    rules = ruleset(required_rule("diameter"))
    m = [unreadable(1, "diameter"), dim(2, "diameter", "20")]
    # The readable instance satisfies presence; the unreadable one is not cited.
    assert outcomes(evaluate(m, rules)) == [("Q-1", PASS, ("M2",))]


def test_required_multi_valued_with_only_unreadable_instances_needs_review() -> None:
    rules = ruleset(required_rule("length"))
    assert outcomes(evaluate([unreadable(1, "length")], rules)) == [("Q-1", REVIEW, ("M1",))]


# ----------------------------------------------- ordering and identifiers


def test_findings_follow_rule_order_then_measurement_order() -> None:
    rules = ruleset(
        required_rule("material", rid="Z-1"),
        range_rule("diameter", max_mm="50", rid="A-1"),
    )
    m = [dim(10, "diameter", "20"), dim(9, "diameter", "30"), mat(2, "SS400")]
    findings = evaluate(m, rules)
    assert [f.id for f in findings] == ["F1", "F2", "F3"]
    assert outcomes(findings) == [
        ("Z-1", PASS, ("M2",)),
        ("A-1", PASS, ("M9",)),  # M9 before M10: numeric, not text, order
        ("A-1", PASS, ("M10",)),
    ]


def test_evaluation_is_deterministic_and_independent_of_input_order() -> None:
    m: list[Measurement] = [
        dim(1, "thickness", "4"),
        dim(2, "diameter", "20"),
        dim(3, "diameter", "70"),
        mat(4, "SS400"),
        unreadable(5, "length"),
    ]
    rules = ruleset(
        range_rule("thickness", min_mm="3", rid="A-1"),
        range_rule("diameter", max_mm="50", rid="B-1"),
        range_rule("length", min_mm="10", rid="C-1"),
        required_rule("material", rid="D-1"),
    )
    first = evaluate(m, rules)
    for permutation in itertools.permutations(m):
        assert evaluate(list(permutation), rules) == first


def test_rules_only_consider_their_own_measurement_type() -> None:
    m = [dim(1, "diameter", "1"), dim(2, "length", "1")]
    assert outcomes(evaluate(m, MIN3)) == [("THK-MIN-001", MISSING, ())]


# ------------------------------------------------- evidence and explanation


def test_evidence_is_copied_from_each_referenced_measurement() -> None:
    m = [dim(1, "thickness", "4"), dim(2, "thickness", "4")]
    f = evaluate(m, MIN3)[0]
    assert [(e.measurement_id, e.page_number, e.bbox) for e in f.evidence] == [
        (x.id, x.source.page_number, x.source.bbox) for x in m
    ]


def test_missing_location_stays_missing_in_evidence() -> None:
    m = dim(1, "thickness", "4", src=source("THICKNESS: 4 mm", bbox=False))
    assert evaluate([m], MIN3)[0].evidence[0].bbox is None


def test_finding_carries_rule_description_severity_and_threshold() -> None:
    f = evaluate(
        [dim(1, "length", "600")],
        ruleset(range_rule("length", min_mm="10", max_mm="500", severity="warning")),
    )[0]
    assert f.rule_description == "Range rule for length."
    assert f.severity is Severity.WARNING
    assert f.expected == "between 10 mm and 500 mm (inclusive)"
    assert f.actual == "600 mm"


@pytest.mark.parametrize(
    ("measurement", "rules", "expected", "actual", "message_parts"),
    [
        (dim(1, "thickness", "2"), MIN3, ">= 3 mm", "2 mm", ["2 mm", "below", "3 mm"]),
        (dim(1, "diameter", "65"), MAX50, "<= 50 mm", "65 mm", ["65 mm", "above", "50 mm"]),
        (
            dim(1, "thickness", "0.3", "cm"),
            MIN3,
            ">= 3 mm",
            "3 mm (written 0.3 cm)",
            ["meets", "0.3 cm"],
        ),
        (
            dim(1, "thickness", "0.1", "in"),
            MIN3,
            ">= 3 mm",
            "2.54 mm (written 0.1 in)",
            ["2.54 mm (written 0.1 in) is below"],
        ),
        (
            unreadable(1, "diameter"),
            MAX50,
            "<= 50 mm",
            "not readable: M1 (missing_unit)",
            ["could not be read"],
        ),
    ],
)
def test_explanations_state_threshold_actual_value_and_reason(
    measurement: Measurement, rules: Ruleset, expected: str, actual: str, message_parts: list[str]
) -> None:
    f = evaluate([measurement], rules)[0]
    assert f.expected == expected
    assert f.actual == actual
    for part in message_parts:
        assert part in f.message, f"{part!r} not in {f.message!r}"


def test_explanations_make_no_compliance_claims() -> None:
    m: list[Measurement] = [dim(1, "thickness", "4"), dim(2, "diameter", "65"), mat(3, "SS400")]
    rules = ruleset(
        range_rule("thickness", min_mm="3", rid="A-1"),
        range_rule("diameter", max_mm="50", rid="B-1"),
        required_rule("material", rid="C-1"),
    )
    for f in evaluate(m, rules):
        text = f"{f.message} {f.expected} {f.actual}".lower()
        for word in ("compliant", "compliance", "certified", "safe", "approved", "guarantee"):
            assert word not in text


# --------------------------------------- uncertainty never becomes confirmed


def _thickness_variants(n: int) -> list[Measurement]:
    return [dim(n, "thickness", "4"), dim(n, "thickness", "2"), unreadable(n, "thickness")]


@pytest.mark.parametrize("size", [1, 2, 3])
def test_no_combination_of_uncertain_or_conflicting_thickness_is_confirmed(size: int) -> None:
    """Exhaustive over every mix of passing, failing and unreadable annotations."""
    for combo in itertools.product(range(3), repeat=size):
        m = [_thickness_variants(i + 1)[choice] for i, choice in enumerate(combo)]
        findings = evaluate(m, MIN3)
        validated(m, findings)  # M1 validator: no pass/fail on an ambiguous measurement
        assert len(findings) == 1
        all_parsed = all(x.status is ExtractionStatus.PARSED for x in m)
        values = {x.normalized_value_mm for x in m if isinstance(x, DimensionMeasurement)}
        if not all_parsed or len(values) > 1:
            assert findings[0].status is REVIEW, combo


def test_every_result_is_a_valid_report() -> None:
    m: list[Measurement] = [
        dim(1, "thickness", "4"),
        unreadable(2, "thickness"),
        dim(3, "diameter", "65"),
        unreadable(4, "diameter"),
        mat(5, "SS400"),
        mat(6, "S45C"),
    ]
    rules = ruleset(
        range_rule("thickness", min_mm="3", rid="A-1"),
        range_rule("diameter", max_mm="50", rid="B-1"),
        range_rule("length", min_mm="10", rid="C-1"),
        required_rule("material", rid="D-1"),
    )
    report = validated(m, evaluate(m, rules))
    assert InspectionReport.model_validate_json(report.model_dump_json()) == report
    assert report.summary == FindingSummary(passed=0, failed=1, missing=1, needs_review=3)


# ------------------------------------------------ M4 review regressions


@pytest.mark.parametrize("count", [16, 40, 200])
def test_many_unreadable_annotations_still_give_one_valid_finding(count: int) -> None:
    m = [unreadable(i, "thickness", "ambiguous_unit_case") for i in range(1, count + 1)]
    findings = evaluate(m, MIN3)
    assert outcomes(findings) == [
        ("THK-MIN-001", REVIEW, tuple(f"M{i}" for i in range(1, count + 1)))
    ]
    assert f"{count - 3} more" in (findings[0].actual or "")
    validated(m, findings)


@pytest.mark.parametrize("dtype", ["diameter", "length"])
def test_required_with_many_unreadable_multi_valued_annotations(dtype: str) -> None:
    m = [unreadable(i, dtype) for i in range(1, 60)]
    findings = evaluate(m, ruleset(required_rule(dtype)))
    assert findings[0].status is REVIEW
    validated(m, findings)


@pytest.mark.parametrize("second", [("0.4", "cm"), ("4.0", "mm"), ("0.004", "m")])
def test_required_thickness_treats_equal_values_in_any_notation_as_one(
    second: tuple[str, str],
) -> None:
    m = [dim(1, "thickness", "4"), dim(2, "thickness", *second)]
    assert outcomes(evaluate(m, ruleset(required_rule("thickness")))) == [
        ("Q-1", PASS, ("M1", "M2"))
    ]
    assert outcomes(evaluate(m, MIN3)) == [("THK-MIN-001", PASS, ("M1", "M2"))]  # range agrees


def test_conflict_summary_names_every_distinct_value() -> None:
    m = [dim(i, "thickness", "4") for i in range(1, 10)] + [dim(10, "thickness", "2")]
    actual = evaluate(m, MIN3)[0].actual or ""
    assert "4 mm" in actual and "2 mm" in actual
    assert "M10" in actual


def test_many_conflicting_materials_stay_within_text_limits() -> None:
    m = [mat(i, f"GRADE-{i:04d}" + "X" * 50) for i in range(1, 300)]
    findings = evaluate(m, MAT_REQ)
    assert findings[0].status is REVIEW
    validated(m, findings)


def test_conflict_shows_converted_values_and_their_written_form() -> None:
    m = [dim(1, "thickness", "0.125", "in"), dim(2, "thickness", "3")]
    f = evaluate(m, MIN3)[0]
    assert f.actual == "conflicting values: 3 mm (M2); 3.175 mm (M1 as 0.125 in)"
    assert "3 mm, 3.175 mm (written 0.125 in)" in f.message


def test_conflicting_values_are_listed_in_numeric_not_text_order() -> None:
    m = [dim(1, "thickness", "10"), dim(2, "thickness", "9")]
    assert "(9 mm, 10 mm)" in evaluate(m, MIN3)[0].message


def test_equal_duplicates_mention_the_written_unit() -> None:
    m = [dim(1, "thickness", "3"), dim(2, "thickness", "0.3", "cm")]
    assert evaluate(m, MIN3)[0].actual == ("3 mm; 2 annotations, all the same value (M2 as 0.3 cm)")
    m = [dim(1, "thickness", "25.4"), dim(2, "thickness", "1", "in")]
    assert evaluate(m, ruleset(required_rule("thickness")))[0].actual == (
        "25.4 mm; 2 annotations, all the same value (M2 as 1 in)"
    )


@pytest.mark.parametrize(
    ("value", "shown"),
    [
        ("2.5400", "2.54 mm"),
        ("120.00", "120 mm"),
        ("100.000", "100 mm"),
        ("0.0000001", "0.0000001 mm"),
    ],
)
def test_numbers_are_shown_without_trailing_zeros_or_exponents(value: str, shown: str) -> None:
    f = evaluate([dim(1, "length", value)], LEN)[0]
    assert f.actual == shown


def test_required_single_valued_reports_the_value_not_a_count() -> None:
    m = [dim(1, "thickness", "4"), dim(2, "thickness", "4.0")]
    f = evaluate(m, ruleset(required_rule("thickness")))[0]
    assert f.actual == "4 mm; 2 annotations, all the same value"


def test_unreadable_wording_matches_the_number_of_annotations() -> None:
    one = evaluate([unreadable(1, "thickness")], MIN3)[0].message
    two = evaluate([unreadable(1, "thickness"), unreadable(2, "thickness")], MIN3)[0].message
    assert one.startswith("The thickness annotation could not be read")
    assert two.startswith("2 thickness annotations could not be read")
    mixed = evaluate([dim(1, "thickness", "4"), unreadable(2, "thickness")], MIN3)[0].message
    assert "A part has one thickness" in mixed and "drawing has only one" not in mixed


def test_explanation_length_guard_truncates_instead_of_failing() -> None:
    from blueprintiq.rules import engine

    text = engine._fit("x" * 2000)
    assert len(text) == 500 and text.endswith("...")
    assert engine._fit("short") == "short"


def test_long_conflict_lists_drop_whole_groups_and_keep_the_count() -> None:
    m = [
        dim(i * 5 + j, "thickness", f"{d}" * 19 + ".11", "in")
        for i, d in enumerate("123456", start=0)
        for j in range(1, 6)
    ]
    actual = evaluate(m, MIN3)[0].actual or ""
    assert len(actual) <= 500
    assert actual.endswith("more") and not actual.endswith("...")
