"""Per-request inspection requirements.

The frontend can send, in one request header, the handful of limits an engineer wants
checked instead of the demonstration ones. This module is the only door for them: it
accepts a small, fixed JSON shape (never TOML or rules), validates every value, and builds
a ``Ruleset`` of the existing rule types, which the unchanged deterministic engine then
evaluates. Nothing is stored; the ruleset exists for one request.

Shape (version 1; every limit optional, ``null`` or absent means "not checked")::

    {"version": 1,
     "min_thickness_mm": "3", "max_diameter_mm": "50",
     "min_length_mm": "10", "max_length_mm": "500",
     "material": {"required": true, "code": "SS400"}}      # or "material": null

Thresholds are decimal strings in millimetres (no exponent, no sign, at most 12 whole
digits and 6 decimals), so exact ``Decimal`` handling is preserved end to end. Problems are
reported with fixed wording per field, never echoing the submitted text.
"""

import json
import re
from decimal import Decimal
from typing import Any
from urllib.parse import unquote

from blueprintiq.rules.config import Ruleset

MAX_HEADER_CHARS = 2048
_DECIMAL = re.compile(r"^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$")
_CODE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,31}$")
_LIMITS = {
    "min_thickness_mm": (
        "THK-MIN-001",
        "thickness",
        "min_mm",
        "Plate thickness must be at least {} mm (your requirement).",
    ),
    "max_diameter_mm": (
        "DIA-MAX-001",
        "diameter",
        "max_mm",
        "Hole diameter must not exceed {} mm (your requirement).",
    ),
}
_KEYS = {
    "version",
    "min_thickness_mm",
    "max_diameter_mm",
    "min_length_mm",
    "max_length_mm",
    "material",
}


class RequirementsError(ValueError):
    """The requirements are unusable. ``problems`` are safe to show to the user."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = tuple(problems)
        super().__init__("; ".join(problems))


def parse_requirements(header: str) -> Ruleset:
    """Validate a percent-encoded JSON header value and build the ruleset it describes."""
    if len(header) > MAX_HEADER_CHARS:
        raise RequirementsError(["The requirements are too long."])
    try:
        data = json.loads(unquote(header, errors="replace"))
    except (ValueError, RecursionError):
        raise RequirementsError(["The requirements are not valid JSON."]) from None
    if not isinstance(data, dict):
        raise RequirementsError(["The requirements must be a JSON object."])

    problems: list[str] = []
    if set(data) - _KEYS:
        problems.append("The requirements contain a field that is not recognised.")
    if data.get("version") != 1:
        problems.append("version must be 1.")

    def threshold(key: str) -> Decimal | None:
        value = data.get(key)
        if value is None:
            return None
        if not isinstance(value, str) or _DECIMAL.fullmatch(value) is None:
            problems.append(
                f"{key} must be a number written as text, 0 or more, with at most 6 decimals."
            )
            return None
        return Decimal(value)

    min_thk = threshold("min_thickness_mm")
    max_dia = threshold("max_diameter_mm")
    min_len = threshold("min_length_mm")
    max_len = threshold("max_length_mm")
    if min_len is not None and max_len is not None and min_len > max_len:
        problems.append("min_length_mm is greater than max_length_mm.")

    material_rule: dict[str, Any] | None = None
    material = data.get("material")
    if material is not None:
        if not isinstance(material, dict) or set(material) - {"required", "code"}:
            problems.append("material must be an object with required and code.")
        elif material.get("required") is not True:
            problems.append("material.required must be true when material is given.")
        else:
            code = material.get("code")
            if code is not None and (
                not isinstance(code, str) or _CODE.fullmatch(code.strip()) is None
            ):
                problems.append(
                    "material.code must be 1 to 32 letters, digits or . _ / - characters."
                )
            else:
                code_text = None if code is None else code.strip().upper()
                material_rule = {
                    "kind": "required",
                    "id": "MAT-REQ-001",
                    "applies_to": "material",
                    "severity": "error",
                    "description": _material_text(code_text),
                }
                if code_text is not None:
                    material_rule["equals"] = code_text

    rules: list[dict[str, Any]] = []
    for key, value in (("min_thickness_mm", min_thk), ("max_diameter_mm", max_dia)):
        if value is not None:
            rule_id, applies_to, bound, text = _LIMITS[key]
            rules.append(
                {
                    "kind": "range",
                    "id": rule_id,
                    "applies_to": applies_to,
                    bound: value,
                    "severity": "error",
                    "description": text.format(_plain(value)),
                }
            )
    if min_len is not None or max_len is not None:
        length: dict[str, Any] = {
            "kind": "range",
            "id": "LEN-RANGE-001",
            "applies_to": "length",
            "severity": "warning",
        }
        if min_len is not None:
            length["min_mm"] = min_len
        if max_len is not None:
            length["max_mm"] = max_len
        length["description"] = _length_text(min_len, max_len)
        rules.append(length)
    if material_rule is not None:
        rules.append(material_rule)
    if not rules and not problems:
        problems.append("At least one requirement is needed.")
    if problems:
        raise RequirementsError(problems)

    return Ruleset.model_validate(
        {
            "ruleset": {
                "id": "custom-requirements",
                "version": "1",
                "description": "Requirements supplied with this inspection request.",
            },
            "rules": rules,
        }
    )


def _plain(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _length_text(low: Decimal | None, high: Decimal | None) -> str:
    if low is not None and high is not None:
        both = f"between {_plain(low)} mm and {_plain(high)} mm"
        return f"Overall length must be {both} (your requirement)."
    if low is not None:
        return f"Overall length must be at least {_plain(low)} mm (your requirement)."
    assert high is not None
    return f"Overall length must not exceed {_plain(high)} mm (your requirement)."


def _material_text(code: str | None) -> str:
    if code is None:
        return "A material specification must be present (your requirement)."
    return f"The material must be {code} (your requirement)."
