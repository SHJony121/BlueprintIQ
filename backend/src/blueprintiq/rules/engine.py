"""Deterministic rule evaluation (layer E): measurements x rules -> findings.

Policy (docs/design/phase1-mvp-spec.md sections 7, 12.B and 16):

* A rule only looks at measurements of its ``applies_to`` type. None of that type
  -> one ``missing`` finding.
* Thickness and material are **single-valued**: all their annotations are judged
  together as one value, giving one finding per rule.
    - all readable and equal (exact Decimal in mm / exact text)  -> pass or fail, citing all
    - readable values that differ                                -> needs_review (conflict)
    - any unreadable annotation among them                       -> needs_review
* Diameter and length are **multi-valued**: each annotation gets its own finding;
  an unreadable one gets ``needs_review``.
* ``required`` on a multi-valued type passes if any annotation is readable (citing
  only those); with only unreadable ones it needs review.
* ``pass`` / ``fail`` only ever rest on parsed measurements; the M1 report
  validator enforces this independently.
* Order: rules in file order; within a rule, measurements in id order (M2 before
  M10). Finding ids are F1..Fn in that order.

Explanations are fixed templates. They state the threshold, the value read (with
the unit it was written in, when converted), and the reason. They never claim
compliance, safety, or suitability of a material. Numbers are shown in plain
decimal notation without trailing zeros; the exact values stay in the measurements.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from decimal import Decimal

from blueprintiq.domain.models import (
    SINGLE_VALUED_TYPES,
    DimensionMeasurement,
    EvidenceRef,
    ExtractionStatus,
    Finding,
    FindingStatus,
    MaterialAnnotation,
    Measurement,
    MeasurementType,
    measurement_type,
)
from blueprintiq.domain.units import LengthUnit
from blueprintiq.rules.config import RangeRule, RequiredRule, Ruleset

Rule = RangeRule | RequiredRule
_GROUPS_SHOWN = 4  # distinct values named in one explanation; the rest are counted
_IDS_SHOWN = 3  # measurement ids named per value
_MAX_TEXT = 500  # Finding text field limit; explanations are kept below it


@dataclass(frozen=True, slots=True)
class _Outcome:
    rule: Rule
    status: FindingStatus
    measurements: tuple[Measurement, ...]
    actual: str | None
    message: str


def evaluate(measurements: Iterable[Measurement], ruleset: Ruleset) -> tuple[Finding, ...]:
    """Evaluate every rule. Pure and deterministic: input order does not matter."""
    ordered = sorted(measurements, key=lambda m: int(m.id[1:]))
    outcomes: list[_Outcome] = []
    for rule in ruleset.rules:
        group = [m for m in ordered if measurement_type(m) is rule.applies_to]
        if isinstance(rule, RangeRule):
            outcomes.extend(_range(rule, group))
        else:
            outcomes.extend(_required(rule, group))
    return tuple(_finding(f"F{i}", o) for i, o in enumerate(outcomes, start=1))


# ------------------------------------------------------------------ range


def _range(rule: RangeRule, group: list[Measurement]) -> list[_Outcome]:
    name = rule.applies_to.value
    if not group:
        return [
            _missing(rule, f"No {name} annotation was found, so this rule could not be checked.")
        ]
    if rule.applies_to in SINGLE_VALUED_TYPES:
        return [_range_single(rule, group)]
    return [_range_one(rule, m) for m in group]


def _range_single(rule: RangeRule, group: list[Measurement]) -> _Outcome:
    unreadable = [m for m in group if m.status is ExtractionStatus.AMBIGUOUS]
    if unreadable:
        return _unreadable(rule, group, unreadable)
    dims = [m for m in group if isinstance(m, DimensionMeasurement)]
    if len({_mm(m) for m in dims}) > 1:
        return _conflict(rule, group, dims)
    outcome = _range_one(rule, dims[0])
    if len(dims) == 1:
        return outcome
    actual = f"{outcome.actual}; {len(dims)} annotations, all the same value"
    actual += _converted_note(dims[1:])
    return _Outcome(rule, outcome.status, tuple(group), actual, outcome.message)


def _range_one(rule: RangeRule, m: Measurement) -> _Outcome:
    if not isinstance(m, DimensionMeasurement) or m.status is ExtractionStatus.AMBIGUOUS:
        return _unreadable(rule, [m], [m])
    value = _mm(m)
    reading = _reading(m)
    name = rule.applies_to.value.capitalize()
    if rule.min_mm is not None and value < rule.min_mm:
        message = f"{name} {reading} is below the configured minimum of {_num(rule.min_mm)} mm."
        return _Outcome(rule, FindingStatus.FAIL, (m,), reading, message)
    if rule.max_mm is not None and value > rule.max_mm:
        message = f"{name} {reading} is above the configured maximum of {_num(rule.max_mm)} mm."
        return _Outcome(rule, FindingStatus.FAIL, (m,), reading, message)
    message = f"{name} {reading} meets the configured limit ({_expected(rule)})."
    return _Outcome(rule, FindingStatus.PASS, (m,), reading, message)


# --------------------------------------------------------------- required


def _required(rule: RequiredRule, group: list[Measurement]) -> list[_Outcome]:
    name = rule.applies_to.value
    if not group:
        return [_missing(rule, f"No {name} annotation was found; this rule requires one.")]
    readable = [m for m in group if m.status is ExtractionStatus.PARSED]
    unreadable = [m for m in group if m.status is ExtractionStatus.AMBIGUOUS]
    single = rule.applies_to in SINGLE_VALUED_TYPES

    if single and unreadable:
        return [_unreadable(rule, group, unreadable)]
    if not single and not readable:
        return [_unreadable(rule, group, unreadable)]
    if single and len({_key(m) for m in readable}) > 1:
        return [_conflict(rule, group, readable)]

    cited = group if single else readable
    if single:
        actual = _reading(readable[0])
        if len(readable) > 1:
            actual += f"; {len(readable)} annotations, all the same value"
            actual += _converted_note(readable[1:])
    else:
        actual = f"{len(readable)} readable {name} {_plural('annotation', len(readable))}"
    if rule.applies_to is MeasurementType.MATERIAL:
        message = (
            f"A material annotation is present ({_reading(readable[0])}). This checks presence "
            "only; it does not check whether the material is suitable."
        )
    else:
        message = f"A readable {name} annotation is present. This checks presence only."
    return [_Outcome(rule, FindingStatus.PASS, tuple(cited), actual, message)]


# ---------------------------------------------------------------- shared


def _missing(rule: Rule, message: str) -> _Outcome:
    return _Outcome(rule, FindingStatus.MISSING, (), None, message)


def _conflict(
    rule: Rule, cited: Sequence[Measurement], readable: Sequence[Measurement]
) -> _Outcome:
    name = rule.applies_to.value
    groups = _groups(readable)
    values = ", ".join(_reading(ms[0]) for ms in groups[:_GROUPS_SHOWN]) + _more(groups)
    # Show as many value groups as fit, always keeping the count of the rest.
    for shown in range(min(_GROUPS_SHOWN, len(groups)), 0, -1):
        actual = "conflicting values: " + "; ".join(
            f"{_reading_mm(ms[0])} ({_ids(ms)})" for ms in groups[:shown]
        )
        actual += f" and {len(groups) - shown} more" if len(groups) > shown else ""
        if len(actual) <= _MAX_TEXT:
            break
    outcome = "the requirement is not reported as met" if isinstance(rule, RequiredRule) else (
        "no pass or fail is reported"
    )  # fmt: skip
    message = (
        f"The drawing gives conflicting {name} values ({values}). A part has one {name}, so "
        f"{outcome}; check which value is intended."
    )
    return _Outcome(rule, FindingStatus.NEEDS_REVIEW, tuple(cited), actual, message)


def _unreadable(
    rule: Rule, cited: Sequence[Measurement], unreadable: Sequence[Measurement]
) -> _Outcome:
    name = rule.applies_to.value
    shown = ", ".join(
        f"{m.id} ({', '.join(i.value for i in m.issues)})" for m in unreadable[:_IDS_SHOWN]
    )
    more = f" and {len(unreadable) - _IDS_SHOWN} more" if len(unreadable) > _IDS_SHOWN else ""
    actual = f"not readable: {shown}{more}"
    count = len(unreadable)
    noun = (
        f"{count} {name} {_plural('annotation', count)}" if count > 1 else f"The {name} annotation"
    )
    readable = len(cited) - count
    if readable and rule.applies_to in SINGLE_VALUED_TYPES:
        message = (
            f"{noun} could not be read reliably ({shown}{more}). A part has one {name}, so the "
            "readable value cannot be confirmed either; no pass or fail is reported."
        )
    else:
        message = f"{noun} could not be read reliably ({shown}{more}); no pass or fail is reported."
    if isinstance(rule, RequiredRule):
        message = message.replace(
            "no pass or fail is reported", "the requirement is not reported as met"
        )
    return _Outcome(rule, FindingStatus.NEEDS_REVIEW, tuple(cited), actual, message)


def _finding(finding_id: str, o: _Outcome) -> Finding:
    expected = (
        _expected(o.rule)
        if isinstance(o.rule, RangeRule)
        else f"a readable {o.rule.applies_to.value} annotation"
    )
    return Finding(
        id=finding_id,
        rule_id=o.rule.id,
        rule_description=o.rule.description,
        status=o.status,
        severity=o.rule.severity,
        measurement_ids=tuple(m.id for m in o.measurements),
        evidence=tuple(
            EvidenceRef(measurement_id=m.id, page_number=m.source.page_number, bbox=m.source.bbox)
            for m in o.measurements
        ),
        expected=expected,
        actual=_fit(o.actual) if o.actual is not None else None,
        message=_fit(o.message),
    )


# ------------------------------------------------------------ formatting


def _expected(rule: RangeRule) -> str:
    if rule.min_mm is not None and rule.max_mm is not None:
        return f"between {_num(rule.min_mm)} mm and {_num(rule.max_mm)} mm (inclusive)"
    if rule.min_mm is not None:
        return f">= {_num(rule.min_mm)} mm"
    assert rule.max_mm is not None  # a range rule always has a bound (config validates)
    return f"<= {_num(rule.max_mm)} mm"


def _mm(m: DimensionMeasurement) -> Decimal:
    assert m.normalized_value_mm is not None  # guaranteed for parsed measurements
    return m.normalized_value_mm


def _key(m: Measurement) -> Decimal | str:
    """The value two readable annotations must share to count as the same."""
    if isinstance(m, MaterialAnnotation):
        return m.value or ""
    return _mm(m)


def _num(value: Decimal) -> str:
    """Plain decimal for display: no exponent, no trailing zeros, no negative zero."""
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def _reading_mm(m: Measurement) -> str:
    if isinstance(m, MaterialAnnotation):
        return m.value or ""
    return f"{_num(_mm(m))} mm"


def _reading(m: Measurement) -> str:
    """A value as read: in mm, plus the written form when it was converted."""
    text = _reading_mm(m)
    if isinstance(m, DimensionMeasurement) and m.unit is not LengthUnit.MM and m.value is not None:
        assert m.unit is not None
        text += f" (written {_num(m.value)} {m.unit.value})"
    return text


def _groups(readable: Sequence[Measurement]) -> list[list[Measurement]]:
    """Readable measurements grouped by value, groups in ascending value order."""
    by_key: dict[Decimal | str, list[Measurement]] = {}
    for m in readable:
        by_key.setdefault(_key(m), []).append(m)
    return [by_key[k] for k in sorted(by_key, key=lambda k: (isinstance(k, str), k))]


def _ids(ms: Sequence[Measurement]) -> str:
    parts = []
    for m in ms[:_IDS_SHOWN]:
        written = ""
        if (
            isinstance(m, DimensionMeasurement)
            and m.unit is not LengthUnit.MM
            and m.value is not None
        ):
            assert m.unit is not None
            written = f" as {_num(m.value)} {m.unit.value}"
        parts.append(m.id + written)
    more = f" and {len(ms) - _IDS_SHOWN} more" if len(ms) > _IDS_SHOWN else ""
    return ", ".join(parts) + more


def _converted_note(ms: Sequence[Measurement]) -> str:
    """Name the annotations whose equal value was written in another unit."""
    converted = [
        m for m in ms if isinstance(m, DimensionMeasurement) and m.unit is not LengthUnit.MM
    ]
    if not converted:
        return ""
    return f" ({_ids(converted)})"


def _more(groups: Sequence[object]) -> str:
    hidden = len(groups) - _GROUPS_SHOWN
    return f" and {hidden} more" if hidden > 0 else ""


def _plural(word: str, count: int) -> str:
    return word if count == 1 else word + "s"


def _fit(text: str) -> str:
    """Last-resort guard: an explanation must never be the reason a report fails."""
    return text if len(text) <= _MAX_TEXT else text[: _MAX_TEXT - 3] + "..."
