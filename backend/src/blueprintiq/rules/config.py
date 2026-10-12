"""Ruleset configuration: one TOML file, validated in full before any drawing is read.

Format (see demo_rules.toml in this package)::

    [ruleset]
    id = "demo-plate-part"
    version = "0.1.0"
    description = "Demonstration thresholds only."

    [[rules]]
    id = "THK-MIN-001"
    kind = "range"                 # or "required"
    applies_to = "thickness"       # thickness | diameter | length | material
    min_mm = 3.0                   # range only: min_mm and/or max_mm, inclusive
    severity = "error"             # error | warning | info
    description = "Plate thickness must be at least 3 mm."

Numbers are parsed with ``tomllib.loads(..., parse_float=Decimal)``, so ``3.0`` is
``Decimal("3.0")`` and never passes through binary float. Thresholds are always in
millimetres; any other key (``min_cm``, ``unit``) is rejected. Every problem in the
file is reported at once, each naming the rule and the field.
"""

import tomllib
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

from blueprintiq.domain.models import MeasurementType, Severity


class RulesetConfigError(ValueError):
    """The ruleset file is unreadable or invalid. ``problems`` lists every issue."""

    def __init__(self, source: str, problems: list[str]) -> None:
        self.source = source
        self.problems = tuple(problems)
        super().__init__(f"invalid ruleset {source}:\n" + "\n".join(f"  - {p}" for p in problems))


def _number_only(value: object) -> object:
    # TOML gives Decimal (floats, via parse_float) or int. Anything else - a bool, a
    # string such as "3.0", a date - is not a threshold, even if it looks like one.
    if isinstance(value, bool) or not isinstance(value, Decimal | int):
        raise ValueError(f"must be a number (got {type(value).__name__})")
    return value


def _non_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("must not be blank")
    return value


def _no_signed_zero(value: Decimal) -> Decimal:
    return value.copy_abs() if value == 0 else value  # -0.0 -> 0.0


Threshold = Annotated[
    Decimal,
    BeforeValidator(_number_only),
    Field(allow_inf_nan=False, ge=0, max_digits=30),
    AfterValidator(_no_signed_zero),
]
Text = Annotated[str, StringConstraints(max_length=500), AfterValidator(_non_blank)]
RuleId = Annotated[str, StringConstraints(pattern=r"^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$", max_length=64)]


