"""Ruleset configuration: TOML -> validated, Decimal-exact rules, or a clear error."""

from decimal import Decimal
from pathlib import Path

import pytest

from blueprintiq.domain.models import MeasurementType, Severity
from blueprintiq.rules.config import (
    RangeRule,
    RequiredRule,
    RulesetConfigError,
    load_ruleset,
    parse_ruleset,
)

BACKEND = Path(__file__).resolve().parents[2]
DEMO = BACKEND / "src" / "blueprintiq" / "rules" / "demo_rules.toml"
TEST_RULES = BACKEND / "tests" / "fixtures" / "rules" / "test_rules.toml"

HEADER = """
[ruleset]
id = "t"
version = "1"
description = "test"
"""


def rules_toml(*rules: str) -> str:
    return HEADER + "".join(f"\n[[rules]]\n{r.strip()}\n" for r in rules)


THK = """
id = "THK-MIN-001"
kind = "range"
applies_to = "thickness"
min_mm = 3.0
severity = "error"
description = "Thickness at least 3 mm."
"""


def problems(text: str) -> str:
    with pytest.raises(RulesetConfigError) as excinfo:
        parse_ruleset(text)
    return str(excinfo.value)


# ------------------------------------------------------------------ valid files


@pytest.mark.parametrize("path", [DEMO, TEST_RULES])
def test_shipped_rulesets_load(path: Path) -> None:
    ruleset = load_ruleset(path)
    assert [r.id for r in ruleset.rules] == [
        "THK-MIN-001",
        "DIA-MAX-001",
        "LEN-RANGE-001",
        "MAT-REQ-001",
    ]
    assert "not" in ruleset.ruleset.description.lower()  # says it is not a standard


def test_demo_and_test_rulesets_start_with_the_same_rules() -> None:
    assert load_ruleset(DEMO).rules == load_ruleset(TEST_RULES).rules


def test_rules_are_typed_and_keep_their_order() -> None:
    ruleset = load_ruleset(TEST_RULES)
    thk, dia, length, mat = ruleset.rules
    assert isinstance(thk, RangeRule) and thk.applies_to is MeasurementType.THICKNESS
    assert (thk.min_mm, thk.max_mm) == (Decimal("3.0"), None)
    assert isinstance(dia, RangeRule) and (dia.min_mm, dia.max_mm) == (None, Decimal("50.0"))
    assert isinstance(length, RangeRule) and length.severity is Severity.WARNING
    assert isinstance(mat, RequiredRule) and mat.applies_to is MeasurementType.MATERIAL


@pytest.mark.parametrize(
    ("literal", "expected"),
    [("0.1", "0.1"), ("3", "3"), ("50.01", "50.01"), ("0.07", "0.07"), ("1e1", "1E+1")],
)
def test_thresholds_are_exact_decimals_never_floats(literal: str, expected: str) -> None:
    ruleset = parse_ruleset(rules_toml(THK.replace("min_mm = 3.0", f"min_mm = {literal}")))
    value = ruleset.rules[0].min_mm  # type: ignore[union-attr]
    assert isinstance(value, Decimal)
    assert str(value) == expected


def test_equal_bounds_are_allowed() -> None:
    rule = THK.replace("min_mm = 3.0", "min_mm = 4.0\nmax_mm = 4")
    assert parse_ruleset(rules_toml(rule)).rules[0].max_mm == Decimal("4")  # type: ignore[union-attr]


def test_required_rule_may_target_a_dimension() -> None:
    rule = (
        'id = "DIA-REQ-001"\nkind = "required"\napplies_to = "diameter"\n'
        'severity = "info"\ndescription = "x"'
    )
    assert isinstance(parse_ruleset(rules_toml(rule)).rules[0], RequiredRule)


# -------------------------------------------------------------- invalid files


