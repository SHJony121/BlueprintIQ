"""Evidence geometry: bounding boxes, page info, and source evidence."""

import pytest
from pydantic import ValidationError

from blueprintiq.domain.models import BBox, ExtractionMethod, PageInfo, SourceEvidence
from tests.factories import bbox, evidence, page_info


class TestBBox:
    def test_valid_box_exposes_size(self) -> None:
        box = bbox()
        assert box.width == pytest.approx(108.0)
        assert box.height == pytest.approx(12.0)

    def test_zero_area_box_is_allowed(self) -> None:
        assert BBox(x0=10, y0=10, x1=10, y1=10).width == 0

    @pytest.mark.parametrize(
        "overrides",
        [{"x0": 200.0}, {"y0": 200.0}],  # x0 > x1, y0 > y1
    )
    def test_inverted_box_is_rejected(self, overrides: dict[str, float]) -> None:
        with pytest.raises(ValidationError, match="x0 <= x1 and y0 <= y1"):
            bbox(**overrides)

    @pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
    def test_non_finite_coordinates_are_rejected(self, bad: float) -> None:
        with pytest.raises(ValidationError):
            bbox(x0=bad)

    def test_box_is_immutable(self) -> None:
        with pytest.raises(ValidationError):
            bbox().x0 = 0.0  # type: ignore[misc]

    def test_unknown_fields_are_rejected(self) -> None:
        with pytest.raises(ValidationError):
            BBox(x0=0, y0=0, x1=1, y1=1, z=3)  # type: ignore[call-arg]


class TestPageInfo:
    def test_valid_page(self) -> None:
        page = page_info()
        assert (page.width_pt, page.height_pt, page.rotation) == (595.0, 842.0, 0)

    @pytest.mark.parametrize("field", ["width_pt", "height_pt"])
    @pytest.mark.parametrize("bad", [0.0, -1.0, float("nan"), float("inf")])
    def test_page_size_must_be_positive_and_finite(self, field: str, bad: float) -> None:
        with pytest.raises(ValidationError):
            page_info(**{field: bad})

    @pytest.mark.parametrize("rotation", [0, 90, 180, 270])
    def test_allowed_rotations(self, rotation: int) -> None:
        assert page_info(rotation=rotation).rotation == rotation

    @pytest.mark.parametrize("rotation", [45, 360, -90])
    def test_other_rotations_are_rejected(self, rotation: int) -> None:
        with pytest.raises(ValidationError):
            page_info(rotation=rotation)

    def test_page_number_is_one_based(self) -> None:
        with pytest.raises(ValidationError):
            PageInfo(page_number=0, width_pt=1, height_pt=1, rotation=0)


class TestSourceEvidence:
    def test_valid_evidence_has_coordinates(self) -> None:
        ev = evidence()
        assert ev.has_coordinates
        assert ev.extraction_method is ExtractionMethod.PDF_TEXT_LAYER

    def test_missing_coordinates_are_explicit_not_zeroed(self) -> None:
        ev = evidence(bbox=None)
        assert ev.bbox is None
        assert not ev.has_coordinates

    def test_bbox_defaults_to_none_rather_than_a_fake_box(self) -> None:
        ev = SourceEvidence(
            page_number=1,
            raw_text="THICKNESS: 4 mm",
            extraction_method=ExtractionMethod.PDF_TEXT_LAYER,
        )
        assert ev.bbox is None

    def test_page_number_must_be_at_least_one(self) -> None:
        with pytest.raises(ValidationError):
            evidence(page_number=0)

    @pytest.mark.parametrize("raw", ["", "   ", "\n\t"])
    def test_blank_raw_text_is_rejected(self, raw: str) -> None:
        with pytest.raises(ValidationError, match="blank"):
            evidence(raw_text=raw)

    def test_raw_text_is_preserved_verbatim(self) -> None:
        assert evidence(raw_text="  thickness:4MM ").raw_text == "  thickness:4MM "

    def test_unknown_extraction_method_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            evidence(extraction_method="magic")

    def test_json_round_trip(self) -> None:
        ev = evidence()
        assert SourceEvidence.model_validate_json(ev.model_dump_json()) == ev
