"""Numeric measurements and textual material annotations."""

import json
from decimal import Decimal

import pytest
from pydantic import TypeAdapter, ValidationError

from blueprintiq.domain.models import (
    DimensionMeasurement,
    DimensionType,
    ExtractionStatus,
    MaterialAnnotation,
    Measurement,
    UnrecognizedAnnotation,
)
from blueprintiq.domain.units import LengthUnit
from tests.factories import (
    ambiguous_dimension,
    evidence,
    parsed_dimension,
    parsed_material,
)

MEASUREMENT_ADAPTER: TypeAdapter[Measurement] = TypeAdapter(Measurement)


class TestParsedDimension:
    def test_valid_parsed_dimension(self) -> None:
        m = parsed_dimension()
        assert m.status is ExtractionStatus.PARSED
        assert m.normalized_value_mm == Decimal("4")
        assert m.issues == ()

    def test_unit_conversion_is_consistent(self) -> None:
        m = parsed_dimension(
            value=Decimal("0.5"), unit=LengthUnit.CM, normalized_value_mm=Decimal("5")
        )
        assert m.normalized_value_mm == Decimal("5")

    def test_inconsistent_normalized_value_is_rejected(self) -> None:
        with pytest.raises(ValidationError, match="normalized_value_mm"):
            parsed_dimension(
                value=Decimal("0.5"), unit=LengthUnit.CM, normalized_value_mm=Decimal("50")
            )

    @pytest.mark.parametrize("missing", ["value", "unit", "normalized_value_mm"])
    def test_parsed_requires_value_unit_and_normalized_value(self, missing: str) -> None:
        with pytest.raises(ValidationError, match="parsed"):
            parsed_dimension(**{missing: None})

    def test_parsed_must_not_carry_issues(self) -> None:
        with pytest.raises(ValidationError, match="issues"):
            parsed_dimension(issues=("missing_unit",))

    def test_zero_is_a_legitimate_parsed_value(self) -> None:
        m = parsed_dimension(value=Decimal("0"), normalized_value_mm=Decimal("0"))
        assert m.value == 0

    def test_values_are_stored_with_their_written_precision(self) -> None:
        m = parsed_dimension(value="4.50", normalized_value_mm="4.50")
        assert str(m.value) == "4.50"


class TestDecimalDiscipline:
    @pytest.mark.parametrize("field", ["value", "normalized_value_mm"])
    def test_python_float_is_rejected(self, field: str) -> None:
        with pytest.raises(ValidationError, match="float"):
            parsed_dimension(**{field: 4.5})

    def test_json_number_is_rejected_to_avoid_float_round_trip(self) -> None:
        payload = json.loads(parsed_dimension().model_dump_json())
        payload["value"] = 4.5  # a JSON number, not a string
        with pytest.raises(ValidationError, match="float"):
            DimensionMeasurement.model_validate(payload)

    @pytest.mark.parametrize("raw", ["4", 4, Decimal("4")])
    def test_decimal_int_and_numeric_string_are_accepted(self, raw: object) -> None:
        m = parsed_dimension(value=raw, normalized_value_mm=raw)
        assert m.value == Decimal("4")
        assert isinstance(m.value, Decimal)

    def test_bool_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            parsed_dimension(value=True, normalized_value_mm=True)

    @pytest.mark.parametrize("bad", ["NaN", "Infinity", "-Infinity", "abc"])
    def test_non_finite_and_garbage_are_rejected(self, bad: str) -> None:
        with pytest.raises(ValidationError):
            parsed_dimension(value=bad, normalized_value_mm=bad)

    def test_negative_values_are_rejected(self) -> None:
        with pytest.raises(ValidationError):
            parsed_dimension(value="-4", normalized_value_mm="-4")

    def test_absurdly_long_numbers_are_rejected(self) -> None:
        digits = "1" * 31
        with pytest.raises(ValidationError):
            parsed_dimension(value=digits, normalized_value_mm=digits)

    def test_json_serializes_decimals_as_exact_strings(self) -> None:
        m = parsed_dimension(value="0.12", unit=LengthUnit.M, normalized_value_mm="120.00")
        payload = json.loads(m.model_dump_json())
        assert payload["value"] == "0.12"
        assert payload["normalized_value_mm"] == "120.00"

    def test_json_round_trip_preserves_values_exactly(self) -> None:
        m = parsed_dimension(value="0.07", unit=LengthUnit.CM, normalized_value_mm="0.70")
        assert DimensionMeasurement.model_validate_json(m.model_dump_json()) == m


