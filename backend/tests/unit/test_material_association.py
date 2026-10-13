"""The association rule on explicit boxes (points), including cases the text layer will
not produce from a generated PDF. Coordinates follow a measured bilingual title block."""

from blueprintiq.domain.models import (
    BBox,
    ExtractionMethod,
    MaterialAnnotation,
    PageInfo,
    TextLine,
)
from blueprintiq.extraction.annotation_parser import parse_lines
from blueprintiq.extraction.material_association import associate_materials

PAGE = PageInfo(
    page_number=1, width_pt=595, height_pt=842, rotation=0,
    pdf_crop_box=(0, 0, 595, 842),
)  # fmt: skip


def line(text: str, x0: float, y0: float, x1: float, y1: float) -> TextLine:
    return TextLine(text=text, page_number=1, bbox=BBox(x0=x0, y0=y0, x1=x1, y1=y1))


FR = line("Matière :", 276.6, 614.9, 301.8, 623.1)
FR_VALUE = line("POM C noir", 311.7, 611.1, 365.7, 624.8)
EN = line("Matérial :", 276.6, 621.8, 303.0, 630.0)
EN_VALUE = line("black polyoxymethylene", 311.7, 619.3, 428.3, 632.9)


def run(*lines: TextLine) -> list[MaterialAnnotation]:
    parsed = parse_lines(lines, method=ExtractionMethod.PDF_TEXT_LAYER).measurements
    out = associate_materials(lines, parsed, [PAGE])
    return [m for m in out if isinstance(m, MaterialAnnotation)]


def pairs(ms: list[MaterialAnnotation]) -> dict[str, str | None]:
    return {m.label_source.raw_text if m.label_source else m.source.raw_text: m.value for m in ms}


def test_the_measured_bilingual_block_pairs_each_row_with_its_own_value() -> None:
    ms = run(FR, FR_VALUE, EN, EN_VALUE)
    assert pairs(ms) == {"Matière :": "POM C NOIR", "Matérial :": "BLACK POLYOXYMETHYLENE"}
    assert [m.id for m in ms] == ["M1", "M2"]  # ids keep the label's reading order


def test_overlapping_boxes_alone_never_pair_a_value_with_the_other_row() -> None:
    # The French label's box overlaps the English value's in height.
    assert FR.bbox is not None and EN_VALUE.bbox is not None
    assert FR.bbox.y1 > EN_VALUE.bbox.y0
    ms = run(FR, EN, EN_VALUE)
    assert pairs(ms) == {"Matière :": None, "Matérial :": "BLACK POLYOXYMETHYLENE"}


def test_a_value_two_labels_could_claim_belongs_to_neither() -> None:
    first = line("Material :", 276.6, 614.9, 301.8, 623.1)
    second = line("Matière :", 303.0, 615.4, 328.0, 623.6)
    value = line("POM", 330.0, 611.1, 350.0, 624.8)
    assert pairs(run(first, second, value)) == {"Material :": None, "Matière :": None}


def test_two_near_candidates_on_the_row_are_not_chosen_between() -> None:
    a = line("POM", 311.7, 611.1, 325.0, 624.8)
    b = line("C noir", 330.0, 611.1, 355.0, 624.8)
    assert pairs(run(FR, a, b)) == {"Matière :": None}


def test_a_value_left_of_the_label_is_not_used() -> None:
    left = line("POM C noir", 200.0, 611.1, 265.0, 624.8)
    assert pairs(run(FR, left)) == {"Matière :": None}


def test_the_label_only_result_is_kept_when_nothing_is_associated() -> None:
    (m,) = run(FR)
    assert (m.value, m.status.value, m.label_source) == (None, "ambiguous", None)
    assert [i.value for i in m.issues] == ["missing_value"]
