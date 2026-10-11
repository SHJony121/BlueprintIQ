"""Length units and exact conversion to the canonical unit (millimetres).

All arithmetic uses :class:`decimal.Decimal`. Binary floats are never used, so
``0.3 cm`` converts to exactly ``3 mm`` and boundary comparisons stay reliable.
"""

from decimal import Decimal, Inexact, localcontext
from enum import StrEnum
from types import MappingProxyType

_CONVERSION_PRECISION = 60


class LengthUnit(StrEnum):
    """Supported length units, as written on a drawing (lower case)."""

    MM = "mm"
    CM = "cm"
    M = "m"
    IN = "in"


# Exact conversion factors. 1 in = 25.4 mm by international definition.
MM_PER_UNIT = MappingProxyType(
    {
        LengthUnit.MM: Decimal(1),
        LengthUnit.CM: Decimal(10),
        LengthUnit.M: Decimal(1000),
        LengthUnit.IN: Decimal("25.4"),
    }
)


class UnitError(ValueError):
    """Base class for unit-related errors."""


class UnsupportedUnitError(UnitError):
    """The unit text is not one of the supported length units."""


class AmbiguousUnitCaseError(UnsupportedUnitError):
    """The text is a case variant of a supported unit that is not an accepted spelling."""


class UnitConversionError(UnitError):
    """The value cannot be converted exactly."""


# Strict spellings. Lower case, plus the all-caps forms common on drawings, except
# for metres: "M" is not accepted as "m", and mixed case ("Mm" is megametre in SI
# notation) is never guessed.
_ACCEPTED_SPELLINGS = MappingProxyType(
    {
        "mm": LengthUnit.MM,
        "MM": LengthUnit.MM,
        "cm": LengthUnit.CM,
        "CM": LengthUnit.CM,
        "m": LengthUnit.M,
        "in": LengthUnit.IN,
        "IN": LengthUnit.IN,
    }
)


def parse_unit(text: str) -> LengthUnit:
    """Parse unit text with strict spelling; surrounding whitespace is ignored.

    Raises:
        AmbiguousUnitCaseError: a case variant of a supported unit, e.g. ``M`` or ``Mm``.
        UnsupportedUnitError: anything else that is not an accepted spelling.
    """
    stripped = text.strip()
    unit = _ACCEPTED_SPELLINGS.get(stripped)
    if unit is not None:
        return unit
    accepted = ", ".join(_ACCEPTED_SPELLINGS)
    if stripped.lower() in {u.value for u in LengthUnit}:
        raise AmbiguousUnitCaseError(
            f"Unit {text!r} is an ambiguous spelling of {stripped.lower()!r}; "
            f"accepted spellings: {accepted}"
        )
    raise UnsupportedUnitError(f"Unsupported length unit {text!r}; accepted spellings: {accepted}")


def to_mm(value: Decimal, unit: LengthUnit) -> Decimal:
    """Convert ``value`` in ``unit`` to millimetres, exactly.

    Raises:
        TypeError: ``value`` is not a ``Decimal`` (floats are rejected on purpose).
        UnitConversionError: ``value`` is not finite, or the exact result would
            need more digits than the working precision (we never round silently).
    """
    if not isinstance(value, Decimal):
        raise TypeError(f"value must be a Decimal, got {type(value).__name__}")
    if not value.is_finite():
        raise UnitConversionError(f"value must be finite, got {value}")
    with localcontext() as ctx:
        ctx.prec = _CONVERSION_PRECISION
        ctx.traps[Inexact] = True
        try:
            return value * MM_PER_UNIT[unit]
        except Inexact:
            raise UnitConversionError(
                f"{value} {unit.value} cannot be converted to mm exactly"
            ) from None