class TestAmbiguousDimension:
    def test_valid_ambiguous_dimension(self) -> None:
        m = ambiguous_dimension()
        assert m.status is ExtractionStatus.AMBIGUOUS
        assert m.normalized_value_mm is None

    def test_ambiguous_requires_at_least_one_issue(self) -> None:
        with pytest.raises(ValidationError, match="issue"):
            ambiguous_dimension(issues=())

    def test_ambiguous_must_not_expose_a_normalized_value(self) -> None:
        with pytest.raises(ValidationError, match="normalized_value_mm"):
            ambiguous_dimension(normalized_value_mm=Decimal("20"))

    def test_ambiguous_may_have_no_value_at_all(self) -> None:
        m = ambiguous_dimension(value=None, issues=("missing_value",))
        assert m.value is None

    def test_unknown_issue_code_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            ambiguous_dimension(issues=("looks_odd",))

    def test_unsupported_unit_text_cannot_masquerade_as_a_unit(self) -> None:
        with pytest.raises(ValidationError):
            ambiguous_dimension(unit="ft")


class TestMeasurementCommon:
    @pytest.mark.parametrize("bad_id", ["", "m1", "M", "M-1", "F1", "M1 "])
    def test_measurement_id_format(self, bad_id: str) -> None:
        with pytest.raises(ValidationError):
            parsed_dimension(id=bad_id)

    def test_unknown_dimension_type_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            parsed_dimension(dimension_type="hardness")

    def test_measurements_are_immutable(self) -> None:
        with pytest.raises(ValidationError):
            parsed_dimension().value = Decimal("5")  # type: ignore[misc]

    def test_unknown_fields_are_rejected(self) -> None:
        with pytest.raises(ValidationError):
            parsed_dimension(colour="red")


class TestMaterialAnnotation:
    def test_valid_material(self) -> None:
        m = parsed_material()
        assert m.value == "SS400"
        assert m.kind == "material"

    def test_value_is_trimmed_and_upper_cased_but_raw_text_is_kept(self) -> None:
        m = parsed_material(value="  ss400 ", source=evidence("MATERIAL:  ss400 "))
        assert m.value == "SS400"
        assert m.source.raw_text == "MATERIAL:  ss400 "

    def test_parsed_material_requires_a_value(self) -> None:
        with pytest.raises(ValidationError, match="parsed"):
            parsed_material(value=None)

    @pytest.mark.parametrize("blank", ["", "   "])
    def test_blank_material_is_treated_as_missing_value(self, blank: str) -> None:
        with pytest.raises(ValidationError, match="parsed"):
            parsed_material(value=blank)

    def test_ambiguous_material_needs_issue_and_has_no_value(self) -> None:
        m = parsed_material(
            value=None, status=ExtractionStatus.AMBIGUOUS, issues=("missing_value",)
        )
        assert m.value is None
        with pytest.raises(ValidationError, match="issue"):
            parsed_material(value=None, status=ExtractionStatus.AMBIGUOUS)

    def test_ambiguous_material_must_not_expose_a_value(self) -> None:
        with pytest.raises(ValidationError, match="value"):
            parsed_material(status=ExtractionStatus.AMBIGUOUS, issues=("unsupported_syntax",))

    def test_parsed_material_must_not_carry_issues(self) -> None:
        with pytest.raises(ValidationError, match="issues"):
            parsed_material(issues=("missing_value",))

    def test_overlong_material_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            parsed_material(value="X" * 65)

    @pytest.mark.parametrize("forbidden", ["unit", "normalized_value_mm", "dimension_type"])
    def test_material_has_no_numeric_or_unit_fields(self, forbidden: str) -> None:
        with pytest.raises(ValidationError):
            parsed_material(**{forbidden: "mm"})

    def test_json_round_trip(self) -> None:
        m = parsed_material()
        assert MaterialAnnotation.model_validate_json(m.model_dump_json()) == m


class TestMeasurementUnion:
    def test_discriminator_selects_dimension(self) -> None:
        payload = parsed_dimension().model_dump(mode="json")
        assert isinstance(MEASUREMENT_ADAPTER.validate_python(payload), DimensionMeasurement)

    def test_discriminator_selects_material(self) -> None:
        payload = parsed_material().model_dump(mode="json")
        assert isinstance(MEASUREMENT_ADAPTER.validate_python(payload), MaterialAnnotation)

    def test_material_payload_cannot_be_read_as_a_dimension(self) -> None:
        payload = parsed_material().model_dump(mode="json") | {"kind": "dimension"}
        with pytest.raises(ValidationError):
            MEASUREMENT_ADAPTER.validate_python(payload)

    def test_dimension_type_enum_has_no_material(self) -> None:
        assert "material" not in {t.value for t in DimensionType}


class TestUnrecognizedAnnotation:
    def test_keeps_label_and_evidence(self) -> None:
        u = UnrecognizedAnnotation(label="HARDNESS", source=evidence("HARDNESS: 200 HB"))
        assert u.label == "HARDNESS"
        assert u.source.raw_text == "HARDNESS: 200 HB"

    def test_blank_label_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            UnrecognizedAnnotation(label=" ", source=evidence())
