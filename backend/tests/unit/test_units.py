"""Unit conversion: exact Decimal arithmetic, canonical normalization to mm."""

from decimal import Decimal

import pytest

from blueprintiq.domain.units import (
    LengthUnit,
    UnitConversionError,
    UnsupportedUnitError,
    parse_unit,
    to_mm,
)


@pytest.mark.parametrize(
    ("value", "unit", "expected_mm"),
    [
        ("4", LengthUnit.MM, "4"),
        ("0.5", LengthUnit.CM, "5"),
        ("0.12", LengthUnit.M, "120"),
        ("2", LengthUnit.IN, "50.8"),
        ("0.1", LengthUnit.IN, "2.54"),
        ("0.3", LengthUnit.CM, "3"),
        ("0", LengthUnit.IN, "0"),
        ("1", LengthUnit.IN, "25.4"),
    ],
)
def test_to_mm_is_exact(value: str, unit: LengthUnit, expected_mm: str) -> None:
    result = to_mm(Decimal(value), unit)
    assert isinstance(result, Decimal)
    assert result == Decimal(expected_mm)


def test_to_mm_does_not_suffer_binary_float_error() -> None:
    # Demonstrate the problem Decimal avoids: these float results are inexact.
    assert float("0.07") * 10 == 0.7000000000000001
    assert float("0.12") * 25.4 == 3.0479999999999996
    # The Decimal conversions are exact.
    assert to_mm(Decimal("0.07"), LengthUnit.CM) == Decimal("0.7")
    assert to_mm(Decimal("0.12"), LengthUnit.IN) == Decimal("3.048")


def test_to_mm_preserves_boundary_value_exactly() -> None:
    # A threshold of 50 mm must compare equal to 50 mm expressed in other units.
    assert to_mm(Decimal("5"), LengthUnit.CM) == Decimal("50")
    assert to_mm(Decimal("0.05"), LengthUnit.M) == Decimal("50")
    assert to_mm(Decimal("50.01"), LengthUnit.MM) > Decimal("50")


def test_to_mm_rejects_float_input() -> None:
    with pytest.raises(TypeError, match="Decimal"):
        to_mm(0.5, LengthUnit.CM)  # type: ignore[arg-type]


@pytest.mark.parametrize("bad", [Decimal("NaN"), Decimal("Infinity"), Decimal("-Infinity")])
def test_to_mm_rejects_non_finite(bad: Decimal) -> None:
    with pytest.raises(UnitConversionError, match="finite"):
        to_mm(bad, LengthUnit.MM)


def test_to_mm_raises_instead_of_rounding_silently() -> None:
    too_many_digits = Decimal("1." + "1" * 80)
    with pytest.raises(UnitConversionError, match="exact"):
        to_mm(too_many_digits, LengthUnit.IN)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("mm", LengthUnit.MM),
        ("MM", LengthUnit.MM),
        (" cm ", LengthUnit.CM),
        ("M", LengthUnit.M),
        ("in", LengthUnit.IN),
        ("IN", LengthUnit.IN),
    ],
)
def test_parse_unit_accepts_supported_units(text: str, expected: LengthUnit) -> None:
    assert parse_unit(text) is expected


@pytest.mark.parametrize("text", ["", " ", "ft", "yd", "mil", "inch", "millimetre", '"', "μm"])
def test_parse_unit_rejects_unsupported_units(text: str) -> None:
    with pytest.raises(UnsupportedUnitError):
        parse_unit(text)
