"""The stacking rule on explicit boxes (points), where a generated PDF cannot place text."""

from blueprintiq.domain.models import (
    BBox,
    CadAnnotation,
    CadKind,
    CadUnit,
    ExtractionIssue,
    ExtractionMethod,
    ExtractionStatus,
    PageInfo,
    SourceEvidence,
    TextLine,
    UnitSource,
)
from blueprintiq.extraction.stacked_tolerance import reconstruct_stacked

PAGE = PageInfo(
    page_number=1, width_pt=595, height_pt=842, rotation=0, pdf_crop_box=(0, 0, 595, 842)
)


def box(x0: float, y0: float, x1: float, y1: float) -> BBox:
    return BBox(x0=x0, y0=y0, x1=x1, y1=y1)


def evidence(text: str, b: BBox) -> SourceEvidence:
    return SourceEvidence(
        page_number=1, bbox=b, raw_text=text, extraction_method=ExtractionMethod.PDF_TEXT_LAYER
    )


def value(cid: str, text: str, b: BBox) -> CadAnnotation:
    return CadAnnotation(
        id=cid, dimension_kind=CadKind.LINEAR, nominal=text, unit=CadUnit.MM,
        unit_source=UnitSource.DRAWING_NOTE, status=ExtractionStatus.PARSED,
        source=evidence(text, b),
    )  # fmt: skip


def fragment(cid: str, text: str, b: BBox) -> CadAnnotation:
    return CadAnnotation(
        id=cid, dimension_kind=None, nominal=None, status=ExtractionStatus.AMBIGUOUS,
        issues=(ExtractionIssue.UNSUPPORTED_SYNTAX,), source=evidence(text, b),
    )  # fmt: skip


def lines(*items: CadAnnotation) -> list[TextLine]:
    return [TextLine(text=a.source.raw_text, page_number=1, bbox=a.source.bbox) for a in items]


V1 = value("C1", "3.7", box(100, 290, 114, 304))
UP = fragment("C2", "+0", box(118, 288, 125, 297))
LOW = fragment("C3", "-0.2", box(118, 298, 128, 307))


def run(*items: CadAnnotation) -> tuple[CadAnnotation, ...]:
    return reconstruct_stacked(items, lines(*items), [PAGE])


def test_a_clean_stack_on_explicit_boxes_is_merged() -> None:
    (a,) = run(V1, UP, LOW)
    assert (str(a.upper_deviation), str(a.lower_deviation)) == ("0", "-0.2")
    assert [p.raw_text for p in a.tolerance_parts] == ["+0", "-0.2"]


def test_a_second_value_in_the_area_blocks_the_stack() -> None:
    other = value("C4", "5", box(131, 290, 138, 304))
    assert all(a.tolerance_parts == () for a in run(V1, UP, LOW, other))


def test_a_fragment_pair_that_fits_two_values_belongs_to_neither() -> None:
    twin = value("C4", "5", box(100.5, 290.2, 114.5, 304.2))  # same spot, same reach
    result = run(V1, twin, UP, LOW)
    assert all(a.tolerance_parts == () for a in result)
    assert len(result) == 4  # nothing consumed


def test_the_lower_line_must_be_below_the_value_centre_and_the_upper_above() -> None:
    both_above = fragment("C3", "-0.2", box(118, 280, 128, 288))
    assert all(a.tolerance_parts == () for a in run(V1, UP, both_above))


def test_a_fragment_on_another_page_is_ignored() -> None:
    elsewhere = LOW.model_copy(
        update={
            "source": evidence("-0.2", box(118, 298, 128, 307)).model_copy(
                update={"page_number": 2}
            )
        }
    )
    two = PageInfo(
        page_number=2, width_pt=595, height_pt=842, rotation=0, pdf_crop_box=(0, 0, 595, 842)
    )
    result = reconstruct_stacked((V1, UP, elsewhere), lines(V1, UP), [PAGE, two])
    assert all(a.tolerance_parts == () for a in result)
