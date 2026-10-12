"""Per-request requirements: validation, the ruleset they build, and exact material codes."""

import json
from decimal import Decimal
from typing import Any, ClassVar
from urllib.parse import quote

import pytest

from blueprintiq.domain.models import FindingStatus
from blueprintiq.rules.config import RangeRule, RequiredRule, load_ruleset, parse_ruleset
from blueprintiq.rules.engine import evaluate
from blueprintiq.rules.requirements import (
    MAX_HEADER_CHARS,
    RequirementsError,
    parse_requirements,
)
from tests.unit.test_rules_engine import dim, mat, outcomes, unreadable

DEMO = {
    "version": 1,
    "min_thickness_mm": "3.0",
    "max_diameter_mm": "50.0",
    "min_length_mm": "10.0",
    "max_length_mm": "500.0",
    "material": {"required": True, "code": None},
}


def header(data: Any) -> str:
    return quote(json.dumps(data), safe="")


def rules_of(data: dict[str, Any]) -> list[tuple[Any, ...]]:
    ruleset = parse_requirements(header(data))
    return [
        (
            r.id,
            r.applies_to.value,
            r.severity.value,
            getattr(r, "min_mm", None),
            getattr(r, "max_mm", None),
        )
        for r in ruleset.rules
    ]


class TestParsing:
    def test_demonstration_values_build_the_same_rules_as_the_demo_file(self) -> None:
        from blueprintiq.api.settings import DEFAULT_RULESET

        demo = [
            (
                r.id,
                r.applies_to.value,
                r.severity.value,
                getattr(r, "min_mm", None),
                getattr(r, "max_mm", None),
            )
            for r in load_ruleset(DEFAULT_RULESET).rules
        ]
        assert rules_of(DEMO) == demo

    def test_thresholds_stay_exact_decimals(self) -> None:
        ruleset = parse_requirements(
            header(DEMO | {"min_thickness_mm": "2.35", "max_diameter_mm": "0.1"})
        )
        thickness, diameter = ruleset.rules[0], ruleset.rules[1]
        assert isinstance(thickness, RangeRule) and thickness.min_mm == Decimal("2.35")
        assert isinstance(diameter, RangeRule) and diameter.max_mm == Decimal("0.1")
        assert "2.35 mm" in thickness.description

    def test_the_ruleset_says_it_is_custom(self) -> None:
        ruleset = parse_requirements(header(DEMO))
        assert (ruleset.ruleset.id, ruleset.ruleset.version) == ("custom-requirements", "1")

    def test_every_requirement_is_optional(self) -> None:
        assert [r[0] for r in rules_of({"version": 1, "max_length_mm": "800"})] == ["LEN-RANGE-001"]
        assert [r[0] for r in rules_of({"version": 1, "material": {"required": True}})] == [
            "MAT-REQ-001"
        ]
        assert (
            rules_of({"version": 1, "min_thickness_mm": "5", "max_diameter_mm": None})[0][0]
            == "THK-MIN-001"
        )

    def test_material_code_is_normalised_like_the_drawing_text(self) -> None:
        ruleset = parse_requirements(
            header({"version": 1, "material": {"required": True, "code": " ss400 "}})
        )
        rule = ruleset.rules[0]
        assert isinstance(rule, RequiredRule) and rule.equals == "SS400"
        assert "SS400" in rule.description

    def test_a_header_is_percent_decoded(self) -> None:
        assert parse_requirements(quote('{"version":1,"min_thickness_mm":"4"}', safe=""))
        assert parse_requirements('{"version":1,"min_thickness_mm":"4"}')  # plain is accepted too

    @pytest.mark.parametrize(
        "bad",
        [
            "",
            "not json",
            "[]",
            "null",
            '"text"',
            "{" * 3000,  # nesting, but within the length limit
            '{"version": 1}',  # nothing to check
            '{"version": 2, "min_thickness_mm": "3"}',
            '{"min_thickness_mm": "3"}',  # no version
            '{"version": 1, "min_thickness_mm": 3}',  # a JSON number, not text
            '{"version": 1, "min_thickness_mm": "-1"}',
            '{"version": 1, "min_thickness_mm": "1e3"}',
            '{"version": 1, "min_thickness_mm": "3,5"}',
            '{"version": 1, "min_thickness_mm": " 3"}',
            '{"version": 1, "min_thickness_mm": "0.1234567"}',
            '{"version": 1, "min_thickness_mm": "1234567890123"}',
            '{"version": 1, "min_thickness_mm": "NaN"}',
            '{"version": 1, "min_thickness_mm": "03"}',
            '{"version": 1, "min_length_mm": "10", "max_length_mm": "9"}',
            '{"version": 1, "min_thickness_mm": "3", "surprise": 1}',
            '{"version": 1, "material": "SS400"}',
            '{"version": 1, "material": {"required": false}}',
            '{"version": 1, "material": {"required": true, "code": ""}}',
            '{"version": 1, "material": {"required": true, "code": "SS400;DROP"}}',
            '{"version": 1, "material": {"required": true, "code": "' + "A" * 33 + '"}}',
            '{"version": 1, "material": {"required": true, "extra": 1}}',
        ],
    )
    def test_unusable_requirements_are_refused(self, bad: str) -> None:
        with pytest.raises(RequirementsError) as caught:
            parse_requirements(quote(bad, safe=""))
        assert caught.value.problems

    def test_an_over_long_header_is_refused_before_parsing(self) -> None:
        with pytest.raises(RequirementsError, match="too long"):
            parse_requirements("x" * (MAX_HEADER_CHARS + 1))

    def test_problems_never_repeat_what_was_submitted(self) -> None:
        secret = "hunter2-" + "z" * 20
        for bad in (
            {"version": 1, "min_thickness_mm": secret},
            {"version": 1, "material": {"required": True, "code": secret + "!"}},
            {"version": 1, secret: 1},
        ):
            with pytest.raises(RequirementsError) as caught:
                parse_requirements(header(bad))
            assert secret not in " ".join(caught.value.problems)

    def test_all_problems_are_reported_together(self) -> None:
        with pytest.raises(RequirementsError) as caught:
            parse_requirements(
                header({"version": 1, "min_thickness_mm": "x", "max_diameter_mm": "y"})
            )
        assert len(caught.value.problems) == 2