@pytest.mark.parametrize(
    ("change", "fragments"),
    [
        (("min_mm = 3.0", "min_mm = nan"), ["THK-MIN-001", "min_mm"]),
        (("min_mm = 3.0", "min_mm = inf"), ["THK-MIN-001", "min_mm"]),
        (("min_mm = 3.0", "min_mm = -inf"), ["THK-MIN-001", "min_mm"]),
        (("min_mm = 3.0", "min_mm = true"), ["THK-MIN-001", "min_mm", "number"]),
        (("min_mm = 3.0", 'min_mm = "3.0"'), ["THK-MIN-001", "min_mm", "number"]),
        (("min_mm = 3.0", "min_mm = -1.0"), ["THK-MIN-001", "min_mm"]),
        (("min_mm = 3.0", "min_mm = 1970-01-01"), ["THK-MIN-001", "min_mm"]),
        (("min_mm = 3.0", "min_mm = 5.0\nmax_mm = 4.0"), ["THK-MIN-001", "min_mm", "max_mm"]),
        (("min_mm = 3.0", ""), ["THK-MIN-001", "min_mm or max_mm"]),
        (("min_mm = 3.0", "min_cm = 0.3"), ["THK-MIN-001", "min_cm", "millimetres"]),
        (("min_mm = 3.0", 'min_mm = 3.0\nunit = "cm"'), ["THK-MIN-001", "unit"]),
        (('applies_to = "thickness"', 'applies_to = "hardness"'), ["THK-MIN-001", "applies_to"]),
        (('applies_to = "thickness"', 'applies_to = "material"'), ["THK-MIN-001", "material"]),
        (('kind = "range"', 'kind = "maximum"'), ["THK-MIN-001", "kind"]),
        (('kind = "range"\n', ""), ["THK-MIN-001", "kind"]),
        (('severity = "error"', 'severity = "fatal"'), ["THK-MIN-001", "severity"]),
        (('id = "THK-MIN-001"', 'id = "thk min"'), ["id"]),
        (
            ('description = "Thickness at least 3 mm."', 'description = "  "'),
            ["THK-MIN-001", "description"],
        ),
    ],
)
def test_invalid_rule_is_rejected_with_a_specific_message(
    change: tuple[str, str], fragments: list[str]
) -> None:
    old, new = change
    assert old in THK
    message = problems(rules_toml(THK.replace(old, new)))
    for fragment in fragments:
        assert fragment in message, f"{fragment!r} not in: {message}"


def test_duplicate_rule_ids_are_rejected() -> None:
    assert "rules[1] (THK-MIN-001): id: duplicate of rules[0]" in problems(rules_toml(THK, THK))


def test_range_bounds_on_a_required_rule_are_rejected() -> None:
    rule = (
        'id = "MAT-REQ-001"\nkind = "required"\napplies_to = "material"\n'
        'severity = "error"\ndescription = "x"\nmin_mm = 1'
    )
    assert "MAT-REQ-001" in problems(rules_toml(rule))


@pytest.mark.parametrize(
    ("text", "fragment"),
    [
        (HEADER, "rules"),  # no rules at all
        (rules_toml(THK).replace('[ruleset]\nid = "t"', "[ruleset]"), "ruleset"),
        ("[[rules]]\n" + THK, "ruleset"),
        (rules_toml(THK) + "\nextra = 1\n", "extra"),
        ("this is = = not toml", "TOML"),
        ("", "ruleset"),
    ],
)
def test_malformed_files_are_rejected(text: str, fragment: str) -> None:
    assert fragment in problems(text)


def test_every_problem_is_reported_not_just_the_first() -> None:
    bad = THK.replace("min_mm = 3.0", "min_mm = nan").replace(
        'severity = "error"', 'severity = "x"'
    )
    message = problems(rules_toml(bad))
    assert "min_mm" in message and "severity" in message


def test_missing_file_is_a_config_error(tmp_path: Path) -> None:
    with pytest.raises(RulesetConfigError, match="cannot be read"):
        load_ruleset(tmp_path / "nope.toml")


def test_config_error_names_the_source_file(tmp_path: Path) -> None:
    path = tmp_path / "bad.toml"
    path.write_text(rules_toml(THK, THK), encoding="utf-8")
    with pytest.raises(RulesetConfigError, match=r"bad\.toml"):
        load_ruleset(path)


