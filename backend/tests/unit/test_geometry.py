"""Page space vs viewer space: rotation mapping, checked by hand and against PyMuPDF."""

import itertools

import pymupdf
import pytest
from pydantic import ValidationError

from blueprintiq.domain.geometry import ViewerRect, page_to_viewer, viewer_size
from blueprintiq.domain.models import BBox, PageInfo
from tests.factories import page_info

W, H = 595.0, 842.0
BOX = BBox(x0=100, y0=200, x1=150, y1=210)


@pytest.mark.parametrize(
    ("rotation", "expected"),
    [
        # Hand-computed: /Rotate turns the page clockwise for display.
        (0, ViewerRect(left=100, top=200, right=150, bottom=210)),
        (90, ViewerRect(left=H - 210, top=100, right=H - 200, bottom=150)),
        (180, ViewerRect(left=W - 150, top=H - 210, right=W - 100, bottom=H - 200)),
        (270, ViewerRect(left=200, top=W - 150, right=210, bottom=W - 100)),
    ],
)
def test_page_to_viewer_hand_computed(rotation: int, expected: ViewerRect) -> None:
    page = page_info(width_pt=W, height_pt=H, rotation=rotation)
    assert page_to_viewer(BOX, page) == pytest.approx(expected)


@pytest.mark.parametrize(
    ("rotation", "size"), [(0, (W, H)), (90, (H, W)), (180, (W, H)), (270, (H, W))]
)
def test_viewer_size_swaps_for_quarter_turns(rotation: int, size: tuple[float, float]) -> None:
    assert viewer_size(page_info(width_pt=W, height_pt=H, rotation=rotation)) == size


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_page_to_viewer_agrees_with_pymupdf_rotation_matrix(rotation: int) -> None:
    # Cross-check of an independent formula; PyMuPDF is not used to produce it.
    doc = pymupdf.open()
    page = doc.new_page(width=W, height=H)
    page.set_rotation(rotation)
    info = page_info(width_pt=W, height_pt=H, rotation=rotation)
    for x0, y0 in itertools.product((0.0, 33.5, 400.0), (0.0, 77.25, 800.0)):
        box = BBox(x0=x0, y0=y0, x1=x0 + 20, y1=y0 + 10)
        expected = pymupdf.Rect(box.x0, box.y0, box.x1, box.y1) * page.rotation_matrix
        got = page_to_viewer(box, info)
        assert got == pytest.approx(ViewerRect(expected.x0, expected.y0, expected.x1, expected.y1))
    doc.close()


def test_viewer_rect_is_a_different_type_from_page_bbox() -> None:
    rect = page_to_viewer(BOX, page_info(rotation=90))
    assert isinstance(rect, ViewerRect)
    assert not isinstance(rect, BBox)


class TestPdfCropBox:
    def test_crop_box_must_match_page_size(self) -> None:
        with pytest.raises(ValidationError, match="pdf_crop_box"):
            PageInfo(
                page_number=1,
                width_pt=595,
                height_pt=842,
                rotation=0,
                pdf_crop_box=(0, 0, 600, 842),
            )

    def test_offset_crop_box_is_accepted(self) -> None:
        page = PageInfo(
            page_number=1, width_pt=595, height_pt=842, rotation=0, pdf_crop_box=(50, 40, 645, 882)
        )
        assert page.pdf_crop_box == (50, 40, 645, 882)

    def test_inverted_crop_box_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            PageInfo(
                page_number=1,
                width_pt=595,
                height_pt=842,
                rotation=0,
                pdf_crop_box=(645, 40, 50, 882),
            )