class _Config(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class RangeRule(_Config):
    """Inclusive numeric bounds on every measurement of a dimension type (in mm)."""

    kind: Literal["range"]
    id: RuleId
    applies_to: MeasurementType
    min_mm: Threshold | None = None
    max_mm: Threshold | None = None
    severity: Severity
    description: Text

    @model_validator(mode="after")
    def _bounds(self) -> Self:
        if self.applies_to is MeasurementType.MATERIAL:
            raise ValueError("a range rule cannot apply to material (it has no number)")
        if self.min_mm is None and self.max_mm is None:
            raise ValueError("a range rule needs min_mm or max_mm")
        if self.min_mm is not None and self.max_mm is not None and self.min_mm > self.max_mm:
            raise ValueError(f"min_mm ({self.min_mm}) is greater than max_mm ({self.max_mm})")
        return self


class RequiredRule(_Config):
    """At least one readable annotation of the given type must be present."""

    kind: Literal["required"]
    id: RuleId
    applies_to: MeasurementType
    severity: Severity
    description: Text


Rule = Annotated[RangeRule | RequiredRule, Field(discriminator="kind")]


class RulesetHeader(_Config):
    id: Text
    version: Text
    description: Text


class Ruleset(_Config):
    ruleset: RulesetHeader
    rules: tuple[Rule, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique_ids(self) -> Self:
        seen: set[str] = set()
        for rule in self.rules:
            if rule.id in seen:
                raise ValueError(f"duplicate rule id {rule.id}")
            seen.add(rule.id)
        return self


def load_ruleset(path: Path) -> Ruleset:
    """Read and validate a ruleset file (UTF-8, optional BOM). Raises ``RulesetConfigError``."""
    try:
        raw = path.read_bytes()
    except OSError:
        raise RulesetConfigError(path.name, ["the file cannot be read"]) from None
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise RulesetConfigError(path.name, ["the file is not valid UTF-8 text"]) from None
    return parse_ruleset(text, source=path.name)


def parse_ruleset(text: str, *, source: str = "<text>") -> Ruleset:
    """Validate ruleset TOML text. Raises ``RulesetConfigError`` listing every problem."""
    try:
        data = tomllib.loads(text, parse_float=Decimal)
    except tomllib.TOMLDecodeError as exc:
        raise RulesetConfigError(source, [f"invalid TOML: {exc}"]) from None
    except ValueError:  # Python refuses to convert an integer this long
        raise RulesetConfigError(source, ["invalid TOML: a number has too many digits"]) from None
    except RecursionError:
        raise RulesetConfigError(source, ["invalid TOML: nested too deeply"]) from None
    problems = _duplicate_ids(data)
    try:
        ruleset = Ruleset.model_validate(data)
    except ValidationError as exc:
        problems += [p for p in _describe(exc, data) if "duplicate rule id" not in p]
    if problems:
        raise RulesetConfigError(source, problems)
    return ruleset


_UNIT_HINT = "thresholds are given in millimetres as min_mm / max_mm"
_ID_SHOWN = 40


def _rule_label(index: int, raw: object) -> str:
    rule_id = raw.get("id") if isinstance(raw, dict) else None
    if not isinstance(rule_id, str):
        return f"rules[{index}]"
    shown = rule_id if len(rule_id) <= _ID_SHOWN else rule_id[:_ID_SHOWN] + "..."
    return f"rules[{index}] ({shown})"


def _duplicate_ids(data: dict[str, Any]) -> list[str]:
    """Duplicate ids found in the raw file, so they are reported with every other problem."""
    rules = data.get("rules")
    if not isinstance(rules, list):
        return []
    first: dict[str, int] = {}
    problems: list[str] = []
    for index, raw in enumerate(rules):
        rule_id = raw.get("id") if isinstance(raw, dict) else None
        if not isinstance(rule_id, str):
            continue
        if rule_id in first:
            problems.append(f"{_rule_label(index, raw)}: id: duplicate of rules[{first[rule_id]}]")
        else:
            first[rule_id] = index
    return problems


def _describe(exc: ValidationError, data: dict[str, Any]) -> list[str]:
    """Turn Pydantic errors into one line each: where, which field, what is wrong."""
    raw_rules = data.get("rules")
    rules: list[Any] = raw_rules if isinstance(raw_rules, list) else []
    errors = exc.errors()
    rule_errors = any(len(e["loc"]) > 1 and e["loc"][0] == "rules" for e in errors)
    problems: list[str] = []
    for error in errors:
        loc = list(error["loc"])
        kind = error["type"]
        # Pydantic also reports "too few rules" after dropping invalid ones; that is
        # noise when the individual rules already explain what is wrong.
        if rule_errors and loc == ["rules"] and kind == "too_short":
            continue
        where = "file"
        if loc[:1] == ["rules"] and len(loc) > 1 and isinstance(loc[1], int):
            index = loc[1]
            where = _rule_label(index, rules[index] if index < len(rules) else None)
            loc = loc[2:]
            if loc and loc[0] in ("range", "required"):  # discriminator tag
                loc = loc[1:]
        elif loc:
            where = str(loc[0])
            loc = loc[1:]
        field = ".".join(str(part) for part in loc)
        if kind == "extra_forbidden" and field in ("min_mm", "max_mm"):
            message = "a required rule takes no thresholds (min_mm / max_mm are for kind = 'range')"
        elif kind == "extra_forbidden" and where == "ruleset" and field == "rules":
            message = "unknown key (write each rule as its own [[rules]] table)"
        elif kind == "extra_forbidden":
            message = "unknown key"
            if field.startswith(("min_", "max_")) or field == "unit":
                message += f" ({_UNIT_HINT})"
        elif kind in ("union_tag_not_found", "union_tag_invalid"):
            field = field or "kind"
            message = "kind must be 'range' or 'required'"
        elif where == "rules" and not field and kind in ("tuple_type", "list_type"):
            message = "must be a list of rules: write each rule as its own [[rules]] table"
        else:
            message = str(error["msg"]).removeprefix("Value error, ")
        problems.append(f"{where}: {field + ': ' if field else ''}{message}")
    return problems