def test_invalid_rules_do_not_also_claim_the_file_has_no_rules() -> None:
    message = problems(rules_toml(THK.replace("min_mm = 3.0", "min_mm = nan")))
    assert "at least 1" not in message


@pytest.mark.parametrize("literal", ["-0.0", "-0", "0.0"])
def test_zero_thresholds_are_normalized_without_a_sign(literal: str) -> None:
    rule = THK.replace("min_mm = 3.0", f"min_mm = 0\nmax_mm = {literal}")
    max_mm = parse_ruleset(rules_toml(rule)).rules[0].max_mm  # type: ignore[union-attr]
    assert max_mm == 0 and not max_mm.is_signed()


# --------------------------------------------------- M4 review regressions


def test_thresholds_on_a_required_rule_get_a_specific_message() -> None:
    rule = (
        'id = "MAT-REQ-001"\nkind = "required"\napplies_to = "material"\n'
        'severity = "error"\ndescription = "x"\nmin_mm = 1'
    )
    message = problems(rules_toml(rule))
    assert "required rule takes no thresholds" in message
    assert "given in millimetres" not in message


@pytest.mark.parametrize(
    "data",
    [
        "MATERIAL caf\u00e9".encode("latin-1"),  # not UTF-8
        rules_toml(THK).encode("utf-16"),
    ],
    ids=["latin-1", "utf-16"],
)
def test_undecodable_file_is_a_config_error(tmp_path: Path, data: bytes) -> None:
    path = tmp_path / "rules.toml"
    path.write_bytes(data)
    with pytest.raises(RulesetConfigError, match="UTF-8"):
        load_ruleset(path)


def test_utf8_byte_order_mark_is_accepted(tmp_path: Path) -> None:
    path = tmp_path / "rules.toml"
    path.write_bytes(b"\xef\xbb\xbf" + rules_toml(THK).encode("utf-8"))
    assert load_ruleset(path).rules[0].id == "THK-MIN-001"


@pytest.mark.parametrize(
    "text",
    [
        rules_toml(THK.replace("min_mm = 3.0", "min_mm = " + "9" * 5000)),  # int too long
        "x = " + "[" * 5000 + "]" * 5000,  # nested too deeply
    ],
    ids=["integer-too-long", "nested-too-deeply"],
)
def test_pathological_toml_is_a_config_error_not_a_crash(text: str) -> None:
    with pytest.raises(RulesetConfigError):
        parse_ruleset(text)


def test_duplicate_ids_are_reported_together_with_other_problems() -> None:
    other = THK.replace('id = "THK-MIN-001"', 'id = "R-2"').replace("min_mm = 3.0", "min_mm = -1")
    message = problems(rules_toml(THK, other, THK))
    assert "rules[2] (THK-MIN-001): id: duplicate of rules[0]" in message
    assert "R-2" in message and "min_mm" in message


def test_rules_written_as_a_single_table_get_a_hint() -> None:
    text = HEADER + "\n[rules]\n" + THK
    assert "[[rules]]" in problems(text)


def test_rules_array_inside_the_ruleset_table_gets_a_hint() -> None:
    text = HEADER + 'rules = [{id = "X"}]\n'
    assert "[[rules]]" in problems(text)


def test_a_very_long_invalid_id_is_not_echoed_in_full() -> None:
    message = problems(rules_toml(THK.replace('id = "THK-MIN-001"', 'id = "' + "A" * 2000 + '"')))
    assert "A" * 100 not in message


def test_ruleset_model_rejects_duplicates_even_when_built_directly() -> None:
    from pydantic import ValidationError

    from blueprintiq.rules.config import Ruleset

    rule = parse_ruleset(rules_toml(THK)).rules[0]
    header = {"id": "t", "version": "1", "description": "d"}
    with pytest.raises(ValidationError, match="duplicate rule id"):
        Ruleset(ruleset=header, rules=(rule, rule))  # type: ignore[arg-type]


def test_too_long_integer_message_gives_no_interpreter_advice() -> None:
    message = problems(rules_toml(THK.replace("min_mm = 3.0", "min_mm = " + "9" * 5000)))
    assert "too many digits" in message and "sys." not in message