def ruleset_for(**limits: Any):  # type: ignore[no-untyped-def]
    return parse_requirements(header({"version": 1, **limits}))


class TestDifferentRequirementsChangeOutcomes:
    def test_the_same_thickness_passes_or_fails_by_the_threshold(self) -> None:
        measurements = [dim(1, "thickness", "4")]
        for limit, expected in (
            ("3", FindingStatus.PASS),
            ("4", FindingStatus.PASS),
            ("4.01", FindingStatus.FAIL),
        ):
            findings = evaluate(measurements, ruleset_for(min_thickness_mm=limit))
            assert [f.status for f in findings] == [expected], limit

    def test_a_maximum_is_inclusive_and_exact(self) -> None:
        measurements = [dim(1, "diameter", "50")]
        assert (
            evaluate(measurements, ruleset_for(max_diameter_mm="50"))[0].status
            is FindingStatus.PASS
        )
        assert (
            evaluate(measurements, ruleset_for(max_diameter_mm="49.999999"))[0].status
            is FindingStatus.FAIL
        )

    def test_units_are_converted_before_comparing(self) -> None:
        measurements = [dim(1, "length", "0.3", unit="m")]  # 300 mm
        assert (
            evaluate(measurements, ruleset_for(max_length_mm="300"))[0].status is FindingStatus.PASS
        )
        assert (
            evaluate(measurements, ruleset_for(max_length_mm="299"))[0].status is FindingStatus.FAIL
        )

    def test_an_unchecked_requirement_produces_no_finding(self) -> None:
        measurements = [dim(1, "thickness", "1"), dim(2, "diameter", "999")]
        findings = evaluate(measurements, ruleset_for(min_thickness_mm="3"))
        assert [f.rule_id for f in findings] == ["THK-MIN-001"]

    def test_missing_measurements_are_missing_not_failed(self) -> None:
        findings = evaluate([], ruleset_for(min_thickness_mm="3", material={"required": True}))
        assert [f.status for f in findings] == [FindingStatus.MISSING, FindingStatus.MISSING]

    def test_an_ambiguous_measurement_is_never_a_verdict_whatever_the_threshold(self) -> None:
        measurements = [unreadable(1, "thickness")]
        for limit in ("0", "3", "1000"):
            findings = evaluate(measurements, ruleset_for(min_thickness_mm=limit))
            assert [f.status for f in findings] == [FindingStatus.NEEDS_REVIEW], limit


class TestExactMaterialCode:
    required: ClassVar[dict[str, Any]] = {"required": True, "code": "SS400"}

    def test_matching_code_passes_and_says_what_was_compared(self) -> None:
        findings = evaluate([mat(1, "SS400")], ruleset_for(material=self.required))
        assert outcomes(findings) == [("MAT-REQ-001", FindingStatus.PASS, ("M1",))]
        assert findings[0].expected == "a material annotation reading SS400"
        assert "matches the required code SS400" in findings[0].message
        assert "not check whether the material is suitable" in findings[0].message

    def test_a_different_code_fails_with_evidence(self) -> None:
        findings = evaluate([mat(1, "SUS304")], ruleset_for(material=self.required))
        assert outcomes(findings) == [("MAT-REQ-001", FindingStatus.FAIL, ("M1",))]
        assert findings[0].actual == "SUS304"
        assert "requirement is SS400" in findings[0].message

    def test_matching_ignores_case_and_edge_spaces_as_the_drawing_text_is_normalised(self) -> None:
        required = {"required": True, "code": " ss400"}
        assert (
            evaluate([mat(1, " ss400 ")], ruleset_for(material=required))[0].status
            is FindingStatus.PASS
        )

    def test_no_material_is_missing_and_unreadable_material_is_needs_review(self) -> None:
        assert evaluate([], ruleset_for(material=self.required))[0].status is FindingStatus.MISSING
        unclear = [mat(1, None, "missing_value")]
        assert (
            evaluate(unclear, ruleset_for(material=self.required))[0].status
            is FindingStatus.NEEDS_REVIEW
        )

    def test_conflicting_materials_are_needs_review_even_if_one_matches(self) -> None:
        findings = evaluate(
            [mat(1, "SS400"), mat(2, "SUS304")], ruleset_for(material=self.required)
        )
        assert findings[0].status is FindingStatus.NEEDS_REVIEW

    def test_without_a_code_it_still_only_checks_presence(self) -> None:
        findings = evaluate([mat(1, "ANYTHING")], ruleset_for(material={"required": True}))
        assert findings[0].status is FindingStatus.PASS
        assert findings[0].expected == "a readable material annotation"

    def test_equals_is_only_valid_for_material_in_a_toml_ruleset(self) -> None:
        text = (
            '[ruleset]\nid="t"\nversion="1"\ndescription="d"\n[[rules]]\nid="Q-1"\n'
            'kind="required"\napplies_to="thickness"\nseverity="error"\ndescription="d"\nequals="SS400"\n'
        )
        with pytest.raises(ValueError, match="equals is only valid for a material rule"):
            parse_ruleset(text)
